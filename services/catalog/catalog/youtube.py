import re
import logging
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import requests
from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException
from ytmusicapi import YTMusic
from ytmusicapi.exceptions import YTMusicError
from xml.etree.ElementTree import ParseError

from catalog.model import Entity, entity_key, provider_id, text
from catalog.sources import Deferred, MAX_BODY, retry_after


YOUTUBE_ERRORS = (requests.RequestException, YTMusicError, DefusedXmlException, ParseError)
log = logging.getLogger(__name__)


@dataclass
class Discovery:
    entities: list[Entity]
    jobs: list[tuple[str, str, str]]
    ranked: list[tuple[Entity, int]]
    views: list[tuple[Entity, int]]
    metrics: list[tuple[Entity, str, int]] = field(default_factory=list)
    pages: list[tuple[str, str, str, int]] = field(default_factory=list)
    links: list[tuple[str, str, str, str, str]] = field(default_factory=list)
    annotations: list[tuple[str, dict]] = field(default_factory=list)


def ytm_entity(kind: str, row: dict, quality: int = 0) -> Entity:
    identifier = provider_id(
        row["videoId"] if kind == "song" else row.get("browseId") or row["id"], "ytmusic"
    )
    if kind == "song" and not re.fullmatch("[a-zA-Z0-9_-]{11}", identifier):
        raise ValueError("Invalid YouTube Music video ID")
    credits = row.get("artists") or []
    if not isinstance(credits, list) or len(credits) > 100:
        raise ValueError("Invalid YouTube Music credits")
    artists = tuple(
        dict.fromkeys(
            entity_key("global", "artist", credit["id"], "ytmusic")
            for credit in credits
            if credit.get("id")
        )
    )
    album = row.get("album")
    albums = (
        (entity_key("global", "album", album["id"], "ytmusic"),)
        if isinstance(album, dict) and album.get("id")
        else ()
    )
    title = text(row.get("title") or row["name"])
    url = (
        f"https://music.youtube.com/watch?v={identifier}"
        if kind == "song"
        else (f"https://music.youtube.com/browse/{identifier}")
    )
    return Entity(
        entity_key("global", kind, identifier, "ytmusic"),
        "global",
        kind,
        identifier,
        title,
        ", ".join(text(credit["name"]) for credit in credits)
        if credits
        else (title if kind == "artist" else ""),
        text(album["name"]) if isinstance(album, dict) and album.get("name") else "",
        (),
        url,
        artists,
        albums,
        source="ytmusic",
        origin="ytmusic",
        quality=quality,
    )


def parse_ytmusic(job: dict, payload: dict) -> Discovery:
    task = job["task"]
    result = Discovery([], [], [], [])
    if task == "ytm-chart":
        artists = payload.get("artists")
        playlists = payload.get("videos")
        if not isinstance(artists, list) or not isinstance(playlists, list):
            raise ValueError("YouTube Music chart shape changed")
        for row in artists[:100]:
            # Some public chart shelves are mislabelled "artists" by the library.
            # Explicit browse IDs, not shelf positions or names, determine identity.
            identifier = row["browseId"]
            kind = "album" if identifier.startswith("MPRE") else "artist"
            entity = ytm_entity(kind, row)
            result.entities.append(entity)
            rank = row.get("rank")
            # Unauthenticated chart artists may be unranked; list position is not a rank.
            if rank is not None:
                number = int(rank)
                if not 1 <= number <= 100:
                    raise ValueError("Invalid explicit YouTube Music chart rank")
                result.ranked.append((entity, number))
        for row in playlists[:10]:
            result.jobs.append(("ytm-playlist", "album", provider_id(row["playlistId"], "ytmusic")))
    elif task == "ytm-playlist":
        rows = payload["tracks"]
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError("YouTube Music playlist exceeds crawl budget")
        for row in rows:
            if row.get("videoId"):
                result.entities.append(ytm_entity("song", row))
    elif task == "ytm-song":
        row = payload["videoDetails"]
        result.entities.append(
            ytm_entity(
                "song",
                {
                    "videoId": row["videoId"],
                    "title": row["title"],
                    "artists": [{"id": row["channelId"], "name": row["author"]}],
                },
                quality=1,
            )
        )
    elif task == "ytm-album":
        album = ytm_entity("album", {**payload, "browseId": job["provider_id"]}, quality=1)
        result.entities.append(album)
        rows = payload["tracks"]
        if not isinstance(rows, list) or len(rows) > 200:
            raise ValueError("YouTube Music album exceeds track budget")
        for row in rows:
            if row.get("videoId"):
                result.entities.append(
                    ytm_entity(
                        "song",
                        {
                            **row,
                            "artists": row.get("artists") or payload.get("artists", []),
                            "album": {"id": album.provider_id, "name": album.title},
                        },
                    )
                )
    elif task == "ytm-artist":
        result.entities.append(
            ytm_entity(
                "artist",
                {
                    "browseId": job["provider_id"],
                    "title": payload["name"],
                },
                quality=1,
            )
        )
        for section, kind in (
            ("songs", "song"),
            ("videos", "song"),
            ("albums", "album"),
            ("singles", "album"),
        ):
            group = payload.get(section)
            if group is None:
                continue
            if not isinstance(group, dict):
                raise ValueError("Invalid YouTube Music artist section")
            rows = group.get("results", [])
            if not isinstance(rows, list) or len(rows) > 100:
                raise ValueError("YouTube Music artist section exceeds budget")
            for row in rows:
                if (kind == "song" and row.get("videoId")) or (
                    kind == "album" and row.get("browseId")
                ):
                    result.entities.append(
                        ytm_entity(
                            kind,
                            {
                                **row,
                                "artists": row.get("artists")
                                or [{"id": job["provider_id"], "name": payload["name"]}],
                            },
                        )
                    )
    else:
        raise ValueError("Unknown YouTube Music task")
    result.entities = list({entity.key: entity for entity in result.entities}.values())
    return result


def parse_feed(body: str, channel_id: str) -> Discovery:
    root = ElementTree.fromstring(body)
    ns = {
        "a": "http://www.w3.org/2005/Atom",
        "yt": "http://www.youtube.com/xml/schemas/2015",
        "m": "http://search.yahoo.com/mrss/",
    }
    reported_channel = root.findtext("yt:channelId", namespaces=ns)
    if reported_channel not in (channel_id, channel_id.removeprefix("UC")):
        raise ValueError("YouTube feed channel does not match request")
    channel_name = text(root.findtext("a:title", namespaces=ns))
    channel_key = entity_key("global", "artist", channel_id, "youtube")
    channel = Entity(
        channel_key,
        "global",
        "artist",
        channel_id,
        channel_name,
        channel_name,
        "",
        (),
        f"https://www.youtube.com/channel/{channel_id}",
        source="youtube",
        origin="youtube",
    )
    result = Discovery([channel], [], [], [])
    entries = root.findall("a:entry", ns)
    if len(entries) > 50:
        raise ValueError("YouTube feed exceeds entry budget")
    for row in entries:
        identifier = row.findtext("yt:videoId", namespaces=ns)
        entity = Entity(
            entity_key("global", "song", identifier, "youtube"),
            "global",
            "song",
            identifier,
            text(row.findtext("a:title", namespaces=ns)),
            channel_name,
            "",
            (),
            f"https://www.youtube.com/watch?v={identifier}",
            (channel_key,),
            source="youtube",
            origin="youtube",
            quality=0,
        )
        result.entities.append(entity)
        statistics = row.find("m:group/m:community/m:statistics", ns)
        if statistics is not None and statistics.get("views") is not None:
            views = int(statistics.get("views"))
            if not 0 <= views <= 10**15:
                raise ValueError("Invalid public YouTube view count")
            result.views.append((entity, views))
    return result


def parse_oembed(payload: dict, identifier: str) -> Discovery:
    author_url = payload["author_url"]
    parsed = urlsplit(author_url)
    if parsed.scheme != "https" or parsed.hostname not in ("www.youtube.com", "youtube.com"):
        raise ValueError("Unexpected YouTube author URL")
    channel_id = (
        parsed.path.removeprefix("/channel/") if parsed.path.startswith("/channel/") else None
    )
    artists = (entity_key("global", "artist", channel_id, "youtube"),) if channel_id else ()
    entity = Entity(
        entity_key("global", "song", identifier, "youtube"),
        "global",
        "song",
        identifier,
        text(payload["title"]),
        text(payload["author_name"]),
        "",
        (),
        f"https://www.youtube.com/watch?v={identifier}",
        artists,
        source="youtube",
        origin="youtube",
        quality=1,
    )
    return Discovery([entity], [], [], [])


class PublicMusicSession(requests.Session):
    """Apply shared host limits and budgets to every underlying library request."""

    def __init__(self, store):
        super().__init__()
        self.store = store
        self.deadline = 0.0
        self.requests_left = 0
        self.started_requests = 0
        self.admitted_host = None
        self.admitted_until = None
        self.trust_env = False

    def begin(self, admitted_host=None, admitted_until=None):
        self.deadline = time.monotonic() + 90
        self.requests_left = 12
        self.started_requests = 0
        self.admitted_host = admitted_host
        self.admitted_until = admitted_until

    def request(self, method, url, **kwargs):
        with self.store.transaction() as conn:
            control = conn.execute(
                """SELECT s.paused,b.next_at=%s AND b.next_at>clock_timestamp() AS admitted
                   FROM source_controls s LEFT JOIN host_budgets b ON b.host='music.youtube.com'
                   WHERE s.source='ytmusic'""",
                (self.admitted_until,),
            ).fetchone()
            if control and control["paused"]:
                raise Deferred("YouTube Music source is paused", 30)
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or parsed.hostname != "music.youtube.com"
            or (parsed.username or parsed.password or parsed.port not in (None, 443))
        ):
            raise ValueError("YouTube Music request left its fixed public host")
        self.requests_left -= 1
        if self.requests_left < 0:
            raise ValueError("YouTube Music per-job request budget exceeded")
        while True:
            wait = (
                0
                if self.admitted_host == "music.youtube.com"
                and self.admitted_until
                and control
                and control.get("admitted")
                else self.store.reserve_host(
                    "music.youtube.com", self.store.settings.request_interval("ytmusic")
                )
            )
            self.admitted_host = None
            self.admitted_until = None
            if not wait:
                break
            if not self.started_requests or wait > 10 or time.monotonic() + wait >= self.deadline:
                raise Deferred("YouTube Music shared host is waiting", wait)
            time.sleep(wait)
        self.started_requests += 1
        if time.monotonic() >= self.deadline:
            raise ValueError("YouTube Music job elapsed-time budget exceeded")
        kwargs.update(timeout=(10, 20), allow_redirects=False, stream=True)
        # Never retain login cookies or copy browser credentials between requests.
        self.cookies.clear()
        headers = dict(kwargs.get("headers") or {})
        headers["User-Agent"] = self.store.settings.user_agent
        kwargs["headers"] = headers
        response = super().request(method, url, **kwargs)
        with response:
            if response.status_code in (401, 403, 429, 503):
                seconds = max(
                    86400 if response.status_code in (401, 403) else 60,
                    retry_after(response.headers.get("retry-after")),
                )
                self.store.pause_host("music.youtube.com", seconds)
                raise Deferred(f"YouTube Music returned {response.status_code}", seconds)
            if response.is_redirect:
                raise ValueError("YouTube Music redirected; inspect consent/availability")
            response.raise_for_status()
            body = bytearray()
            for chunk in response.iter_content(65536):
                body.extend(chunk)
                if len(body) > MAX_BODY or time.monotonic() >= self.deadline:
                    raise ValueError("YouTube Music response budget exceeded")
            response._content = bytes(body)
            response._content_consumed = True
        return response


class YouTubeMusic:
    def __init__(self, store):
        self.session = PublicMusicSession(store)
        self.client = None

    def close(self):
        self.session.close()

    def fetch(self, job: dict) -> dict:
        self.session.begin(job.pop("request_host", None), job.pop("request_until", None))
        if self.client is None:
            self.client = YTMusic(requests_session=self.session)
            self.client.cookies = {}
        task = job["task"]
        identifier = provider_id(job["provider_id"], "ytmusic") if task != "ytm-chart" else ""
        if task == "ytm-chart":
            return self.client.get_charts(country=job["country"].upper())
        if task == "ytm-artist":
            try:
                return self.client.get_artist(identifier)
            except KeyError as error:
                if error.args != ("musicImmersiveHeaderRenderer",):
                    raise
                log.info("ytmusic_public_uploader_channel id=%s", identifier)
                return self.client.get_user(identifier)
        if task == "ytm-album":
            return self.client.get_album(identifier)
        if task == "ytm-song":
            return self.client.get_song(identifier)
        if task == "ytm-playlist":
            playlist = self.client.get_playlist(identifier, limit=100)
            return {**playlist, "tracks": playlist["tracks"][:100]}
        raise ValueError("Unknown YouTube Music task")
