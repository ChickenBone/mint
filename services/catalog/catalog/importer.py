import json
from threading import Event

from catalog.model import Entity, apple_url, entity_key, provider_id, text
from catalog.store import Store
from catalog.providers import PUBLIC_SOURCES, canonical_url


def normalized_entity(row: dict) -> Entity:
    source, country, kind = row["source"], row["country"], row["kind"]
    identifier = provider_id(row["provider_id"], source)
    key = entity_key(country, kind, identifier, source)
    artists = row.get("artist_ids", [])
    albums = row.get("album_ids", [])
    genres = row.get("genres", [])
    if any(not isinstance(items, list) or len(items) > 100 for items in (artists, albums, genres)):
        raise ValueError("Imported relationship/tag budget exceeded")
    if len(genres) > 20:
        raise ValueError("At most 20 genres per entity are supported")
    if source == "apple":
        url = apple_url(row["url"])
    elif source in (*PUBLIC_SOURCES, "omdb"):
        if source == "openverse":
            raise ValueError(
                "Openverse imports require license attribution; use its metadata adapter"
            )
        url = canonical_url(source, kind, identifier)
    elif source == "musicbrainz":
        path = {"artist": "artist", "song": "recording", "album": "release-group"}[kind]
        url = f"https://musicbrainz.org/{path}/{identifier}"
    elif source == "ytmusic":
        url = (
            f"https://music.youtube.com/watch?v={identifier}"
            if kind == "song"
            else (f"https://music.youtube.com/browse/{identifier}")
        )
    else:
        url = (
            f"https://www.youtube.com/watch?v={identifier}"
            if kind == "song"
            else (f"https://www.youtube.com/channel/{identifier}")
        )
    return Entity(
        key,
        country,
        kind,
        identifier,
        text(row["title"]),
        text(row["artist"]) if row.get("artist") else "",
        text(row["album"]) if row.get("album") else "",
        tuple(text(genre, 100) for genre in genres),
        url,
        tuple(entity_key(country, "artist", artist, source) for artist in artists),
        tuple(entity_key(country, "album", album, source) for album in albums),
        source=source,
        origin=source,
    )


def import_jsonl(store: Store, path: str, stop: Event | None = None) -> int:
    total = 0
    with open(path, "rb") as stream:
        batch = []
        line = 0
        while not (stop and stop.is_set()) and (raw := stream.readline(65537)):
            line += 1
            try:
                if len(raw) > 65536:
                    raise ValueError("Line exceeds 64 KiB")
                row = json.loads(raw)
                entity = normalized_entity(row)
            except (ValueError, KeyError, TypeError) as error:
                raise ValueError(f"Invalid normalized import at line {line}: {error}") from error
            batch.append(entity)
            if len(batch) == 128:
                with store.transaction() as conn:
                    store.ingest(conn, batch)
                total += len(batch)
                batch = []
        if batch:
            with store.transaction() as conn:
                store.ingest(conn, batch)
            total += len(batch)
    return total
