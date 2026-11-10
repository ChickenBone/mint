import logging
import threading
from contextlib import asynccontextmanager
from typing import Annotated, Literal

import httpx
import psycopg
from fastapi import FastAPI, HTTPException, Path, Query
from fastapi.responses import JSONResponse
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from catalog.config import Settings
from catalog.indexer import VECTOR_ERRORS
from catalog.model import fuse
from catalog.identity import artist_groups
from catalog.providers import EntitySource
from catalog.reconcile import ReconciliationBodyLimit
from catalog.store import Store
from catalog.vectors import Embeddings, Vectors


log = logging.getLogger(__name__)
FIELDS = """key,source,origin,country,kind,provider_id,title,artist,album,genres,url,
            popularity,observed_at,updated_at,revision,indexed_revision"""


def create_app(
    settings: Settings | None = None,
    store: Store | None = None,
    vectors: Vectors | None = None,
    embeddings: Embeddings | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        config = settings or Settings.load()
        app.state.store = store or Store(config)
        app.state.vectors = vectors or Vectors(config)
        app.state.embeddings = embeddings or Embeddings(config.model_cache)
        app.state.vectors.check()
        yield
        if store is None:
            app.state.store.close()
        if vectors is None:
            app.state.vectors.close()

    app = FastAPI(
        title="Standalone music catalog",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )
    app.state.log = log
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=4)
    app.add_middleware(ReconciliationBodyLimit)
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=["localhost", "127.0.0.1", "testserver"],
    )

    @app.exception_handler(psycopg.Error)
    async def database_error(request, error):
        log.error("catalog_database_failure code=%s", type(error).__name__)
        return JSONResponse(
            {"detail": "Catalog database unavailable; retry shortly"},
            status_code=503,
        )

    capacity = threading.BoundedSemaphore(8)

    @app.middleware("http")
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; img-src 'self' data:; object-src 'none'; "
            "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        )
        return response

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @app.get("/readyz")
    def ready():
        try:
            with app.state.store.transaction() as conn:
                conn.execute("SET LOCAL statement_timeout='2000ms'")
                conn.execute("SELECT version FROM catalog_schema").fetchone()
            app.state.vectors.check()
        except (psycopg.Error, *VECTOR_ERRORS, httpx.HTTPError):
            log.exception("search_not_ready")
            return JSONResponse({"status": "unavailable"}, status_code=503)
        return {"status": "ready"}

    @app.get("/v1/search")
    def search(
        q: Annotated[str, Query(min_length=1, max_length=256)],
        kind: Literal["artist", "album", "song"] | None = None,
        source: EntitySource | None = None,
        country: Annotated[str | None, Query(pattern="^(?:[a-z]{2}|global)$")] = None,
        limit: Annotated[int, Query(ge=1, le=50)] = 20,
        mode: Literal["hybrid", "lexical"] = "hybrid",
        group_artists: bool = True,
    ):
        query = " ".join(q.split())
        if not query:
            raise HTTPException(422, "Query must contain non-whitespace characters")
        if not capacity.acquire(blocking=False):
            raise HTTPException(503, "Search capacity reached", headers={"Retry-After": "1"})
        try:
            filters = {
                name: value
                for name, value in (("kind", kind), ("source", source), ("country", country))
                if value is not None
            }
            candidates = min(200, max(50, limit * 4))
            semantic = []
            if mode == "hybrid":
                semantic = app.state.vectors.search(
                    app.state.embeddings.query(query), filters, candidates
                )
            with app.state.store.transaction() as conn:
                conn.execute("SET LOCAL statement_timeout='2000ms'")
                lexical = conn.execute(
                    """SELECT key FROM entities,websearch_to_tsquery('simple',%s) query
                       WHERE search@@query AND (%s::text IS NULL OR kind=%s)
                       AND (%s::text IS NULL OR source=%s)
                       AND (%s::text IS NULL OR country=%s)
                       ORDER BY ts_rank_cd(search,query) DESC, popularity DESC,key LIMIT %s""",
                    (query, kind, kind, source, source, country, country, candidates),
                ).fetchall()
                keys = [row["key"] for row in lexical] + [point["key"] for point in semantic]
                rows = conn.execute(
                    f"SELECT {FIELDS} FROM entities WHERE key=ANY(%s)", (keys,)
                ).fetchall()
                groups = artist_groups(conn, keys)
            metadata = {row["key"]: row for row in rows}
            valid_semantic = [
                point["key"]
                for point in semantic
                if point["key"] in metadata
                and (
                    point["revision"]
                    == metadata[point["key"]]["revision"]
                    == metadata[point["key"]]["indexed_revision"]
                )
            ]
            ranking = fuse([row["key"] for row in lexical], valid_semantic, candidates * 2)
            results = []
            seen = set()
            for key, score in ranking:
                group = groups.get(key, {})
                identity = group.get("canonical_id", key) if group_artists else key
                if identity in seen:
                    continue
                seen.add(identity)
                results.append({**metadata[key], **group, "score": round(score, 6)})
            return {
                "query": query,
                "mode": mode,
                "group_artists": group_artists,
                "results": results[:limit],
                "has_more": len(results) > limit,
            }
        except (psycopg.Error, *VECTOR_ERRORS) as error:
            log.exception("search_failed code=%s", type(error).__name__)
            raise HTTPException(
                503,
                "Catalog search dependency unavailable; lexical mode can be requested explicitly",
                headers={"Retry-After": "5"},
            ) from error
        finally:
            capacity.release()

    @app.get("/v1/entities/{key}")
    def entity(key: Annotated[str, Path(max_length=150)]):
        try:
            with app.state.store.transaction() as conn:
                row = conn.execute(f"SELECT {FIELDS} FROM entities WHERE key=%s", (key,)).fetchone()
                if row is None:
                    raise HTTPException(404, "Entity not found")
                edges = conn.execute(
                    """SELECT source,target,relation FROM edges WHERE source=%s OR target=%s
                       ORDER BY source,target LIMIT 101""",
                    (key, key),
                ).fetchall()
                signals = conn.execute(
                    """SELECT chart,rank,signal_kind,raw_value,observed_at FROM chart_signals
                       WHERE key=%s ORDER BY chart LIMIT 100""",
                    (key,),
                ).fetchall()
                links = conn.execute(
                    """SELECT provider,kind,identifier,url,canonical_status FROM entity_links
                       WHERE key=%s ORDER BY provider,kind,identifier LIMIT 100""",
                    (key,),
                ).fetchall()
                annotations = conn.execute(
                    "SELECT metadata FROM entity_annotations WHERE key=%s",
                    (key,),
                ).fetchone()
                group = artist_groups(conn, [key]).get(key, {})
            return {
                "entity": row,
                **group,
                "edges": edges[:100],
                "edges_truncated": len(edges) > 100,
                "signals": signals,
                "links": links,
                "annotations": annotations["metadata"] if annotations else {},
            }
        except psycopg.Error as error:
            log.exception("entity_lookup_failed")
            raise HTTPException(503, "Metadata database unavailable") from error

    from catalog.console import router

    app.include_router(router(app))
    from catalog.browser import router as browser_router

    app.include_router(browser_router(app))
    from catalog.reconcile import router as reconciliation_router

    app.include_router(reconciliation_router(app))
    from catalog.embedding_map import router as embedding_map_router

    app.include_router(embedding_map_router(app))
    return app


def app_factory():
    return create_app()
