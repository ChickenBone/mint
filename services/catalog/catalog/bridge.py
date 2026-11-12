import asyncio
import hmac
import logging
import os
import re
import threading
from contextlib import asynccontextmanager
from typing import Annotated

import psycopg
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.responses import JSONResponse

from catalog.config import Settings
from catalog.model import entity_key, provider_id
from catalog.store import Store


log = logging.getLogger(__name__)
MAX_BODY = 16384


def tls_files():
    cert = os.getenv("CATALOG_BRIDGE_TLS_CERT", "")
    key = os.getenv("CATALOG_BRIDGE_TLS_KEY", "")
    if bool(cert) != bool(key):
        raise ValueError("Both CATALOG_BRIDGE_TLS_CERT and CATALOG_BRIDGE_TLS_KEY are required")
    return {"ssl_certfile": cert, "ssl_keyfile": key} if cert else {}


class BridgeGuard:
    def __init__(self, app, token: str):
        self.app = app
        self.expected = b"Bearer " + token.encode("ascii")
        self.capacity = threading.BoundedSemaphore(8)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        auth = [value for name, value in scope["headers"] if name.lower() == b"authorization"]
        if len(auth) != 1 or not hmac.compare_digest(auth[0], self.expected):
            return await JSONResponse({"detail": "Unauthorized"}, status_code=401)(scope, receive, send)
        if not self.capacity.acquire(blocking=False):
            return await JSONResponse(
                {"detail": "Bridge capacity reached"}, status_code=503, headers={"Retry-After": "1"}
            )(scope, receive, send)
        try:
            original_send = send

            async def no_store(message):
                if message["type"] == "http.response.start":
                    message.setdefault("headers", []).extend([
                        (b"cache-control", b"no-store"),
                        (b"x-content-type-options", b"nosniff"),
                    ])
                await original_send(message)

            send = no_store
            if scope["method"] == "POST":
                body = bytearray()
                try:
                    async with asyncio.timeout(10):
                        while True:
                            message = await receive()
                            if message["type"] == "http.disconnect":
                                return
                            body.extend(message.get("body", b""))
                            if len(body) > MAX_BODY:
                                return await JSONResponse(
                                    {"detail": "Input exceeds 16 KiB"}, status_code=413
                                )(scope, receive, send)
                            if not message.get("more_body"):
                                break
                except TimeoutError:
                    return await JSONResponse(
                        {"detail": "Input timed out"}, status_code=408
                    )(scope, receive, send)
                original_receive = receive
                delivered = False

                async def replay():
                    nonlocal delivered
                    if not delivered:
                        delivered = True
                        return {"type": "http.request", "body": bytes(body), "more_body": False}
                    return await original_receive()

                receive = replay
            await self.app(scope, receive, send)
        finally:
            self.capacity.release()


class PriorityBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    add: list[str] = Field(default_factory=list, max_length=100)
    remove: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_batch(self):
        self.add = [provider_id(item, "musicbrainz") for item in self.add]
        self.remove = [provider_id(item, "musicbrainz") for item in self.remove]
        if not 1 <= len(self.add) + len(self.remove) <= 100:
            raise ValueError("Provide 1 to 100 artist IDs")
        if len(set(self.add + self.remove)) != len(self.add) + len(self.remove):
            raise ValueError("Artist IDs must be unique and disjoint")
        return self


def create_bridge(settings: Settings, token: str, store: Store | None = None) -> FastAPI:
    if not re.fullmatch(r"[!-~]{32,256}", token):
        raise ValueError("CATALOG_BRIDGE_TOKEN must be 32-256 printable ASCII characters")

    @asynccontextmanager
    async def lifespan(app):
        app.state.store = store or Store(settings)
        yield
        if store is None:
            app.state.store.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(BridgeGuard, token=token)

    @app.exception_handler(psycopg.Error)
    async def database_error(request, error):
        log.error("bridge_database_failure code=%s", type(error).__name__)
        return JSONResponse({"detail": "Catalog database unavailable"}, status_code=503)

    def records(identifier, parent_kind, child_kind, relation, limit, after):
        try:
            parent = entity_key("global", parent_kind, identifier, "musicbrainz")
            cursor = entity_key("global", child_kind, after, "musicbrainz") if after else ""
        except ValueError as error:
            raise HTTPException(422, "Invalid MusicBrainz identifier") from error
        with app.state.store.transaction() as conn:
            conn.execute("SET LOCAL statement_timeout='2000ms'")
            if not conn.execute("SELECT 1 FROM entities WHERE key=%s", (parent,)).fetchone():
                raise HTTPException(404, "Catalog entity not found")
            rows = conn.execute(
                """SELECT e.provider_id AS id,e.title,e.artist,e.url
                   FROM edges ed JOIN entities e ON e.key=ed.source
                   WHERE ed.target=%s AND ed.relation=%s AND e.source='musicbrainz'
                     AND e.kind=%s AND e.key>%s
                   ORDER BY e.key LIMIT %s""",
                (parent, relation, child_kind, cursor, limit + 1),
            ).fetchall()
        return {
            "items": rows[:limit],
            "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
        }

    @app.get("/v1/artists/{artist_mbid}/albums")
    def albums(
        artist_mbid: str, limit: Annotated[int, Query(ge=1, le=100)] = 100,
        after: Annotated[str | None, Query(max_length=36)] = None,
    ):
        return records(artist_mbid, "artist", "album", "artist", limit, after)

    @app.get("/v1/albums/{release_group_mbid}/recordings")
    def recordings(
        release_group_mbid: str, limit: Annotated[int, Query(ge=1, le=100)] = 100,
        after: Annotated[str | None, Query(max_length=36)] = None,
    ):
        return records(release_group_mbid, "album", "song", "album", limit, after)

    @app.post("/v1/priority/artists")
    def priority(batch: PriorityBatch):
        with app.state.store.transaction() as conn:
            conn.execute("SET LOCAL statement_timeout='2000ms'")
            conn.execute("SELECT entities FROM catalog_budget FOR UPDATE")
            removed = sum(
                app.state.store.priority_artist(conn, item, "mint-library", remove=True)
                for item in sorted(batch.remove)
            )
            added = sum(
                app.state.store.priority_artist(conn, item, "mint-library")
                for item in sorted(batch.add)
            )
        return {"added": added, "removed": removed}

    return app


def app_factory():
    return create_bridge(Settings.load(), os.getenv("CATALOG_BRIDGE_TOKEN", ""))
