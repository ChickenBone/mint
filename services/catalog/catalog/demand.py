"""Listener demand hints from a trusted Mint server, turned into bounded, prioritised crawl jobs.

Demand is crawl priority only. It never writes popularity, chart signals or user identities, and
every job still passes source enablement, pauses and shared host budgets when it is claimed.
"""

import math
import re
import threading
import time
import unicodedata
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from catalog.providers import lookup_task
from catalog.store import DEMAND_FLOOR, search_text

MAX_SIGNALS = 50
MAX_MATCHES = 6
SEARCH_PRIORITY = 95
PAGE_PRIORITY = 90
Text = Annotated[str, Field(min_length=1, max_length=200)]


class Signal(BaseModel):
    type: Literal["search", "artist", "album", "play"]
    query: Text | None = None
    title: Text | None = None
    artist: Text | None = None
    count: Annotated[int, Field(ge=1, le=1_000_000)] = 1


class Batch(BaseModel):
    signals: Annotated[list[Signal], Field(min_length=1, max_length=MAX_SIGNALS)]


def fold(value: str | None) -> str:
    decomposed = unicodedata.normalize("NFKD", value or "")
    plain = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"[\W_]+", "", plain).casefold()


def play_priority(count: int) -> float:
    return min(PAGE_PRIORITY, DEMAND_FLOOR + 5 * math.log2(1 + count))


def searchable(*parts: str | None) -> str | None:
    text = " ".join(" ".join(part.split()) for part in parts if part and part.strip())
    try:
        return search_text(text[:200])
    except ValueError:
        return None


def search_jobs(settings, query: str | None, priority: float) -> list[tuple]:
    if query is None:
        return []
    jobs = []
    if settings.enabled("ytmusic"):
        jobs.append(("ytm-search", "global", "song", query, priority))
    if settings.enabled("musicbrainz"):
        jobs.append(("mb-search", "global", "song", query, priority))
    if settings.enabled("apple"):
        jobs.append(("apple-search", settings.countries[0], "song", query, priority))
    return jobs


def entity_jobs(settings, rows, priority: float) -> list[tuple]:
    jobs = []
    for row in rows:
        if not settings.enabled(row["source"]):
            continue
        try:
            task = lookup_task(row["source"], row["kind"])
        except ValueError:
            continue
        jobs.append((task, row["country"], row["kind"], row["provider_id"], priority))
        if row["source"] == "musicbrainz" and row["kind"] == "artist":
            # Fill out a viewed artist's discography now rather than at half priority later.
            jobs += [
                (task, "global", "artist", row["provider_id"], priority)
                for task in ("mb-albums", "mb-songs")
            ]
        if row["source"] == "ytmusic" and row["kind"] == "song":
            jobs.append(("ytm-related", "global", "song", row["provider_id"], priority))
    return jobs


def plan(settings, signal: Signal, matches) -> list[tuple]:
    """Crawl jobs for one signal. `matches(kind, title, artist)` returns existing catalog rows."""
    if signal.type == "search":
        return search_jobs(settings, searchable(signal.query), SEARCH_PRIORITY)
    if signal.type == "artist":
        name = signal.artist or signal.title
        return entity_jobs(settings, matches("artist", name, None), PAGE_PRIORITY) + search_jobs(
            settings, searchable(name), PAGE_PRIORITY
        )
    if signal.type == "album":
        return entity_jobs(
            settings, matches("album", signal.title, signal.artist), PAGE_PRIORITY
        ) + search_jobs(settings, searchable(signal.title, signal.artist), PAGE_PRIORITY)
    priority = play_priority(signal.count)
    songs = matches("song", signal.title, signal.artist)
    related = [row for row in songs if row["source"] == "ytmusic"][:1]
    jobs = entity_jobs(settings, related, priority)
    if not related:
        jobs += search_jobs(settings, searchable(signal.title, signal.artist), priority)
    if signal.artist:
        jobs += entity_jobs(settings, matches("artist", signal.artist, None)[:2], priority - 5)
    return jobs


def matcher(conn):
    def matches(kind: str, title: str | None, artist: str | None) -> list[dict]:
        wanted, credit = fold(title), fold(artist)
        if not wanted:
            return []
        rows = conn.execute(
            """SELECT source,country,kind,provider_id,title,artist FROM entities
               WHERE search@@plainto_tsquery('simple',%s) AND kind=%s
               ORDER BY popularity DESC NULLS LAST,key LIMIT 40""",
            (title, kind),
        ).fetchall()
        found = []
        for row in rows:
            credited = fold(row["artist"])
            if fold(row["title"]) != wanted:
                continue
            if credit and not (credited and (credit in credited or credited in credit)):
                continue
            found.append(row)
        return found[:MAX_MATCHES]

    return matches


class RateLimit:
    def __init__(self, limit: int = 120, window: float = 60):
        self.limit, self.window, self.calls, self.lock = limit, window, [], threading.Lock()

    def allow(self) -> bool:
        now = time.monotonic()
        with self.lock:
            self.calls = [at for at in self.calls if now - at < self.window]
            if len(self.calls) >= self.limit:
                return False
            self.calls.append(now)
            return True


def record(store, batch: Batch) -> int:
    settings = store.settings
    with store.transaction() as conn:
        conn.execute("SET LOCAL statement_timeout='5000ms'")
        matches = matcher(conn)
        jobs = {}
        for signal in batch.signals:
            for task, country, kind, identifier, priority in plan(settings, signal, matches):
                key = (task, country, kind, identifier)
                jobs[key] = max(priority, jobs.get(key, 0))
        for (task, country, kind, identifier), priority in sorted(jobs.items()):
            store.enqueue(
                conn, task, country, kind, identifier, priority, demand_priority=priority
            )
        if jobs:
            store.activity(
                conn,
                "demand",
                "prioritised",
                f"Listener demand prioritised {len(jobs)} crawl jobs",
                amount=len(jobs),
            )
    return len(jobs)
