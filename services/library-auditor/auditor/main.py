import argparse
import asyncio
import json
import logging
import os
from pathlib import Path

from pydantic import ValidationError

from auditor.api import MAX_BODY
from auditor.audit import audit
from auditor.catalog import CatalogUnavailable, reconcile_tracks
from auditor.model import AuditRequest


def main():
    parser = argparse.ArgumentParser(description="Read-only library metadata audits")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve")
    check = commands.add_parser("audit")
    check.add_argument("manifest")
    check.add_argument("--catalog-url", default=os.getenv("CATALOG_URL", ""))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    if args.command == "serve":
        import uvicorn

        uvicorn.run(
            "auditor.api:create_app",
            factory=True,
            host="0.0.0.0",
            port=8080,
            limit_concurrency=16,
            timeout_keep_alive=5,
        )
        return
    try:
        path = Path(args.manifest)
        with path.open("rb") as stream:
            body = stream.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise ValueError("Audit manifest exceeds 8 MiB")
        manifest = AuditRequest.model_validate_json(body)
        matches = None
        if manifest.reconcile:
            if not args.catalog_url:
                raise ValueError("Supply --catalog-url when reconcile is true")
            matches = asyncio.run(reconcile_tracks(manifest.tracks, args.catalog_url))
        print(json.dumps(audit(manifest, matches), ensure_ascii=True))
    except (OSError, ValueError, ValidationError, CatalogUnavailable) as error:
        parser.exit(1, f"Audit failed: {error}\n")


if __name__ == "__main__":
    main()
