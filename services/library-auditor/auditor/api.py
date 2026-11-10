import asyncio
import logging
import os

from fastapi import FastAPI, HTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse

from auditor.audit import audit
from auditor.catalog import CatalogUnavailable, reconcile_tracks, validate_url
from auditor.model import AuditRequest


log = logging.getLogger(__name__)
MAX_BODY = 8 * 1024**2


class BodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
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
                            {"detail": "Audit manifest exceeds 8 MiB"},
                            status_code=413,
                        )(scope, receive, send)
                    if not message.get("more_body"):
                        break
        except TimeoutError:
            return await JSONResponse(
                {"detail": "Audit input timed out"},
                status_code=408,
            )(scope, receive, send)
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def create_app(catalog_url=None, *, transport=None):
    configured = catalog_url if catalog_url is not None else os.getenv("CATALOG_URL", "")
    if configured:
        validate_url(configured)
    app = FastAPI(title="Mint Library Auditor", version="0.1.0", docs_url=None, redoc_url=None)
    app.add_middleware(BodyLimit)
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "testserver"]
    )
    capacity = asyncio.Semaphore(2)

    @app.middleware("http")
    async def response_headers(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
        return response

    @app.get("/healthz")
    def health():
        return {"status": "ok", "catalog_configured": bool(configured)}

    @app.post("/v1/audits")
    async def run_audit(manifest: AuditRequest):
        if capacity.locked():
            raise HTTPException(503, "Audit capacity reached", headers={"Retry-After": "1"})
        async with capacity:
            matches = None
            if manifest.reconcile:
                if not configured:
                    raise HTTPException(503, "Set CATALOG_URL before requesting reconciliation")
                try:
                    matches = await reconcile_tracks(
                        manifest.tracks, configured, transport=transport
                    )
                except CatalogUnavailable as error:
                    log.error("catalog_reconciliation_unavailable reason=%s", type(error).__name__)
                    raise HTTPException(502, str(error)) from error
            return await asyncio.to_thread(audit, manifest, matches)

    return app
