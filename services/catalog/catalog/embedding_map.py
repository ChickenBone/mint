import threading
import time
import uuid
from typing import Annotated, Literal

import numpy as np
import psycopg
from fastapi import APIRouter, HTTPException, Query
from qdrant_client import models

from catalog.browser import decode_cursor, encode_cursor
from catalog.indexer import VECTOR_ERRORS
from catalog.model import DIMENSIONS, MODEL, point_id
from catalog.providers import EntitySource


PAGE_SIZE = 2048
SESSION_SECONDS = 1800
MAX_SESSIONS = 32
PROJECTION = "sample-pca-v1"


def fit_projection(vectors):
    matrix = np.asarray(vectors, dtype=np.float64).reshape(-1, DIMENSIONS)
    if not np.isfinite(matrix).all():
        raise ValueError("Nonfinite embedding in projection input")
    center = matrix.mean(axis=0) if len(matrix) else np.zeros(DIMENSIONS)
    centered = matrix - center
    basis, _ = np.linalg.qr(np.random.default_rng(42).normal(size=(DIMENSIONS, 2)))
    # Bounded block power iteration avoids a full SVD on the interactive path.
    for _ in range(12):
        basis, _ = np.linalg.qr(centered.T @ (centered @ basis))
    for column in range(2):
        if basis[np.argmax(abs(basis[:, column])), column] < 0:
            basis[:, column] *= -1
    total = float(np.sum(centered * centered))
    captured = float(np.sum((centered @ basis) ** 2))
    return center, basis, captured / total if total else 0


def current_points(store, points):
    usable = []
    for point in points:
        payload = point.payload or {}
        key = payload.get("key")
        if not isinstance(key, str) or str(point.id) != point_id(key):
            continue
        vector = point.vector
        if (not isinstance(vector, list) or len(vector) != DIMENSIONS
                or not all(isinstance(value, (int, float)) for value in vector)
                or not np.isfinite(vector).all()):
            raise ValueError("Incompatible embedding-map vector")
        usable.append(point)
    with store.transaction() as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        conn.execute("SET LOCAL statement_timeout='2000ms'")
        rows = conn.execute(
            """SELECT key,title,artist,source,kind,revision,indexed_revision FROM entities
               WHERE key=ANY(%s)""",
            ([point.payload["key"] for point in usable],),
        ).fetchall()
    metadata = {row["key"]: row for row in rows}
    return [
        (point, metadata[point.payload["key"]])
        for point in usable
        if point.payload["key"] in metadata
        and point.payload.get("revision") == metadata[point.payload["key"]]["revision"]
        == metadata[point.payload["key"]]["indexed_revision"]
        and point.payload.get("source") == metadata[point.payload["key"]]["source"]
        and point.payload.get("kind") == metadata[point.payload["key"]]["kind"]
    ]


def router(app):
    routes = APIRouter()
    capacity = threading.BoundedSemaphore(2)
    lock = threading.Lock()
    sessions = {}

    @routes.get("/v1/console/embedding-map")
    def page(
        source: EntitySource | None = None,
        kind: Literal["artist", "album", "song"] | None = None,
        after: Annotated[str | None, Query(max_length=1024)] = None,
    ):
        if not capacity.acquire(blocking=False):
            raise HTTPException(503, "Embedding map is busy", headers={"Retry-After": "2"})
        try:
            scope = ["embedding-map", source, kind]
            offset = None
            session = None
            with lock:
                for identifier in list(sessions):
                    if sessions[identifier]["expires"] <= time.monotonic():
                        del sessions[identifier]
                if after:
                    values = decode_cursor(after, scope)
                    if (not isinstance(values, list) or len(values) != 2
                            or not all(isinstance(value, str) for value in values)):
                        raise HTTPException(422, "Invalid embedding map cursor")
                    identifier, offset = values
                    try:
                        offset = str(uuid.UUID(offset))
                    except ValueError as error:
                        raise HTTPException(422, "Invalid embedding map offset") from error
                    session = sessions.get(identifier)
                    if session is None or session["scope"] != scope:
                        raise HTTPException(409, "Projection expired; reload the embedding map")
            filters = [
                models.FieldCondition(key=field, match=models.MatchValue(value=value))
                for field, value in (("source", source), ("kind", kind)) if value is not None
            ]
            points, next_offset = app.state.vectors.client.scroll(
                collection_name=app.state.vectors.collection,
                scroll_filter=models.Filter(must=filters) if filters else None,
                offset=offset, limit=PAGE_SIZE, with_payload=True, with_vectors=True,
            )
            current = current_points(app.state.store, points)
            if session is None:
                center, basis, variance = fit_projection([point.vector for point, _ in current])
                identifier = str(uuid.uuid4())
                session = {
                    "center": center, "basis": basis, "variance": variance,
                    "fitted": len(current), "scope": scope,
                    "expires": time.monotonic() + SESSION_SECONDS,
                }
                with lock:
                    if len(sessions) >= MAX_SESSIONS:
                        del sessions[min(sessions, key=lambda key: sessions[key]["expires"])]
                    sessions[identifier] = session
            elif session["fitted"] == 0 and current:
                with lock:
                    if session["fitted"] == 0:
                        center, basis, variance = fit_projection(
                            [point.vector for point, _ in current]
                        )
                        session.update(
                            center=center, basis=basis, variance=variance, fitted=len(current)
                        )
            coordinates = (
                np.asarray([point.vector for point, _ in current], dtype=np.float64)
                .reshape(-1, DIMENSIONS) - session["center"]
            ) @ session["basis"]
            records = [
                {
                    "key": row["key"], "title": row["title"][:160],
                    "artist": row["artist"][:120], "source": row["source"], "kind": row["kind"],
                    "x": round(float(xy[0]), 7), "y": round(float(xy[1]), 7),
                }
                for (_, row), xy in zip(current, coordinates, strict=True)
            ]
            with app.state.store.transaction() as conn:
                conn.execute("SET LOCAL statement_timeout='2000ms'")
                totals = conn.execute(
                    "SELECT sum(entities) AS records,sum(indexed) AS indexed FROM source_metrics"
                ).fetchone()
            return {
                "at": time.time(), "records": records, "scanned": len(points),
                "stale_skipped": len(points) - len(current),
                "next": encode_cursor(scope, [identifier, str(next_offset)])
                if next_offset is not None else None,
                "projection": {
                    "id": identifier, "method": PROJECTION, "model": MODEL,
                    "fitted_records": session["fitted"],
                    "sample_variance_retained": round(session["variance"], 4),
                    "expires_in_seconds": max(0, int(session["expires"] - time.monotonic())),
                },
                "catalog_records": totals["records"] or 0,
                "catalog_indexed": totals["indexed"] or 0,
                "notice": (
                    "2D PCA of metadata embeddings fitted on the first current-vector page, "
                    "not audio similarity or relationship edges. Paged live reads are not a "
                    "frozen export; pending/stale vectors and genre-only hubs are not plotted."
                ),
            }
        except (psycopg.Error, *VECTOR_ERRORS) as error:
            app.state.log.exception("embedding_map_unavailable")
            raise HTTPException(503, "Embedding map dependency unavailable; retry or use relationships") from error
        finally:
            capacity.release()

    return routes
