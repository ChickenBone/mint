import logging
import random
import time
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from threading import Event
from traceback import extract_tb

import httpx
import psycopg

from catalog.model import (
    chart_entities,
    listenbrainz_entities,
    lookup_entities,
    musicbrainz_entity,
    provider_id,
)
from catalog.providers import PUBLIC_SOURCES, SOURCES, external_identity
from catalog.sources import Deferred, Sources
from catalog.store import DEMAND_FLOOR, LeaseLost, SEARCH_TASKS, Store
from catalog.workers import run_workers
from catalog.youtube import (
    YOUTUBE_ERRORS,
    parse_feed,
    parse_oembed,
    parse_ytmusic,
    Discovery,
)


DEMAND_ONLY_TASKS = (*SEARCH_TASKS, "ytm-related")
log = logging.getLogger(__name__)
SOURCE_ERRORS = (
    ValueError,
    KeyError,
    TypeError,
    httpx.HTTPError,
    psycopg.Error,
    LeaseLost,
    *YOUTUBE_ERRORS,
)


def process(store: Store, sources: Sources, job: dict, companions=()):
    started = time.monotonic()
    payload = sources.fetch(job)
    fetched = time.monotonic()
    task, country = job["task"], job["country"]
    ranked = None
    observed_at = None
    next_page = None
    discovery = None
    if job["source"] in PUBLIC_SOURCES:
        from catalog.public_sources import parse

        discovery = parse(job, payload)
        entities = discovery.entities
        if task.endswith("-chart"):
            ranked = discovery.ranked
            observed_at = datetime.now(timezone.utc)
    elif task.startswith("ytm-"):
        discovery = parse_ytmusic(job, payload)
        entities = discovery.entities
        if task == "ytm-chart":
            ranked = discovery.ranked
            observed_at = datetime.now(timezone.utc)
    elif task == "yt-feed":
        discovery = parse_feed(payload["xml"], job["provider_id"])
        entities = discovery.entities
    elif task == "yt-video":
        discovery = parse_oembed(payload, job["provider_id"])
        entities = discovery.entities
    elif task == "chart":
        entities = chart_entities(payload, country)
        ranked = [(entity, rank) for rank, entity in enumerate(entities, 1)]
        observed_at = parsedate_to_datetime(payload["feed"]["updated"])
    elif task == "lookup":
        entities = lookup_entities(
            payload, country, 201 if job["kind"] == "song" else 201 * (1 + len(companions))
        )
    elif task == "apple-search":
        entities = lookup_entities(payload, country, 50)
    elif task == "mb-search":
        rows = payload["recordings"]
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError("Invalid MusicBrainz search page")
        entities = []
        for row in rows:
            try:
                entities.append(replace(musicbrainz_entity("song", row), quality=0))
            except (KeyError, TypeError, ValueError):
                continue
    elif task == "lb-chart":
        ranked = listenbrainz_entities(payload)
        entities = [entity for entity, _ in ranked]
        observed_at = datetime.fromtimestamp(payload["payload"]["to_ts"], timezone.utc)
    elif task in ("mb-albums", "mb-songs"):
        kind, field = ("album", "release-groups") if task == "mb-albums" else ("song", "recordings")
        rows = payload[field]
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError("Invalid MusicBrainz browse page")
        total = payload["release-group-count" if kind == "album" else "recording-count"]
        if not isinstance(total, int) or total < 0:
            raise ValueError("Invalid MusicBrainz browse count")
        entities = [replace(musicbrainz_entity(kind, row), quality=0) for row in rows]
        if job["page"] + len(rows) < total:
            if not rows or job["page"] >= 100000:
                raise ValueError("MusicBrainz browse cannot advance within page budget")
            next_page = job["page"] + len(rows)
    else:
        entities = [musicbrainz_entity(job["kind"], payload)]
    parsed = time.monotonic()
    with store.transaction() as conn:
        conn.execute("SELECT entities FROM catalog_budget FOR UPDATE")
        for leased in sorted([job, *companions], key=lambda row: row["key"]):
            store.lock_job(conn, leased)
        inserted = store.ingest(conn, entities)
        if discovery is not None:
            store.view_signals(conn, discovery.views)
            store.public_observations(conn, discovery)
            for expansion, kind, identifier in discovery.jobs:
                store.enqueue(conn, expansion, "global", kind, identifier, job["priority"] * 0.5)
            for expansion, kind, identifier, page in discovery.pages:
                store.enqueue(
                    conn, expansion, "global", kind, identifier, job["priority"] * 0.5, page
                )
        if task == "mb-lookup":
            links = []
            relations = payload.get("relations", [])
            if not isinstance(relations, list) or len(relations) > 500:
                raise ValueError("MusicBrainz relationship budget exceeded")
            for relation in relations:
                url = relation.get("url", {}).get("resource")
                identity = external_identity(url) if isinstance(url, str) else None
                if identity:
                    source, linked_kind, identifier = identity
                    kind = linked_kind or job["kind"]
                    identifier = provider_id(identifier, source)
                    links.append((entities[0].key, source, kind, identifier, url))
            store.public_observations(conn, Discovery([], [], [], [], links=links))
        if ranked is not None:
            if observed_at > datetime.now(timezone.utc):
                raise ValueError("Source chart timestamp is in the future")
            store.signals(conn, job["key"], ranked, observed_at)
        if task == "mb-lookup" and job["kind"] == "artist":
            for expansion in ("mb-albums", "mb-songs"):
                store.enqueue(
                    conn, expansion, "global", "artist", job["provider_id"], job["priority"] * 0.5
                )
        if next_page is not None:
            store.enqueue(
                conn, task, country, "artist", job["provider_id"], job["priority"], next_page
            )
        for leased in [job, *companions]:
            store.complete(
                conn,
                leased,
                store.settings.chart_interval
                if ranked is not None or task == "yt-feed"
                else 30 * 86400
                if task in DEMAND_ONLY_TASKS
                else 7 * 86400,
            )
            if leased.get("priority", 0) >= DEMAND_FLOOR and not (
                leased["task"] == "chart" or leased["task"].endswith("-chart")
            ):
                # Served demand decays so it cannot monopolise expansion lanes; new demand re-raises it.
                conn.execute("UPDATE jobs SET priority=0 WHERE key=%s", (leased["key"],))
        store.activity(
            conn,
            "crawler",
            "crawled",
            f"Observed {len(entities)} metadata records",
            key=job["key"],
            source=job.get("source"),
            amount=len(entities),
        )
    log.info(
        "crawl_complete task=%s key=%s entities=%s new_entities=%s fetch_ms=%.1f "
        "parse_ms=%.1f store_ms=%.1f jobs=%s",
        task,
        job["key"],
        len(entities),
        inserted,
        (fetched - started) * 1000,
        (parsed - fetched) * 1000,
        (time.monotonic() - parsed) * 1000,
        1 + len(companions),
    )


def run(store: Store, stop: Event):
    store.seed()
    log.info(
        "crawler_sources intervals_seconds=%s",
        ",".join(
            f"{source}={store.settings.request_interval(source):g}"
            for source in SOURCES
            if store.settings.enabled(source)
        ),
    )
    run_workers("crawler", store.settings.crawler_workers, stop, lambda: crawl_worker(store, stop))


def crawl_worker(store: Store, stop: Event):
    sources = Sources(store, store.settings)
    worker = uuid.uuid4()
    try:
        while not stop.is_set():
            try:
                jobs = store.claim_crawl()
                if not jobs:
                    store.heartbeat(worker, "crawler", "waiting for eligible work")
                    stop.wait(store.crawl_delay())
                    continue
                job = jobs[0]
                store.heartbeat(worker, "crawler", "fetching", job["key"])
                try:
                    process(store, sources, job, jobs[1:])
                except Deferred as error:
                    log.warning("crawl_deferred key=%s reason=%s", job["key"], error)
                    for leased in jobs:
                        store.fail(leased, str(error), error.seconds, deferred=True)
                    store.heartbeat(worker, "crawler", "source backoff", job["key"])
                    stop.wait(0.1)
                except SOURCE_ERRORS as error:
                    # Library exception strings can contain entire upstream bodies.
                    code = type(error).__name__
                    sites = ">".join(
                        f"{frame.name}:{frame.lineno}"
                        for frame in extract_tb(error.__traceback__)[-3:]
                    )
                    log.error("crawl_failed key=%s code=%s at=%s", job["key"], code, sites)
                    for leased in jobs:
                        store.fail(
                            leased,
                            code,
                            min(86400, 30 * 2 ** leased["attempts"]) + random.uniform(0, 10),
                        )
            except psycopg.Error:
                log.exception("crawler_database_unavailable")
                stop.wait(10)
    finally:
        sources.close()
        store.heartbeat(worker, "crawler", "stopped")
