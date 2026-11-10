import math
import re
import uuid
from dataclasses import dataclass
from urllib.parse import urlsplit


KINDS = ("artist", "album", "song")
MODEL = "sentence-transformers/all-MiniLM-L6-v2"
DIMENSIONS = 384


def provider_id(value: object, source: str = "apple") -> str:
    text = str(value)
    if source in (
        "spotify",
        "archive",
        "wikidata",
        "soundcloud",
        "openverse",
        "amazon",
        "discogs",
        "omdb",
    ):
        patterns = {
            "spotify": r"[a-zA-Z0-9]{22}",
            "archive": r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}",
            "wikidata": r"Q[1-9][0-9]{0,14}",
            "soundcloud": r"[a-zA-Z0-9_-]{1,60}(?:~[a-zA-Z0-9_-]{1,60})?",
            "openverse": r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            "amazon": r"[A-Z0-9]{10}",
            "discogs": r"[mr]?[1-9][0-9]{0,19}",
            "omdb": r"[a-zA-Z0-9_-]{1,128}",
        }
        if not re.fullmatch(patterns[source], text):
            raise ValueError(f"Invalid {source} identifier")
        return text
    if source in ("youtube", "ytmusic"):
        if not re.fullmatch("[a-zA-Z0-9_-]{11,128}", text):
            raise ValueError("Invalid YouTube identifier")
        return text
    if source == "musicbrainz":
        if str(uuid.UUID(text)) != text.lower():
            raise ValueError("Invalid MusicBrainz identifier")
        return text.lower()
    if source not in ("apple", "deezer"):
        raise ValueError("Unknown metadata source")
    if not re.fullmatch("[1-9][0-9]{0,19}", text):
        raise ValueError("Apple IDs must be positive decimal identifiers")
    return text


def entity_key(country: str, kind: str, identifier: object, source: str = "apple") -> str:
    from catalog.providers import KINDS as SOURCE_KINDS, PUBLIC_SOURCES

    if not re.fullmatch("(?:[a-z]{2}|global)", country) or kind not in KINDS:
        raise ValueError("Invalid storefront or entity kind")
    if (
        source in ("musicbrainz", "youtube", "ytmusic", "omdb", *PUBLIC_SOURCES)
        and country != "global"
    ):
        raise ValueError("This source's entity identity has global scope")
    if source == "apple" and country == "global":
        raise ValueError("Apple records require a storefront")
    if source in PUBLIC_SOURCES and kind not in SOURCE_KINDS[source]:
        raise ValueError(f"{source} does not support {kind}")
    if source == "amazon":
        raise ValueError("Amazon API requires credentials; only external links are supported")
    if source == "soundcloud" and (("~" in str(identifier)) != (kind == "song")):
        raise ValueError("SoundCloud song IDs use user~track; artist IDs use user")
    if source == "discogs" and (
        (kind == "artist" and not str(identifier).isdecimal())
        or (kind == "album" and not str(identifier).startswith(("m", "r")))
    ):
        raise ValueError("Discogs artists use numeric IDs; albums use m<master> or r<release>")
    if source in ("youtube", "ytmusic") and (
        (kind == "album" and (source == "youtube" or not str(identifier).startswith("MPRE")))
        or (kind == "artist" and not re.fullmatch("UC[a-zA-Z0-9_-]{22}", str(identifier)))
        or (kind == "song" and not re.fullmatch("[a-zA-Z0-9_-]{11}", str(identifier)))
    ):
        raise ValueError(
            "Use a UC channel ID, 11-character video ID or YouTube Music MPRE album ID"
        )
    return f"{source}:{country}:{kind}:{provider_id(identifier, source)}"


def point_id(key: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"mint-catalog:{key}"))


def text(value: object, maximum: int = 500) -> str:
    if not isinstance(value, str):
        raise ValueError("Expected text in source metadata")
    result = " ".join(value.split())
    if not result or len(result) > maximum:
        raise ValueError("Source text is empty or exceeds its budget")
    return result


def apple_url(value: object) -> str:
    result = text(value, 2048)
    parsed = urlsplit(result)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in ("music.apple.com", "itunes.apple.com")
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
    ):
        raise ValueError("Invalid Apple attribution URL")
    return result


@dataclass(frozen=True)
class Entity:
    key: str
    country: str
    kind: str
    provider_id: str
    title: str
    artist: str
    album: str
    genres: tuple[str, ...]
    url: str
    artist_keys: tuple[str, ...] = ()
    album_keys: tuple[str, ...] = ()
    source: str = "apple"
    origin: str = "apple"
    quality: int = 1

    def document(self) -> str:
        return " | ".join(
            part for part in (self.kind, self.title, self.artist, self.album, *self.genres) if part
        )


def chart_entities(payload: dict, country: str) -> list[Entity]:
    feed = payload["feed"]
    if feed["country"].lower() != country:
        raise ValueError("Chart storefront does not match request")
    results = feed["results"]
    if not isinstance(results, list) or not 1 <= len(results) <= 100:
        raise ValueError("Chart must contain 1..100 entries")
    entities = []
    seen = set()
    for row in results:
        if row["kind"] != "songs":
            raise ValueError("Unexpected chart entity kind")
        identifier = provider_id(row["id"])
        key = entity_key(country, "song", identifier)
        if key in seen:
            raise ValueError("Duplicate chart entry")
        seen.add(key)
        genres = tuple(text(g["name"], 100) for g in row.get("genres", [])[:20])
        entities.append(
            Entity(
                key,
                country,
                "song",
                identifier,
                text(row["name"]),
                text(row["artistName"]),
                "",
                genres,
                apple_url(row["url"]),
                (entity_key(country, "artist", row["artistId"]),) if row.get("artistId") else (),
                quality=0,
            )
        )
    return entities


def lookup_entities(payload: dict, country: str, max_results: int = 201) -> list[Entity]:
    rows = payload["results"]
    if (
        not 1 <= max_results <= 1005
        or not isinstance(rows, list)
        or len(rows) > max_results
        or payload["resultCount"] != len(rows)
    ):
        raise ValueError("Invalid or oversized lookup response")
    entities = []
    for row in rows:
        wrapper = row.get("wrapperType")
        if wrapper == "artist":
            kind, id_field, title_field, url_field = (
                "artist",
                "artistId",
                "artistName",
                "artistLinkUrl",
            )
        elif wrapper == "collection" and row.get("collectionType") == "Album":
            kind, id_field, title_field, url_field = (
                "album",
                "collectionId",
                "collectionName",
                "collectionViewUrl",
            )
        elif wrapper == "track" and row.get("kind") == "song":
            kind, id_field, title_field, url_field = "song", "trackId", "trackName", "trackViewUrl"
        else:
            raise ValueError("Unexpected lookup entity kind")
        identifier = provider_id(row[id_field])
        entities.append(
            Entity(
                entity_key(country, kind, identifier),
                country,
                kind,
                identifier,
                text(row[title_field]),
                text(row.get("artistName", row[title_field])),
                text(row["collectionName"]) if kind == "song" and row.get("collectionName") else "",
                (text(row["primaryGenreName"], 100),) if row.get("primaryGenreName") else (),
                apple_url(row[url_field]),
                (entity_key(country, "artist", row["artistId"]),) if kind != "artist" else (),
                (entity_key(country, "album", row["collectionId"]),) if kind == "song" else (),
            )
        )
    return list({entity.key: entity for entity in entities}.values())


def musicbrainz_entity(kind: str, row: dict, *, text_limit=500, credit_limit=100) -> Entity:
    identifier = provider_id(row["id"], "musicbrainz")
    credits = row.get("artist-credit", [])
    if not isinstance(credits, list) or len(credits) > credit_limit:
        raise ValueError("Invalid MusicBrainz credits")
    artists = tuple(
        dict.fromkeys(
            entity_key("global", "artist", credit["artist"]["id"], "musicbrainz")
            for credit in credits
            if isinstance(credit, dict) and "artist" in credit
        )
    )
    artist = "".join(
        credit.get("name", credit.get("artist", {}).get("name", "")) + credit.get("joinphrase", "")
        for credit in credits
        if isinstance(credit, dict)
    )
    title = text(row["name"] if kind == "artist" else row["title"], text_limit)
    releases = row.get("releases", [])
    if not isinstance(releases, list) or len(releases) > 100:
        raise ValueError("Invalid MusicBrainz release relationship budget")
    albums = tuple(
        dict.fromkeys(
            entity_key("global", "album", release["release-group"]["id"], "musicbrainz")
            for release in releases
            if "release-group" in release
        )
    )
    path = {"artist": "artist", "song": "recording", "album": "release-group"}[kind]
    genres = row.get("genres", [])
    if not isinstance(genres, list) or len(genres) > 100:
        raise ValueError("Invalid MusicBrainz genre budget")
    genre_names = tuple(dict.fromkeys(text(genre["name"], 100) for genre in genres))
    return Entity(
        entity_key("global", kind, identifier, "musicbrainz"),
        "global",
        kind,
        identifier,
        title,
        text(artist, text_limit) if artist else (title if kind == "artist" else ""),
        "",
        genre_names[:20],
        f"https://musicbrainz.org/{path}/{identifier}",
        artists,
        albums,
        source="musicbrainz",
        origin="musicbrainz",
    )


def listenbrainz_entities(payload: dict) -> list[tuple[Entity, int]]:
    data = payload["payload"]
    rows = data["recordings"]
    if data["range"] != "week" or not isinstance(rows, list) or len(rows) > 100:
        raise ValueError("Invalid ListenBrainz weekly statistics")
    result = []
    seen = set()
    for rank, row in enumerate(rows, 1):
        if not row.get("recording_mbid"):
            continue
        identifier = provider_id(row["recording_mbid"], "musicbrainz")
        if identifier in seen:
            continue
        seen.add(identifier)
        if not isinstance(row["listen_count"], int) or row["listen_count"] < 0:
            raise ValueError("Invalid ListenBrainz listen count")
        artists = row.get("artist_mbids", [])
        if not isinstance(artists, list) or len(artists) > 100:
            raise ValueError("Invalid ListenBrainz credits")
        entity = Entity(
            entity_key("global", "song", identifier, "musicbrainz"),
            "global",
            "song",
            identifier,
            text(row["track_name"]),
            text(row["artist_name"]),
            "",
            (),
            f"https://musicbrainz.org/recording/{identifier}",
            tuple(entity_key("global", "artist", artist, "musicbrainz") for artist in artists),
            source="musicbrainz",
            origin="listenbrainz",
            quality=0,
        )
        result.append((entity, rank))
    return result


def chart_weight(rank: int) -> float:
    if not 1 <= rank <= 100:
        raise ValueError("Invalid chart rank")
    return 1 / math.log2(rank + 1)


def fuse(lexical: list[str], semantic: list[str], limit: int) -> list[tuple[str, float]]:
    scores: dict[str, float] = {}
    for ranking in (lexical, semantic):
        for rank, key in enumerate(dict.fromkeys(ranking), 1):
            scores[key] = scores.get(key, 0) + 1 / (60 + rank)
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))[:limit]
