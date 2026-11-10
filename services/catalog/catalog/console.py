import asyncio
import secrets
import threading
import time
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

import psycopg
from fastapi import APIRouter, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from psycopg import sql

from catalog.model import entity_key
from catalog.providers import Source, EntitySource, SOURCES, KINDS, RESEARCH, lookup_task


STATIC = Path(__file__).with_name("static")


class Seed(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: EntitySource
    kind: Literal["artist", "album", "song"]
    identifier: str = Field(min_length=1, max_length=128)
    country: str = Field(default="global", pattern="^(?:[a-z]{2}|global)$")


class Pause(BaseModel):
    model_config = ConfigDict(extra="forbid")
    paused: bool


class Retry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    queue: Literal["jobs", "vector_outbox"]
    key: str = Field(min_length=1, max_length=300)


def snapshot(store):
    with store.transaction() as conn:
        conn.execute("SET LOCAL statement_timeout='2000ms'")
        counts = conn.execute("SELECT * FROM source_metrics ORDER BY source").fetchall()
        controls = conn.execute("SELECT * FROM source_controls ORDER BY source").fetchall()
        source_queues = conn.execute(
            """SELECT j.source,
               count(*) FILTER(WHERE NOT dead AND due_at<=now() AND lease_until<=now()) AS due,
               count(*) FILTER(WHERE NOT dead AND lease_until>now()) AS active,
               count(*) FILTER(WHERE NOT dead AND due_at<=now() AND lease_until<=now()
                 AND coalesce(b.next_at,'-infinity')<=now()) AS host_ready,
               max(CASE WHEN b.next_at='infinity' THEN 86400
                   WHEN b.next_at>now() THEN extract(epoch FROM b.next_at-now()) ELSE 0 END) AS wait_seconds
               FROM jobs j LEFT JOIN host_budgets b ON b.host=j.host GROUP BY j.source"""
        ).fetchall()
        recent = conn.execute(
            """SELECT coalesce(sum(amount) FILTER(WHERE action='crawled'),0) AS discovered,
               coalesce(sum(amount) FILTER(WHERE action='indexed'),0) AS indexed,
               max(occurred_at) FILTER(WHERE action='crawled') AS last_crawl
               FROM activity WHERE occurred_at>now()-interval '5 minutes'"""
        ).fetchone()
        workers = conn.execute(
            """SELECT role,state,job_key,seen_at,
               seen_at>now()-interval '120 seconds' AND state<>'stopped' AS alive
               FROM workers ORDER BY alive DESC,seen_at DESC LIMIT 100"""
        ).fetchall()
        queues = {}
        for table in ("jobs", "vector_outbox"):
            queues[table] = conn.execute(
                sql.SQL(
                    """SELECT count(*) AS total,
                       count(*) FILTER(WHERE dead) AS dead,
                       count(*) FILTER(WHERE NOT dead AND due_at<=now() AND lease_until<=now()) AS due,
                       count(*) FILTER(WHERE NOT dead AND lease_until>now()) AS leased,
                       count(*) FILTER(WHERE NOT dead AND due_at>now()) AS scheduled
                       FROM {}"""
                ).format(sql.Identifier(table))
            ).fetchone()
        jobs = conn.execute(
            """SELECT key,source,task,priority,attempts,dead,last_error,due_at,
               CASE WHEN dead THEN 'failed' WHEN lease_until>now() THEN 'active'
               WHEN due_at>now() THEN 'scheduled' ELSE 'ready' END AS state
               FROM jobs WHERE NOT dead AND ready ORDER BY priority DESC,due_at LIMIT 12"""
        ).fetchall()
        errors = conn.execute(
            """SELECT * FROM (
               SELECT 'jobs' AS queue,key,source,last_error,attempts,dead,due_at FROM jobs
                 WHERE last_error IS NOT NULL
               UNION ALL
               SELECT 'vector_outbox',o.key,e.source,o.last_error,o.attempts,o.dead,o.due_at
                 FROM vector_outbox o JOIN entities e ON e.key=o.key
                 WHERE o.last_error IS NOT NULL
               ) errors ORDER BY dead DESC,due_at DESC LIMIT 20"""
        ).fetchall()
        activity = conn.execute("SELECT * FROM activity ORDER BY id DESC LIMIT 60").fetchall()
        nodes = conn.execute(
            """SELECT key,title,artist,source,kind,popularity,revision,indexed_revision
               FROM entities ORDER BY updated_at DESC,key LIMIT 60"""
        ).fetchall()
        edges = conn.execute(
            """SELECT source,target,relation FROM edges WHERE source=ANY(%s)
               ORDER BY source,target LIMIT 160""",
            ([node["key"] for node in nodes],),
        ).fetchall()
        missing = list({edge["target"] for edge in edges} - {node["key"] for node in nodes})[:80]
        if missing:
            nodes += conn.execute(
                """SELECT key,title,artist,source,kind,popularity,revision,indexed_revision
                   FROM entities WHERE key=ANY(%s)""",
                (missing,),
            ).fetchall()
        popular = conn.execute(
            """SELECT key,title,source,kind,popularity FROM entities
               WHERE popularity>0 ORDER BY popularity DESC,key LIMIT 8"""
        ).fetchall()
        budgets = conn.execute(
            """SELECT host,next_at::text AS next_at,
               CASE WHEN next_at='infinity' THEN NULL
               WHEN next_at>now() THEN extract(epoch FROM next_at-now()) ELSE 0 END AS wait_seconds
               FROM host_budgets ORDER BY host"""
        ).fetchall()
        total = conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"]
    metric_map = {row["source"]: row for row in counts}
    pause_map = {row["source"]: row["paused"] for row in controls}
    queue_map = {row["source"]: row for row in source_queues}
    research_map = {row[0]: row for row in RESEARCH}
    sources = []
    for source in SOURCES:
        queue = queue_map.get(source, {})
        enabled, paused = store.settings.enabled(source), pause_map.get(source, False)
        sources.append(
            {
                "id": source,
                "name": research_map[source][1],
                "enabled": enabled,
                "paused": paused,
                "entities": metric_map.get(source, {}).get("entities", 0),
                "indexed": metric_map.get(source, {}).get("indexed", 0),
                "due": queue.get("due", 0),
                "active": queue.get("active", 0),
                "eligible": queue.get("host_ready", 0) if enabled and not paused else 0,
                "wait_seconds": queue.get("wait_seconds", 0) or 0,
                "bulk_only": source == "omdb",
                "kinds": KINDS.get(
                    source,
                    ("artist", "song")
                    if source == "youtube"
                    else (() if source == "listenbrainz" else ("artist", "album", "song")),
                ),
            }
        )
    return {
        "at": time.time(),
        "entities": total,
        "indexed": sum(row["indexed"] for row in counts),
        "capacity": store.settings.max_entities,
        "sources": sources,
        "recent": recent,
        "eligible": sum(source["eligible"] for source in sources),
        "research": [
            {"id": identifier, "name": name, "status": status, "note": note, "docs": docs}
            for identifier, name, status, note, docs in RESEARCH
        ],
        "workers": workers,
        "queues": queues,
        "jobs": jobs,
        "errors": errors,
        "activity": activity,
        "graph": {"nodes": nodes, "edges": edges},
        "popular": popular,
        "budgets": budgets,
        "graph_notice": "Recent 60 records + fetched neighbors; up to 160 explicit relationships.",
    }


def router(app):
    routes = APIRouter()
    token = secrets.token_urlsafe(32)
    lock = threading.Lock()
    cache = {"at": 0.0, "data": None}
    stream_capacity = asyncio.Semaphore(8)
    graph_capacity = threading.BoundedSemaphore(4)
    atlas_lock = threading.Lock()
    atlas_cache = {"at": 0.0, "data": None}
    storage_lock = threading.Lock()
    storage_cache = {"at": 0.0, "data": None}

    def monitor():
        with lock:
            if time.monotonic() - cache["at"] >= 5 or cache["data"] is None:
                cache["data"] = jsonable_encoder(snapshot(app.state.store))
                cache["at"] = time.monotonic()
            return cache["data"]

    def invalidate():
        with lock:
            cache["at"] = 0.0

    def authorize(request: Request, supplied: str | None):
        if not supplied or not secrets.compare_digest(supplied, token):
            raise HTTPException(403, "Refresh the console before issuing a control action")
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != request.headers.get("host"):
            raise HTTPException(403, "Control actions must originate from this local console")

    @routes.get("/", include_in_schema=False)
    def home():
        return FileResponse(STATIC / "index.html", media_type="text/html")

    @routes.get("/docs", include_in_schema=False)
    def docs():
        return FileResponse(STATIC / "api.html", media_type="text/html")

    @routes.get("/console/{asset}", include_in_schema=False)
    def asset(
        asset: Literal[
            "console.css",
            "console.js",
            "graph-layout.js",
            "graph-view.js",
            "cytoscape.min.js",
            "cytoscape.LICENSE.txt",
            "data.css",
            "data.js",
            "embedding-map.js",
            "embedding-atlas.js",
            "embedding-atlas.LICENSE.txt",
            "clustering.worker.js",
        ],
    ):
        return FileResponse(STATIC / asset)

    @routes.get("/v1/console/session")
    def session():
        return {"token": token}

    @routes.get("/v1/console/snapshot")
    def status():
        try:
            return monitor()
        except psycopg.Error as error:
            app.state.log.exception("console_snapshot_unavailable")
            raise HTTPException(503, "Telemetry database unavailable; retry shortly") from error

    @routes.get("/v1/console/storage")
    def storage_status():
        from catalog.telemetry import storage

        with storage_lock:
            if storage_cache["data"] is None or time.monotonic() - storage_cache["at"] >= 30:
                storage_cache["data"] = storage(app.state.store)
                storage_cache["at"] = time.monotonic()
            return storage_cache["data"]

    @routes.get("/v1/console/atlas")
    def catalog_atlas(
        source: Annotated[str | None, Query(max_length=20)] = None,
        kind: Annotated[str | None, Query(max_length=10)] = None,
        prefix: Annotated[str, Query(max_length=32, pattern="^[0-9a-f]*$")] = "",
    ):
        from catalog.atlas import atlas

        if not graph_capacity.acquire(blocking=False):
            raise HTTPException(503, "Graph capacity reached; retry shortly")
        try:
            if source is None:
                if kind is not None or prefix:
                    raise HTTPException(422, "Choose a source and type before expanding a group")
                if not atlas_lock.acquire(blocking=False):
                    raise HTTPException(503, "Catalog overview is refreshing; retry shortly")
                try:
                    if atlas_cache["data"] is None or time.monotonic() - atlas_cache["at"] >= 30:
                        with app.state.store.transaction() as conn:
                            atlas_cache["data"] = atlas(conn)
                        atlas_cache["at"] = time.monotonic()
                    return atlas_cache["data"]
                finally:
                    atlas_lock.release()
            with app.state.store.transaction() as conn:
                return atlas(conn, source, kind, prefix)
        finally:
            graph_capacity.release()

    @routes.websocket("/v1/console/live")
    async def live(socket: WebSocket):
        origin = socket.headers.get("origin", "")
        host = socket.headers.get("host", "")
        if urlsplit(origin).netloc != host or host.split(":")[0] not in (
            "localhost",
            "127.0.0.1",
            "testserver",
        ):
            await socket.close(code=1008)
            return
        if stream_capacity.locked():
            await socket.close(code=1013)
            return
        await stream_capacity.acquire()
        try:
            await socket.accept()
            while True:
                try:
                    data = await asyncio.to_thread(monitor)
                    await socket.send_json({"type": "snapshot", "data": data})
                except psycopg.Error:
                    app.state.log.exception("console_stream_unavailable")
                    await socket.send_json(
                        {
                            "type": "error",
                            "message": "Telemetry unavailable. Retrying in 5 seconds.",
                        }
                    )
                await asyncio.sleep(5)
        except (WebSocketDisconnect, RuntimeError):
            # Starlette raises RuntimeError when a closed peer is discovered during send.
            app.state.log.info("console_stream_disconnected")
        finally:
            stream_capacity.release()

    @routes.post("/v1/console/seed", status_code=202)
    def seed(body: Seed, request: Request, x_console_token: Annotated[str | None, Header()] = None):
        authorize(request, x_console_token)
        store = app.state.store
        if not store.settings.enabled(body.source):
            raise HTTPException(409, f"Enable {body.source} in .env and recreate services first")
        if body.source == "apple" and body.country not in store.settings.countries:
            raise HTTPException(422, "Apple storefront must be listed in COUNTRIES")
        try:
            key = entity_key(body.country, body.kind, body.identifier, body.source)
            task = lookup_task(body.source, body.kind)
        except (ValueError, KeyError) as error:
            raise HTTPException(422, str(error)) from error
        with store.transaction() as conn:
            store.enqueue(conn, task, body.country, body.kind, body.identifier, 50)
            store.activity(
                conn,
                "console",
                "seeded",
                "Operator added a discovery seed",
                key=key,
                source=body.source,
            )
        invalidate()
        return {"status": "queued", "key": key}

    @routes.post("/v1/console/sources/{source}")
    def pause(
        source: Source,
        body: Pause,
        request: Request,
        x_console_token: Annotated[str | None, Header()] = None,
    ):
        authorize(request, x_console_token)
        store = app.state.store
        if not store.settings.enabled(source):
            raise HTTPException(409, "Source is disabled in .env; a pause toggle cannot enable it")
        with store.transaction() as conn:
            conn.execute(
                "UPDATE source_controls SET paused=%s,changed_at=now() WHERE source=%s",
                (body.paused, source),
            )
            store.activity(
                conn,
                "console",
                "paused" if body.paused else "resumed",
                "Source claims paused; in-flight work may finish"
                if body.paused
                else "Source resumed",
                source=source,
            )
        invalidate()
        return {"source": source, "paused": body.paused}

    @routes.post("/v1/console/retry")
    def retry(
        body: Retry,
        request: Request,
        x_console_token: Annotated[str | None, Header()] = None,
    ):
        authorize(request, x_console_token)
        with app.state.store.transaction() as conn:
            row = conn.execute(
                sql.SQL(
                    """UPDATE {} SET dead=false,attempts=0,last_error=NULL,due_at=now()
                       WHERE key=%s AND lease_until<=now() RETURNING key"""
                ).format(sql.Identifier(body.queue)),
                (body.key,),
            ).fetchone()
            if row is None:
                raise HTTPException(409, "Work no longer exists or is currently leased")
            app.state.store.activity(
                conn,
                "console",
                "retried",
                "Operator retried work",
                key=body.key,
            )
        invalidate()
        return {"status": "queued"}

    @routes.get("/v1/console/artist-network")
    def network(
        key: Annotated[str | None, Query(max_length=160)] = None,
        q: Annotated[str, Query(max_length=100)] = "",
        after: Annotated[str, Query(max_length=300)] = "",
        limit: Annotated[int, Query(ge=1, le=20)] = 12,
    ):
        from catalog.graph import artist_network

        if not graph_capacity.acquire(blocking=False):
            raise HTTPException(503, "Graph capacity reached; retry shortly")
        try:
            with app.state.store.transaction() as conn:
                return artist_network(
                    conn, key=key, query=" ".join(q.split()), after=after, limit=limit
                )
        finally:
            graph_capacity.release()

    @routes.get("/v1/console/catalog-network")
    def catalog_graph(
        key: Annotated[str | None, Query(max_length=1300)] = None,
        q: Annotated[str, Query(max_length=100)] = "",
        after: Annotated[str, Query(max_length=1000)] = "",
        limit: Annotated[int, Query(ge=1, le=20)] = 10,
    ):
        from catalog.catalog_network import catalog_network

        if not graph_capacity.acquire(blocking=False):
            raise HTTPException(503, "Graph capacity reached; retry shortly")
        try:
            with app.state.store.transaction() as conn:
                return catalog_network(
                    conn, key=key, query=" ".join(q.split()), after=after, limit=limit
                )
        finally:
            graph_capacity.release()

    @routes.get("/v1/console/graph/{key}")
    def graph(key: str):
        if len(key) > 160:
            raise HTTPException(422, "Entity key exceeds its budget")
        with app.state.store.transaction() as conn:
            conn.execute("SET LOCAL statement_timeout='2000ms'")
            edges = conn.execute(
                """SELECT source,target,relation FROM edges WHERE source=%s OR target=%s
                   ORDER BY source,target LIMIT 101""",
                (key, key),
            ).fetchall()
            keys = list(
                {key} | {edge[field] for edge in edges[:100] for field in ("source", "target")}
            )
            nodes = conn.execute(
                """SELECT key,title,artist,source,kind,popularity,revision,indexed_revision
                   FROM entities WHERE key=ANY(%s)""",
                (keys,),
            ).fetchall()
        return {"nodes": nodes, "edges": edges[:100], "truncated": len(edges) > 100}

    return routes
