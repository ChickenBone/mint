import io
import json
import shutil
import subprocess
import tarfile
from dataclasses import replace
from threading import Event

import pytest

from catalog.bulk_import import import_run
from catalog.model import entity_key
from catalog.musicbrainz_import import import_musicbrainz, parse
from catalog.omdb_import import copy_rows, import_omdb, parse as parse_omdb, unescape


ARTIST = "00000000-0000-4000-8000-000000000001"
ALBUM = "00000000-0000-4000-8000-000000000002"
SONG = "00000000-0000-4000-8000-000000000003"


def artist(number=1):
    return {
        "id": f"00000000-0000-4000-8000-{number:012d}",
        "name": f"Fixture Artist {number}",
        "genres": [{"name": "Electronic"}],
        "annotation": "Not retained",
        "tags": [{"name": "not a genre"}],
    }


def archive(tmp_path, kind, rows):
    path = tmp_path / f"{kind}.tar.xz"
    payload = b"".join(json.dumps(row).encode() + b"\n" for row in rows)
    with tarfile.open(path, "w:xz") as output:
        info = tarfile.TarInfo(f"mbdump/{kind}")
        info.size = len(payload)
        output.addfile(info, io.BytesIO(payload))
    return path


def release(album=ALBUM):
    return {
        "id": "00000000-0000-4000-8000-000000000004",
        "title": "Edition is not a release group",
        "release-group": {
            "id": album,
            "title": "Fixture Album",
            "genres": [{"name": "Rock"}],
        },
        "artist-credit": [{"artist": {"id": ARTIST, "name": "Fixture Artist"}}],
        "media": [
            {
                "tracks": [
                    {
                        "title": "Edition track title",
                        "recording": {
                            "id": SONG,
                            "title": "Fixture Recording",
                            "artist-credit": [{"artist": {"id": ARTIST, "name": "Fixture Artist"}}],
                        },
                    }
                ]
            }
        ],
    }


def test_release_dump_extracts_recording_ids_and_release_group_membership():
    result = parse("release", release())
    assert [item.kind for item in result.entities] == ["album", "song"]
    assert result.entities[1].album_keys == (entity_key("global", "album", ALBUM, "musicbrainz"),)
    assert result.entities[1].artist_keys == (
        entity_key("global", "artist", ARTIST, "musicbrainz"),
    )
    assert result.entities[0].genres == ("Rock",)
    assert result.annotations[0][1]["genre_data_license"] == "CC-BY-NC-SA-3.0"
    assert not result.jobs and not result.ranked


def test_dump_large_genre_lists_preserve_full_attribution_without_crawler_budget_changes():
    row = {**artist(), "genres": [{"name": f"Genre {i}"} for i in range(102)]}
    result = parse("artist", row)
    assert len(result.entities[0].genres) == 20
    annotation = result.annotations[0][1]
    assert annotation["genre_count"] == 102 and annotation["genres_truncated"]
    assert len(annotation["all_genres"]) == 102
    from catalog.model import musicbrainz_entity

    with pytest.raises(ValueError, match="genre budget"):
        musicbrainz_entity("artist", row)


def test_snapshot_long_names_are_preserved_without_expanding_live_api_budgets():
    row = {**artist(), "name": "a" * 1018}
    assert parse("artist", row).entities[0].title == row["name"]
    from catalog.model import musicbrainz_entity

    with pytest.raises(ValueError, match="text"):
        musicbrainz_entity("artist", row)


@pytest.mark.integration
def test_snapshot_recording_links_and_length_are_retained_without_network_jobs(store, tmp_path):
    row = {
        "id": SONG,
        "title": "Fixture",
        "length": 180000,
        "relations": [{"url": {"resource": "https://www.deezer.com/track/123"}}],
    }
    path = archive(tmp_path, "recording", [row])
    assert import_musicbrainz(store, path, "recording")["status"] == "complete"
    with store.transaction() as conn:
        assert conn.execute("SELECT count(*) AS n FROM jobs").fetchone()["n"] == 0
        assert conn.execute("SELECT provider,identifier FROM entity_links").fetchone() == {
            "provider": "deezer",
            "identifier": "123",
        }
        assert (
            conn.execute("SELECT metadata FROM entity_annotations").fetchone()["metadata"][
                "duration_ms"
            ]
            == 180000
        )


@pytest.mark.integration
def test_musicbrainz_archive_resume_and_source_license_preserve_metadata(store, tmp_path):
    path = archive(tmp_path, "artist", [artist(n) for n in range(1, 6)])
    first = import_musicbrainz(store, path, "artist", limit=2)
    assert first["records"] == first["observations"] == 2
    assert first["status"] == "limited"
    second = import_musicbrainz(store, path, "artist")
    assert second["import_id"] == first["import_id"]
    assert second["records"] == second["observations"] == 5
    assert second["status"] == "complete"
    assert import_musicbrainz(store, path, "artist") == second
    with store.transaction() as conn:
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 5
        assert conn.execute("SELECT count(*) AS n FROM jobs").fetchone()["n"] == 0
        assert conn.execute("SELECT count(*) AS n FROM vector_outbox").fetchone()["n"] == 5
        assert conn.execute("SELECT count(*) AS n FROM canonical_artists").fetchone()["n"] == 5
        annotation = conn.execute("SELECT metadata FROM entity_annotations LIMIT 1").fetchone()[
            "metadata"
        ]
        assert annotation["core_data_license"] == "CC0-1.0"
        assert "Not retained" not in json.dumps(annotation)


@pytest.mark.integration
def test_release_import_keeps_recording_membership_across_multiple_albums(store, tmp_path):
    other = "00000000-0000-4000-8000-000000000009"
    path = archive(tmp_path, "release", [release(), release(other)])
    result = import_musicbrainz(store, path, "release")
    assert result["records"] == 2 and result["observations"] == 4
    with store.transaction() as conn:
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM edges WHERE source=%s AND relation='album'",
                (entity_key("global", "song", SONG, "musicbrainz"),),
            ).fetchone()["n"]
            == 2
        )
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 3


@pytest.mark.integration
def test_checkpoint_rolls_back_with_capacity_failure(store, tmp_path):
    path = archive(tmp_path, "artist", [artist(n) for n in range(1, 4)])
    store.settings = replace(store.settings, max_entities=2)
    with pytest.raises(ValueError, match="capacity"):
        import_musicbrainz(store, path, "artist")
    with store.transaction() as conn:
        assert conn.execute("SELECT records,observations FROM import_runs").fetchone() == {
            "records": 0,
            "observations": 0,
        }
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 0
    store.settings = replace(store.settings, max_entities=10)
    assert import_musicbrainz(store, path, "artist")["records"] == 3


@pytest.mark.integration
def test_identical_snapshots_cannot_run_concurrently(store, tmp_path):
    path = archive(tmp_path, "artist", [artist()])
    with import_run(store, path, "musicbrainz", "artist"):
        with pytest.raises(ValueError, match="already being imported"):
            with import_run(store, path, "musicbrainz", "artist"):
                pass
    assert import_musicbrainz(store, path, "artist")["records"] == 1


@pytest.mark.integration
def test_interrupted_import_resumes_after_last_committed_batch(store, tmp_path, monkeypatch):
    from catalog.bulk_import import BulkWriter

    path = archive(tmp_path, "artist", [artist(n) for n in range(1, 6)])
    stop = Event()
    original = BulkWriter.add

    def interrupt(self, discovery, record):
        original(self, discovery, record)
        if record == 2:
            stop.set()

    monkeypatch.setattr(BulkWriter, "add", interrupt)
    assert import_musicbrainz(store, path, "artist", stop)["status"] == "interrupted"
    monkeypatch.setattr(BulkWriter, "add", original)
    assert import_musicbrainz(store, path, "artist")["records"] == 5


@pytest.mark.integration
def test_invalid_musicbrainz_input_fails_without_advancing_checkpoint(store, tmp_path):
    path = archive(tmp_path, "artist", [{"id": ARTIST}])
    with pytest.raises(ValueError, match="record 1"):
        import_musicbrainz(store, path, "artist")
    with store.transaction() as conn:
        assert conn.execute("SELECT records FROM import_runs").fetchone()["records"] == 0


@pytest.mark.integration
def test_archive_links_and_missing_member_are_rejected(store, tmp_path):
    path = tmp_path / "bad.tar.xz"
    with tarfile.open(path, "w:xz") as output:
        info = tarfile.TarInfo("mbdump/artist")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/passwd"
        output.addfile(info)
    with pytest.raises(ValueError, match="archive member"):
        import_musicbrainz(store, path, "artist")
    path = archive(tmp_path, "artist", [artist()])
    with pytest.raises(ValueError, match="no mbdump"):
        import_musicbrainz(store, path, "recording")


@pytest.mark.integration
def test_musicbrainz_line_budget_is_enforced(store, tmp_path, monkeypatch):
    monkeypatch.setattr("catalog.musicbrainz_import.MAX_LINE_BYTES", 10)
    path = archive(tmp_path, "artist", [artist()])
    with pytest.raises(ValueError, match="byte budget"):
        import_musicbrainz(store, path, "artist")


def test_omdb_copy_escapes_do_not_become_sql():
    assert unescape(r"Artist\tName\n\\N") == "Artist\tName\n\\N"
    assert unescape(r"\N") is None
    assert unescape(r"semi; DROP DATABASE ignored;") == "semi; DROP DATABASE ignored;"
    assert unescape(r"\101") == "A"
    result = parse_omdb(
        "song",
        {
            "id": "record1",
            "title": "Fixture",
            "album": "album1",
            "views": "123",
            "audio_live": "private-audio",
            "playback_clean": "42",
            "mxid": "private-id",
        },
    )
    assert result.entities[0].source == "omdb"
    assert result.entities[0].album_keys == ("omdb:global:album:album1",)
    assert result.metrics[0][1:] == ("omdb_views", 123)
    assert "private-" not in repr(result)


@pytest.mark.integration
def test_real_omdb_postgres_tar_copy_import_never_executes_dump_schema(store, tmp_path):
    if not shutil.which("pg_dump") or not shutil.which("pg_restore"):
        pytest.skip("Install PostgreSQL client tools for a real archive compatibility check")
    with store.transaction() as conn:
        conn.execute(
            'CREATE TABLE "Artists" ("ID" text, "Name" text, "Profile_Photo" text, "Subscribers" int)'
        )
        conn.execute('CREATE TABLE "Albums" ("ID" text, "Title" text, "Artwork" text)')
        conn.execute(
            'CREATE TABLE "Tracks" ("ID" text, "Title" text, "Album" text, "Views" int, "Audio_Live" text)'
        )
        conn.execute('CREATE TABLE "Artist_Album" ("Artist_ID" text, "Album_ID" text)')
        conn.execute('CREATE TABLE "Artist_Track" ("Artist_ID" text, "Track_ID" text)')
        conn.execute('CREATE TABLE "Features_Track" ("Artist_ID" text, "Track_ID" text)')
        conn.execute(
            'INSERT INTO "Artists" VALUES (%s,%s,%s,%s)',
            ("artist1", "Artist\tName", "private-image", 99),
        )
        conn.execute(
            'INSERT INTO "Albums" VALUES (%s,%s,%s)', ("album1", "Fixture Album", "private-image")
        )
        conn.execute(
            'INSERT INTO "Tracks" VALUES (%s,%s,%s,%s,%s)',
            ("song1", "Fixture Track", "album1", 123, "private-audio"),
        )
        for table, target in (
            ("Artist_Album", "album1"),
            ("Artist_Track", "song1"),
            ("Features_Track", "song1"),
        ):
            from psycopg import sql

            conn.execute(
                sql.SQL("INSERT INTO {} VALUES (%s,%s)").format(sql.Identifier(table)),
                ("artist1", target),
            )
    path = tmp_path / "omdb.tar"
    command = [
        "pg_dump",
        "--dbname",
        store.settings.database_url,
        "--format=tar",
        "--file",
        str(path),
    ]
    for table in ("Artists", "Albums", "Tracks", "Artist_Album", "Artist_Track", "Features_Track"):
        command.extend(["--table", f'public."{table}"'])
    subprocess.run(command, check=True, capture_output=True)
    with copy_rows(path, "Artists") as rows:
        assert next(rows)["name"] == "Artist\tName"
    with store.transaction() as conn:
        for table in (
            "Artists",
            "Albums",
            "Tracks",
            "Artist_Album",
            "Artist_Track",
            "Features_Track",
        ):
            from psycopg import sql

            conn.execute(sql.SQL("DROP TABLE {}").format(sql.Identifier(table)))
    for kind in ("artist", "album", "song", "album-artists", "song-artists", "song-features"):
        assert import_omdb(store, path, kind)["status"] == "complete"
    with store.transaction() as conn:
        assert (
            conn.execute("SELECT count(*) AS n FROM entities WHERE source='omdb'").fetchone()["n"]
            == 3
        )
        assert conn.execute("SELECT count(*) AS n FROM edges").fetchone()["n"] == 3
        assert conn.execute("SELECT count(*) AS n FROM jobs").fetchone()["n"] == 0
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM import_runs WHERE status='complete'"
            ).fetchone()["n"]
            == 6
        )
        assert conn.execute("SELECT to_regclass('public.\"Artists\"') AS t").fetchone()["t"] is None
        assert "private-" not in json.dumps(
            conn.execute("SELECT document FROM entities").fetchall()
        )
