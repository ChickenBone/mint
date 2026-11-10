import gzip
import json
import lzma
import tarfile
from contextlib import contextmanager
from dataclasses import replace

from catalog.bulk_import import MAX_INPUT_BYTES, MAX_LINE_BYTES, import_run
from catalog.model import musicbrainz_entity, provider_id, text
from catalog.providers import external_identity
from catalog.youtube import Discovery


@contextmanager
def input_stream(path, kind):
    if str(path).endswith(".tar.xz"):
        with tarfile.open(path, mode="r|xz") as archive:
            for member in archive:
                if member.name.rstrip("/") == f"mbdump/{kind}":
                    if not member.isfile() or member.size > MAX_INPUT_BYTES:
                        raise ValueError("Invalid or oversized MusicBrainz archive member")
                    with archive.extractfile(member) as stream:
                        yield stream
                    return
            raise ValueError(f"Archive has no mbdump/{kind} data member")
    else:
        opener = (
            gzip.open
            if str(path).endswith(".gz")
            else lzma.open
            if str(path).endswith(".xz")
            else open
        )
        with opener(path, "rb") as stream:
            yield stream


def metadata(kind, row):
    genres = row.get("genres", [])
    if not isinstance(genres, list) or len(genres) > 10000:
        raise ValueError("Invalid MusicBrainz dump genre list")
    names = tuple(dict.fromkeys(text(genre["name"], 100) for genre in genres))
    item = musicbrainz_entity(
        kind,
        {
            "id": row["id"],
            "name" if kind == "artist" else "title": row["name"]
            if kind == "artist"
            else row["title"],
            "artist-credit": row.get("artist-credit", []),
            "genres": [],
        },
        text_limit=65536,
        credit_limit=10000,
    )
    return replace(item, genres=names[:20])


def parse(kind, row):
    entities = []
    originals = {}
    if kind == "release":
        group = row.get("release-group")
        album_key = None
        if group:
            album = metadata(
                "album",
                {
                    **group,
                    "artist-credit": group.get("artist-credit", row.get("artist-credit", [])),
                },
            )
            entities.append(album)
            originals[album.key] = group
            album_key = album.key
        media = row.get("media", [])
        if not isinstance(media, list) or len(media) > 10000:
            raise ValueError("Invalid MusicBrainz release media")
        for medium in media:
            tracks = medium.get("tracks", [])
            if not isinstance(tracks, list) or len(tracks) > 10000:
                raise ValueError("Invalid MusicBrainz release track list")
            for track in tracks:
                recording = track["recording"]
                song = metadata("song", recording)
                originals[song.key] = recording
                entities.append(
                    replace(
                        song,
                        album_keys=(album_key,) if album_key else (),
                    )
                )
    else:
        entities.append(
            metadata(
                {"artist": "artist", "release-group": "album", "recording": "song"}[kind],
                row,
            )
        )
        originals[entities[-1].key] = row
    annotations = []
    links = []
    for item in entities:
        original = originals[item.key]
        genres = list(
            dict.fromkeys(text(genre["name"], 100) for genre in original.get("genres", []))
        )
        extra = {"genre_count": len(genres), "genres_truncated": len(genres) > 20}
        if len(genres) > 20:
            extra["all_genres"] = genres
        if item.kind == "song":
            duration = original.get("length")
            if duration is not None:
                if type(duration) is not int or not 0 <= duration <= 86400000:
                    raise ValueError("Invalid MusicBrainz recording length")
                extra["duration_ms"] = duration
            relations = original.get("relations", [])
            if not isinstance(relations, list) or len(relations) > 10000:
                raise ValueError("Invalid MusicBrainz recording relation list")
            for relation in relations:
                url = relation.get("url", {}).get("resource")
                identity = external_identity(url) if isinstance(url, str) else None
                if identity and identity[1] == "song":
                    source, linked_kind, identifier = identity
                    links.append(
                        (
                            item.key,
                            source,
                            linked_kind,
                            provider_id(identifier, source),
                            text(url, 2048),
                        )
                    )
        annotations.append(
            (
                item.key,
                {
                    "discovery_source": "musicbrainz_dump",
                    "landing_url": "https://musicbrainz.org/doc/Development/JSON_Data_Dumps",
                    "core_data_license": "CC0-1.0",
                    "genre_data_license": "CC-BY-NC-SA-3.0",
                    "license_url": "https://musicbrainz.org/doc/About/Data_License",
                    **extra,
                },
            )
        )
    return Discovery(entities, [], [], [], annotations=annotations, links=links)


def import_musicbrainz(store, path, kind, stop=None, *, limit=100000000):
    if (
        kind not in ("artist", "release-group", "recording", "release")
        or not 1 <= limit <= 1000000000
    ):
        raise ValueError(
            "Select artist/release-group/recording/release and a positive record limit"
        )
    with import_run(store, path, "musicbrainz", kind, stop) as writer:
        if writer.complete:
            return writer.result("complete")
        start = writer.records
        consumed = 0
        total_bytes = 0
        with input_stream(path, kind) as stream:
            ordinal = 0
            while not (stop and stop.is_set()):
                if consumed == limit:
                    return writer.result("limited")
                raw = stream.readline(MAX_LINE_BYTES + 1)
                if not raw:
                    return writer.result("complete")
                ordinal += 1
                total_bytes += len(raw)
                if len(raw) > MAX_LINE_BYTES or total_bytes > MAX_INPUT_BYTES:
                    raise ValueError("MusicBrainz dump exceeds its line/decompressed byte budget")
                if ordinal <= start:
                    continue
                try:
                    discovery = parse(kind, json.loads(raw))
                except (KeyError, TypeError, ValueError) as error:
                    raise ValueError(f"Invalid MusicBrainz {kind} record {ordinal}") from error
                writer.add(discovery, ordinal)
                consumed += 1
        return writer.result("interrupted")
