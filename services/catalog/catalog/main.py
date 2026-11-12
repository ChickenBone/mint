import argparse
import json
import logging
import re
import signal
from threading import Event

from catalog import crawler, indexer, ranker
from catalog.config import Settings
from catalog.model import entity_key
from catalog.store import Store
from catalog.vectors import Vectors
from catalog.providers import SOURCES, lookup_task


def main():
    parser = argparse.ArgumentParser(description="Independent multi-source music metadata catalog")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "crawl", "index", "rank", "serve", "serve-bridge", "status", "reindex"):
        commands.add_parser(name)
    reconcile = commands.add_parser("reconcile-artists")
    reconcile.add_argument(
        "--refresh-evidence",
        action="store_true",
        help="Also reschedule unleased, non-dead MusicBrainz/Wikidata artist jobs",
    )
    exclude = commands.add_parser("exclude-artist-link")
    exclude.add_argument("key", help="Evidence record's source-scoped entity key")
    exclude.add_argument("provider")
    exclude.add_argument("identifier")
    seed = commands.add_parser("seed")
    seed.add_argument(
        "source", choices=tuple(source for source in SOURCES if source not in ("listenbrainz", "openwhyd", "omdb"))
    )
    seed.add_argument("kind", choices=("artist", "album", "song"))
    seed.add_argument("identifier")
    seed.add_argument("--country", default="global")
    priority_artist = commands.add_parser("priority-artist")
    priority_artist.add_argument("identifier", help="Explicit MusicBrainz artist UUID")
    priority_artist.add_argument(
        "--provenance", required=True, help="Short non-sensitive source label, e.g. library-export"
    )
    priority_artist.add_argument("--remove", action="store_true", help="Remove this priority label")
    retry = commands.add_parser("retry")
    retry.add_argument("queue", choices=("jobs", "vector_outbox"))
    retry.add_argument("key")
    importer = commands.add_parser("import-jsonl")
    importer.add_argument("path", help="Normalized metadata export; see README for JSONL schema")
    discogs = commands.add_parser("import-discogs")
    discogs.add_argument("path", help="Local CC0 Discogs XML or XML.gz; no automatic download")
    discogs.add_argument("--kind", choices=("artist", "master", "release"), required=True)
    discogs.add_argument("--limit", type=int, default=100000, help="Maximum observations, default 100000")
    musicbrainz = commands.add_parser("import-musicbrainz")
    musicbrainz.add_argument("path", help="Official tar.xz or JSONL[.xz/.gz] snapshot")
    musicbrainz.add_argument("--kind", choices=("artist", "release-group", "recording", "release"), required=True)
    musicbrainz.add_argument("--limit", type=int, default=100000000, help="Input records this run; checkpoint resumes automatically")
    omdb = commands.add_parser("import-omdb")
    omdb.add_argument("path", help="Local OMDB PostgreSQL tar/custom dump (SQL is never executed)")
    omdb.add_argument("--kind", choices=("artist", "album", "song", "album-artists", "song-artists", "song-features"), required=True)
    omdb.add_argument("--limit", type=int, default=1000000000)
    snapshot = commands.add_parser("load-musicbrainz")
    snapshot.add_argument("directory", help="Download/cache directory, separate from the catalog database")
    snapshot.add_argument("--snapshot", help="Official YYYYMMDD-HHMMSS snapshot, defaults to LATEST")
    snapshot.add_argument("--kinds", nargs="+", choices=("artist", "release-group", "recording", "release"),
                          default=("artist", "release-group", "recording", "release"))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings.load()
    if args.command in ("serve", "serve-bridge"):
        import uvicorn

        tls = {}
        if args.command == "serve-bridge":
            from catalog.bridge import tls_files

            tls = tls_files()
        uvicorn.run(
            "catalog.api:app_factory" if args.command == "serve" else "catalog.bridge:app_factory",
            factory=True,
            host="0.0.0.0",
            port=8080,
            limit_concurrency=32,
            timeout_keep_alive=5,
            access_log=args.command == "serve",
            **tls,
        )
        return
    store = Store(settings)
    stop = Event()
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda *_: stop.set())
    try:
        if args.command == "init":
            store.migrate()
            vectors = Vectors(settings)
            try:
                vectors.initialize()
            finally:
                vectors.close()
            store.seed()
        elif args.command in ("crawl", "index", "rank"):
            {"crawl": crawler.run, "index": indexer.run, "rank": ranker.run}[args.command](
                store, stop
            )
        elif args.command == "seed":
            entity_key(args.country, args.kind, args.identifier, args.source)
            if args.source == "apple" and (
                not settings.apple_enabled or args.country not in settings.countries
            ):
                parser.error("Enable Apple and configure this storefront before seeding")
            if not settings.enabled(args.source):
                parser.error("Enable this source before seeding")
            with store.transaction() as conn:
                store.enqueue(
                    conn,
                    lookup_task(args.source, args.kind),
                    args.country,
                    args.kind,
                    args.identifier,
                    50,
                )
        elif args.command == "priority-artist":
            key = entity_key("global", "artist", args.identifier, "musicbrainz")
            if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", args.provenance):
                parser.error("Provenance must be a non-sensitive lowercase label (1-64 characters)")
            if not settings.musicbrainz_enabled and not args.remove:
                parser.error("Enable MusicBrainz before prioritizing an artist")
            with store.transaction() as conn:
                conn.execute("SELECT entities FROM catalog_budget FOR UPDATE")
                changed = store.priority_artist(
                    conn, args.identifier, args.provenance, remove=args.remove
                )
                if args.remove and not changed:
                    parser.error("Priority label does not exist")
            print(json.dumps({
                "artist": key, "provenance": args.provenance,
                "status": "removed" if args.remove else "queued",
            }))
        elif args.command == "retry":
            from psycopg import sql

            with store.transaction() as conn:
                row = conn.execute(
                    sql.SQL(
                        """UPDATE {} SET dead=false,attempts=0,last_error=NULL,due_at=now()
                           WHERE key=%s AND lease_until<=now() RETURNING key"""
                    ).format(sql.Identifier(args.queue)),
                    (args.key,),
                ).fetchone()
                if row is None:
                    parser.error("Queue key does not exist or is currently leased")
        elif args.command == "import-jsonl":
            from catalog.importer import import_jsonl

            count = import_jsonl(store, args.path, stop)
            print(
                json.dumps(
                    {
                        "imported": count,
                        "status": "interrupted" if stop.is_set() else "complete",
                    }
                )
            )
            if stop.is_set():
                raise SystemExit(130)
        elif args.command == "import-discogs":
            from catalog.discogs_import import import_discogs

            print(json.dumps(import_discogs(store, args.path, args.kind, stop, limit=args.limit)))
            if stop.is_set():
                raise SystemExit(130)
        elif args.command in ("import-musicbrainz", "import-omdb", "load-musicbrainz"):
            from catalog.musicbrainz_import import import_musicbrainz
            from catalog.omdb_import import import_omdb
            from catalog.snapshot import load_musicbrainz

            importer = import_musicbrainz if args.command == "import-musicbrainz" else import_omdb
            try:
                if args.command == "load-musicbrainz":
                    result = load_musicbrainz(
                        store, args.directory, stop, snapshot=args.snapshot, kinds=args.kinds,
                    )
                else:
                    result = importer(store, args.path, args.kind, stop, limit=args.limit)
            except InterruptedError:
                if not stop.is_set():
                    raise
                result = {"status": "interrupted"}
            print(json.dumps(result))
            if stop.is_set():
                raise SystemExit(130)
        elif args.command in ("reconcile-artists", "exclude-artist-link"):
            from catalog.identity import AUTHORITIES, rebuild_artists

            refreshed = 0
            with store.transaction() as conn:
                conn.execute("SELECT entities FROM catalog_budget FOR UPDATE")
                if args.command == "exclude-artist-link":
                    row = conn.execute(
                        """UPDATE entity_links SET canonical_status='excluded'
                           WHERE key=%s AND provider=%s AND kind='artist' AND identifier=%s
                           RETURNING key""",
                        (args.key, args.provider, args.identifier),
                    ).fetchone()
                    if row is None:
                        parser.error("Artist link does not exist")
                rebuild_artists(conn)
                if args.command == "reconcile-artists" and args.refresh_evidence:
                    refreshed = conn.execute(
                        """UPDATE jobs SET due_at=now(),ready=true
                           WHERE source=ANY(%s) AND kind='artist' AND NOT dead
                           AND lease_until<=now()""",
                        (list(AUTHORITIES),),
                    ).rowcount
            print(json.dumps({"status": "reconciled", "evidence_jobs_rescheduled": refreshed}))
        elif args.command == "reindex":
            cursor = ""
            while not stop.is_set():
                cursor = store.reindex_batch(cursor)
                if cursor is None:
                    break
            print(json.dumps({"status": "interrupted" if stop.is_set() else "queued"}))
            if stop.is_set():
                raise SystemExit(130)
        else:
            with store.transaction() as conn:
                counts = conn.execute(
                    """SELECT source,origin,kind,count(*) AS count,
                       count(*) FILTER(WHERE revision=indexed_revision) AS indexed
                       FROM entities GROUP BY source,origin,kind"""
                ).fetchall()
                queues = {}
                for table in ("jobs", "vector_outbox"):
                    from psycopg import sql

                    queues[table] = conn.execute(
                        sql.SQL(
                            """SELECT count(*) AS total,
                           count(*) FILTER(WHERE dead) AS dead,
                           count(*) FILTER(WHERE NOT dead AND due_at<=now()) AS due,
                           min(due_at) FILTER(WHERE NOT dead) AS oldest_scheduled
                           FROM {}"""
                        ).format(sql.Identifier(table))
                    ).fetchone()
                errors = conn.execute(
                    """SELECT * FROM (
                       SELECT 'jobs' AS queue,key,last_error,attempts,dead,due_at FROM jobs
                       WHERE last_error IS NOT NULL UNION ALL
                       SELECT 'vector_outbox',key,last_error,attempts,dead,due_at FROM vector_outbox
                       WHERE last_error IS NOT NULL) errors ORDER BY due_at DESC LIMIT 20"""
                ).fetchall()
                budgets = conn.execute(
                    "SELECT host,next_at::text AS next_at FROM host_budgets ORDER BY host"
                ).fetchall()
            print(
                json.dumps(
                    {
                        "entities": counts,
                        "queues": queues,
                        "errors": errors,
                        "host_budgets": budgets,
                    },
                    default=str,
                )
            )
    finally:
        store.close()
