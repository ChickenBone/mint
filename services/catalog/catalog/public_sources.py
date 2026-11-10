import re

from catalog.model import Entity, entity_key, provider_id, text
from catalog.providers import canonical_url
from catalog.youtube import Discovery


def request_url(job):
    source, kind, identifier, task = job["source"], job["kind"], job["provider_id"], job["task"]
    if source == "openwhyd":
        if task != "openwhyd-chart":
            raise ValueError("Openwhyd supports public discovery only")
        return "https://openwhyd.org/hot", {"format": "json", "limit": 20}
    if task.endswith("-chart"):
        if source == "deezer":
            return "https://api.deezer.com/chart/0", {"limit": 50}
        if source == "archive":
            return "https://archive.org/advancedsearch.php", {
                "q": "collection:etree AND mediatype:etree",
                "fl[]": ["identifier", "title", "creator", "downloads"],
                "sort[]": "downloads desc",
                "rows": 50,
                "output": "json",
            }
        if source == "openverse":
            return "https://api.openverse.org/v1/audio/", {"category": "music", "page_size": 20}
        raise ValueError("Source has no discovery feed")
    identifier = provider_id(identifier, source)
    entity_key("global", kind, identifier, source)
    if source == "discogs":
        if task == "discogs-albums":
            if kind != "artist" or job["page"] % 100:
                raise ValueError("Invalid Discogs discography page")
            return f"https://api.discogs.com/artists/{identifier}/releases", {
                "per_page": 100,
                "page": job["page"] // 100 + 1,
                "sort": "year",
                "sort_order": "desc",
            }
        path = (
            "artists"
            if kind == "artist"
            else "masters"
            if identifier.startswith("m")
            else "releases"
        )
        return (
            f"https://api.discogs.com/{path}/{identifier if kind == 'artist' else identifier[1:]}",
            {},
        )
    if source == "spotify":
        return "https://open.spotify.com/oembed", {"url": canonical_url(source, kind, identifier)}
    if source == "soundcloud":
        return "https://soundcloud.com/oembed", {
            "url": canonical_url(source, kind, identifier),
            "format": "json",
        }
    if source == "deezer":
        path = "track" if kind == "song" else kind
        if task == "deezer-albums":
            return f"https://api.deezer.com/artist/{identifier}/albums", {
                "limit": 100,
                "index": job["page"],
            }
        if task == "deezer-tracks":
            return f"https://api.deezer.com/album/{identifier}/tracks", {
                "limit": 100,
                "index": job["page"],
            }
        return f"https://api.deezer.com/{path}/{identifier}", {}
    if source == "archive":
        # Metadata-only field projection avoids receiving a whole media file manifest.
        return f"https://archive.org/metadata/{identifier}/metadata", {}
    if source == "wikidata":
        return f"https://www.wikidata.org/wiki/Special:EntityData/{identifier}.json", {}
    if source == "openverse":
        return f"https://api.openverse.org/v1/audio/{identifier}/", {}
    raise ValueError("Unknown public source")


def entity(
    source,
    kind,
    identifier,
    title,
    *,
    artist="",
    album="",
    artists=(),
    albums=(),
    genres=(),
    quality=1,
    url=None,
):
    identifier = provider_id(identifier, source)
    return Entity(
        entity_key("global", kind, identifier, source),
        "global",
        kind,
        identifier,
        text(title),
        text(artist) if artist else "",
        text(album) if album else "",
        tuple(text(genre, 100) for genre in genres[:20]),
        url or canonical_url(source, kind, identifier),
        tuple(entity_key("global", "artist", value, source) for value in artists),
        tuple(entity_key("global", "album", value, source) for value in albums),
        source=source,
        origin=source,
        quality=quality,
    )


def rows(value, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError("Source list is invalid or exceeds its response budget")
    return value


def names(value):
    if isinstance(value, list):
        return ", ".join(text(item, 150) for item in value[:3])
    return text(value) if value else ""


def deezer_entity(kind, row, quality=1):
    artist = row.get("artist") or {}
    album = row.get("album") or {}
    return entity(
        "deezer",
        kind,
        row["id"],
        row["name"] if kind == "artist" else row["title"],
        artist=artist.get("name", ""),
        album=album.get("title", ""),
        artists=(artist["id"],) if artist.get("id") else (),
        albums=(album["id"],) if album.get("id") else (),
        genres=[genre["name"] for genre in rows(row.get("genres", {}).get("data", []), 20)],
        quality=quality,
    )


def parse(job, payload):
    source, task, kind = job["source"], job["task"], job["kind"]
    if source == "discogs":
        from catalog.discogs import parse as parse_discogs

        return parse_discogs(job, payload)
    if source == "openwhyd":
        from catalog.openwhyd import parse as parse_openwhyd

        return parse_openwhyd(payload)
    result = Discovery([], [], [], [])
    if "error" in payload:
        raise ValueError(f"{source} returned an API error")
    if source in ("spotify", "soundcloud"):
        if payload.get("provider_name") != ("Spotify" if source == "spotify" else "SoundCloud"):
            raise ValueError("Unexpected oEmbed provider")
        result.entities.append(
            entity(
                source,
                kind,
                job["provider_id"],
                payload["title"],
                artist=payload.get("author_name", "") if source == "soundcloud" else "",
                quality=0,
            )
        )
    elif source == "deezer":
        if task == "deezer-chart":
            for section, row_kind in (
                ("tracks", "song"),
                ("albums", "album"),
                ("artists", "artist"),
            ):
                for row in rows(payload[section]["data"], 100):
                    item = deezer_entity(row_kind, row, 0)
                    result.entities.append(item)
                    # `rank` is Deezer's score, not a chart position.
                    position = row.get("position")
                    if position is not None:
                        if not isinstance(position, int) or not 1 <= position <= 100:
                            raise ValueError("Invalid explicit Deezer chart position")
                        result.ranked.append((item, position))
        elif task == "deezer-albums":
            for row in rows(payload["data"], 100):
                result.entities.append(deezer_entity("album", row, 0))
            if payload.get("next"):
                if job["page"] >= 10000:
                    raise ValueError("Deezer album pagination budget exceeded")
                result.pages.append(
                    ("deezer-albums", "artist", job["provider_id"], job["page"] + 100)
                )
        elif task == "deezer-tracks":
            for row in rows(payload["data"], 100):
                result.entities.append(
                    deezer_entity(
                        "song",
                        {**row, "album": {"id": job["provider_id"], "title": ""}},
                        0,
                    )
                )
            if payload.get("next"):
                if job["page"] >= 10000:
                    raise ValueError("Deezer track pagination budget exceeded")
                result.pages.append(
                    ("deezer-tracks", "album", job["provider_id"], job["page"] + 100)
                )
        else:
            if str(payload["id"]) != job["provider_id"]:
                raise ValueError("Deezer identity does not match request")
            parent = deezer_entity(kind, payload)
            result.entities.append(parent)
            if kind == "album":
                tracks = rows(payload.get("tracks", {}).get("data", []), 100)
                for row in tracks:
                    result.entities.append(
                        deezer_entity(
                            "song",
                            {
                                **row,
                                "album": {"id": parent.provider_id, "title": parent.title},
                                "artist": row.get("artist") or payload.get("artist"),
                            },
                            0,
                        )
                    )
                if payload.get("tracks", {}).get("next") or payload.get(
                    "nb_tracks", len(tracks)
                ) > len(tracks):
                    result.pages.append(("deezer-tracks", "album", parent.provider_id, len(tracks)))
            if kind == "artist":
                result.pages.append(("deezer-albums", "artist", parent.provider_id, 0))
    elif source == "archive":
        if task == "archive-chart":
            items = rows(payload["response"]["docs"], 50)
        else:
            if payload.get("result") is None:
                raise ValueError("Archive metadata missing")
            items = [payload["result"]]
        for row in items:
            if task != "archive-chart":
                if row["identifier"] != job["provider_id"]:
                    raise ValueError("Archive identity does not match request")
                collections = row.get("collection", [])
                if isinstance(collections, str):
                    collections = [collections]
                if not set(collections) & {"etree", "GratefulDead"}:
                    raise ValueError("Archive item is outside the Live Music Archive scope")
            item = entity(
                source,
                "album",
                row["identifier"],
                row["title"],
                artist=names(row.get("creator")),
                quality=0 if task.endswith("-chart") else 1,
            )
            result.entities.append(item)
            if row.get("downloads") is not None:
                result.metrics.append((item, "downloads", count(row["downloads"])))
    elif source == "wikidata":
        row = payload["entities"][job["provider_id"]]
        if row.get("id") != job["provider_id"] or row.get("missing") is not None:
            raise ValueError("Wikidata identity missing or mismatched")
        labels = row.get("labels")
        if not isinstance(labels, dict) or not labels or len(labels) > 1000:
            raise ValueError("Wikidata labels missing or exceed their budget")
        language = next((name for name in ("en", "mul") if name in labels), None)
        language = language or sorted(labels)[0]
        label = labels[language]
        if not isinstance(label, dict) or label.get("language", language) != language:
            raise ValueError("Wikidata label language does not match its key")
        item = entity(source, kind, row["id"], label["value"])
        result.entities.append(item)
        result.annotations.append((item.key, {"label_language": language}))
        # IDs asserted by Wikidata are links, not guessed duplicate merges.
        mapping = {
            "artist": {
                "P434": ("musicbrainz", "artist"),
                "P1902": ("spotify", "artist"),
                "P2722": ("deezer", "artist"),
                "P2397": ("ytmusic", "artist"),
            },
            "album": {
                "P436": ("musicbrainz", "album"),
                "P2205": ("spotify", "album"),
                "P2723": ("deezer", "album"),
                "P5749": ("amazon", "album"),
            },
            "song": {
                "P4404": ("musicbrainz", "song"),
                "P2207": ("spotify", "song"),
                "P2724": ("deezer", "song"),
            },
        }[kind]
        for prop, (provider, target_kind) in mapping.items():
            for claim in rows(row.get("claims", {}).get(prop, []), 100):
                if claim.get("rank") == "deprecated":
                    continue
                snak = claim["mainsnak"]
                if snak.get("snaktype") != "value":
                    continue
                identifier = provider_id(snak["datavalue"]["value"], provider)
                url = (
                    f"https://www.amazon.com/dp/{identifier}"
                    if provider == "amazon"
                    else (
                        f"https://musicbrainz.org/{'recording' if target_kind == 'song' else 'release-group' if target_kind == 'album' else 'artist'}/{identifier}"
                        if provider == "musicbrainz"
                        else canonical_url(provider, target_kind, identifier)
                    )
                )
                result.links.append((item.key, provider, target_kind, identifier, url))
    elif source == "openverse":
        items = rows(payload["results"], 20) if task.endswith("-chart") else [payload]
        for row in items:
            if row.get("category") != "music":
                raise ValueError("Openverse result is not classified as music")
            if task == "openverse-lookup" and row["id"] != job["provider_id"]:
                raise ValueError("Openverse identity does not match request")
            item = entity(
                source,
                "song",
                row["id"],
                row["title"],
                artist=row.get("creator") or "",
                genres=rows(row.get("genres") or [], 20),
            )
            result.entities.append(item)
            result.annotations.append(
                (
                    item.key,
                    {
                        "license": text(row["license"], 40),
                        "license_url": safe_link(row["license_url"]),
                        "attribution": text(row["attribution"], 4000),
                        "landing_url": safe_link(row["foreign_landing_url"]),
                    },
                )
            )
    else:
        raise ValueError("Unknown public source parser")
    result.entities = list({item.key: item for item in result.entities}.values())
    return result


def safe_link(value):
    from urllib.parse import urlsplit

    value = text(value, 2048)
    parsed = urlsplit(value)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Invalid attribution URL")
    return value


def count(value):
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]{1,16}", str(value)):
        raise ValueError("Invalid public popularity observation")
    return int(value)
