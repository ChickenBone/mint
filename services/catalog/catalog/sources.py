import json
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlsplit

import httpx

from catalog.config import Settings
from catalog.model import provider_id
from catalog.store import Store, search_text
from catalog.providers import HOSTS as SOURCE_HOSTS, PUBLIC_SOURCES, task_source


HOSTS = {
    "itunes.apple.com",
    "rss.marketingtools.apple.com",
    "musicbrainz.org",
    "api.listenbrainz.org",
    "www.youtube.com",
}
HOSTS.update(SOURCE_HOSTS.values())
MAX_BODY = 4 * 1024 * 1024
LUCENE_SPECIAL = set('+-&|!(){}[]^"~*?:\\/')


def lucene_text(value: str) -> str:
    """Listener text as literal MusicBrainz search terms, never Lucene operators or fields."""
    return "".join(f"\\{char}" if char in LUCENE_SPECIAL else char for char in value)


class Deferred(RuntimeError):
    def __init__(self, message, seconds):
        super().__init__(message)
        self.seconds = seconds


def retry_after(value: str | None, now: datetime | None = None) -> float:
    if not value:
        return 60
    try:
        return max(1, int(value))
    except ValueError:
        try:
            return max(
                1,
                (
                    parsedate_to_datetime(value) - (now or datetime.now(timezone.utc))
                ).total_seconds(),
            )
        except (ValueError, TypeError, OverflowError):
            return 60


def request_url(job: dict, settings: Settings) -> tuple[str, dict]:
    task, country = job["task"], job["country"]
    source = task_source(task)
    if source in PUBLIC_SOURCES:
        if not settings.enabled(source):
            raise Deferred(f"{source} source is disabled", 3600)
        from catalog.public_sources import request_url as public_url

        return public_url({**job, "source": source})
    if task in ("yt-feed", "yt-video"):
        if not settings.youtube_enabled:
            raise Deferred("YouTube source is disabled", 3600)
        identifier = job["provider_id"]
        entity = "artist" if task == "yt-feed" else "song"
        from catalog.model import entity_key

        entity_key("global", entity, identifier, "youtube")
        if task == "yt-feed":
            return "https://www.youtube.com/feeds/videos.xml", {"channel_id": identifier}
        return "https://www.youtube.com/oembed", {
            "url": f"https://www.youtube.com/watch?v={identifier}",
            "format": "json",
        }
    if task in ("chart", "lookup", "apple-search"):
        if not settings.apple_enabled:
            raise Deferred("Apple source is disabled", 3600)
        if country not in settings.countries:
            raise Deferred("Apple storefront is no longer configured", 86400)
        if task == "chart":
            return (
                f"https://rss.marketingtools.apple.com/api/v2/{country}/music/"
                "most-played/100/songs.json",
                {},
            )
        if task == "apple-search":
            return "https://itunes.apple.com/search", {
                "term": search_text(job["provider_id"]),
                "country": country,
                "media": "music",
                "entity": "song",
                "limit": 25,
            }
        identifier = provider_id(job["provider_id"])
        if "lookup_ids" in job:
            identifiers = job["lookup_ids"]
            maximum = 50 if job["kind"] == "song" else 5
            if (
                not isinstance(identifiers, list)
                or not 1 <= len(identifiers) <= maximum
                or len(set(identifiers)) != len(identifiers)
                or identifier not in identifiers
            ):
                raise ValueError("Invalid Apple lookup batch")
            identifier = ",".join(provider_id(value) for value in identifiers)
        return "https://itunes.apple.com/lookup", {
            "id": identifier,
            "country": country,
            "entity": {"artist": "album", "album": "song", "song": "song"}[job["kind"]],
            "limit": 200,
        }
    if task == "lb-chart":
        if not settings.listenbrainz_enabled:
            raise Deferred("ListenBrainz source is disabled", 3600)
        return "https://api.listenbrainz.org/1/stats/sitewide/recordings", {
            "count": 100,
            "range": "week",
        }
    if not settings.musicbrainz_enabled:
        raise Deferred("MusicBrainz source is disabled", 3600)
    root = "https://musicbrainz.org/ws/2"
    if task == "mb-search":
        return f"{root}/recording", {
            "query": lucene_text(search_text(job["provider_id"])),
            "limit": 25,
            "fmt": "json",
        }
    identifier = provider_id(job["provider_id"], "musicbrainz")
    if task in ("mb-albums", "mb-songs"):
        resource = "release-group" if task == "mb-albums" else "recording"
        return f"{root}/{resource}", {
            "artist": identifier,
            "limit": 100,
            "offset": job["page"],
            "inc": "artist-credits",
            "fmt": "json",
        }
    if task != "mb-lookup":
        raise ValueError("Unknown source job")
    resource = {"artist": "artist", "album": "release-group", "song": "recording"}[job["kind"]]
    return f"{root}/{resource}/{identifier}", {
        "fmt": "json",
        **(
            {"inc": "artist-credits+releases+release-groups+url-rels+genres"}
            if job["kind"] == "song"
            else (
                {"inc": "artist-credits+url-rels+genres"}
                if job["kind"] == "album"
                else {"inc": "url-rels+genres"}
            )
        ),
    }


class Sources:
    def __init__(self, store: Store, settings: Settings):
        from catalog.youtube import YouTubeMusic

        self.store, self.settings = store, settings
        self.ytmusic = YouTubeMusic(store)
        self.client = httpx.Client(
            timeout=httpx.Timeout(30, connect=10),
            follow_redirects=False,
            headers={"User-Agent": settings.user_agent, "Accept": "application/json"},
            limits=httpx.Limits(max_connections=2),
        )

    def close(self):
        self.client.close()
        self.ytmusic.close()

    def fetch(self, job: dict) -> dict:
        source = task_source(job["task"])
        if not self.settings.enabled(source):
            raise Deferred(f"{source} source is disabled", 3600)
        with self.store.transaction() as conn:
            control = conn.execute(
                """SELECT s.paused,b.next_at=%s AND b.next_at>clock_timestamp() AS admitted
                   FROM source_controls s LEFT JOIN host_budgets b ON b.host=%s
                   WHERE s.source=%s""",
                (job.get("request_until"), job.get("request_host"), source),
            ).fetchone()
            if control and control["paused"]:
                raise Deferred(f"{source} source is paused", 30)
        if source == "ytmusic":
            return self.ytmusic.fetch(job)
        url, params = request_url(job, self.settings)
        url = str(httpx.URL(url, params=params))
        admitted_host = job.pop("request_host", None)
        until = job.pop("request_until", None)
        if not until or not control or not control.get("admitted"):
            admitted_host = None
        deadline = time.monotonic() + 60
        for hop in range(4):
            if time.monotonic() > deadline:
                raise ValueError("Upstream request exceeded its elapsed-time budget")
            parsed = urlsplit(url)
            host = parsed.hostname
            if (
                parsed.scheme != "https"
                or host not in HOSTS
                or parsed.username
                or parsed.password
                or parsed.port not in (None, 443)
            ):
                raise ValueError("Upstream redirect left the public source allowlist")
            interval = self.settings.request_interval(source, host)
            wait = (
                0 if hop == 0 and admitted_host == host else self.store.reserve_host(host, interval)
            )
            # Keep short redirect continuations in this job instead of refetching the original URL.
            while wait and hop and wait <= 10 and time.monotonic() + wait < deadline:
                time.sleep(wait)
                wait = self.store.reserve_host(host, interval)
            if wait:
                raise Deferred("Shared upstream rate budget is not ready", wait)
            with self.client.stream("GET", url) as response:
                if response.status_code in (401, 403, 429, 503):
                    delay = max(
                        86400 if response.status_code in (401, 403) else 60,
                        retry_after(response.headers.get("retry-after")),
                    )
                    self.store.pause_host(host, delay)
                    raise Deferred(f"Upstream {host} returned {response.status_code}", delay)
                if response.is_redirect:
                    if source in PUBLIC_SOURCES:
                        raise ValueError(
                            "Public metadata endpoint redirected; inspect source availability"
                        )
                    url = urljoin(url, response.headers["location"])
                    continue
                response.raise_for_status()
                is_feed = job["task"] == "yt-feed"
                content_type = response.headers.get("content-type", "").lower()
                apple_json = (
                    job["task"] in ("lookup", "apple-search")
                    and host == "itunes.apple.com"
                    and content_type.split(";", 1)[0].strip() == "text/javascript"
                )
                if (
                    not apple_json
                    and ("xml" if is_feed else "application/json") not in content_type
                ):
                    raise ValueError(
                        "Source returned non-JSON content; no browser challenge bypass"
                    )
                body = bytearray()
                for chunk in response.iter_bytes():
                    if time.monotonic() > deadline:
                        raise ValueError("Upstream request exceeded its elapsed-time budget")
                    body.extend(chunk)
                    if len(body) > MAX_BODY:
                        raise ValueError("Upstream response exceeds decompressed byte budget")
                if is_feed:
                    return {"xml": body.decode("utf-8")}
                result = json.loads(body)
                if source == "openwhyd" and isinstance(result, list):
                    return {"tracks": result}
                if not isinstance(result, dict):
                    raise ValueError("Source response must be a JSON object")
                return result
        raise ValueError("Too many upstream redirects")
