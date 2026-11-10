from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from catalog.api import create_app
from catalog.identity import artist_groups, rebuild_artists
from catalog.indexer import index_batch
from catalog.model import Entity, entity_key
from catalog.providers import external_identity
from catalog.youtube import Discovery
from conftest import ARTIST_ID, ALBUM_ID


pytestmark = pytest.mark.integration
CHANNEL = "UC" + "a" * 22


def artist(source, identifier, title="Shared Artist", country="global"):
    return Entity(
        key=entity_key(country, "artist", identifier, source),
        country=country,
        kind="artist",
        provider_id=identifier,
        title=title,
        artist=title,
        album="",
        genres=(),
        url=f"https://example.org/{source}/{identifier}",
        source=source,
        origin=source,
    )


def link(store, record, source, identifier, kind="artist"):
    with store.transaction() as conn:
        store.public_observations(
            conn,
            Discovery(
                [],
                [],
                [],
                [],
                links=[(record.key, source, kind, identifier, f"https://example.org/{identifier}")],
            ),
        )


def ingest(store, *records):
    with store.transaction() as conn:
        store.ingest(conn, list(records))


def test_same_names_remain_distinct_until_explicit_evidence(store, vectors, embeddings):
    mb = artist("musicbrainz", ARTIST_ID)
    deezer = artist("deezer", "27")
    yt = artist("ytmusic", CHANNEL)
    ingest(store, mb, deezer, yt)
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        params = {"q": "Shared Artist", "kind": "artist", "mode": "lexical"}
        assert len(client.get("/v1/search", params=params).json()["results"]) == 3
        link(store, mb, "deezer", "27")
        link(store, mb, "ytmusic", CHANNEL)
        result = client.get("/v1/search", params=params).json()
        assert len(result["results"]) == 1
        assert {provider["source"] for provider in result["results"][0]["providers"]} == {
            "musicbrainz",
            "deezer",
            "ytmusic",
        }
        assert result["has_more"] is False
        detail = client.get(f"/v1/entities/{deezer.key}").json()
        assert len(detail["providers"]) == 3
        assert detail["canonical_id"] == result["results"][0]["canonical_id"]
        raw = client.get("/v1/search", params={**params, "group_artists": False}).json()
        assert len(raw["results"]) == 3
        filtered = client.get("/v1/search", params={**params, "source": "ytmusic"}).json()
        assert filtered["results"][0]["key"] == yt.key
        assert len(filtered["results"][0]["providers"]) == 3
    with store.transaction() as conn:
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 3
        assert conn.execute("SELECT count(*) AS n FROM vector_outbox").fetchone()["n"] == 3


def test_transitive_evidence_handles_links_before_target_import(store):
    mb = artist("musicbrainz", ARTIST_ID)
    wiki = artist("wikidata", "Q123")
    ingest(store, mb, wiki)
    link(store, mb, "deezer", "27")
    link(store, wiki, "musicbrainz", ARTIST_ID)
    link(store, wiki, "ytmusic", CHANNEL)
    yt = artist("ytmusic", CHANNEL, "Different upstream spelling")
    deezer = artist("deezer", "27")
    ingest(store, yt, deezer)
    with store.transaction() as conn:
        groups = artist_groups(conn, [yt.key, deezer.key])
        assert groups[yt.key]["canonical_id"] == groups[deezer.key]["canonical_id"]
        assert len(groups[yt.key]["providers"]) == 4


def test_conflicting_same_provider_ids_are_not_auto_merged(store):
    mb = artist("musicbrainz", ARTIST_ID)
    other = artist("musicbrainz", ALBUM_ID)
    deezer = artist("deezer", "27")
    ingest(store, mb, other, deezer)
    link(store, mb, "deezer", "27")
    link(store, other, "deezer", "27")
    with store.transaction() as conn:
        groups = artist_groups(conn, [mb.key, other.key])
        assert groups[mb.key]["canonical_id"] != groups[other.key]["canonical_id"]
        assert (
            conn.execute(
                "SELECT canonical_status FROM entity_links WHERE key=%s",
                (other.key,),
            ).fetchone()["canonical_status"]
            == "conflict"
        )


def test_exclusion_and_rebuild_split_groups_without_deleting_source_records(store):
    mb = artist("musicbrainz", ARTIST_ID)
    deezer = artist("deezer", "27")
    ingest(store, mb, deezer)
    link(store, mb, "deezer", "27")
    with store.transaction() as conn:
        conn.execute(
            "UPDATE entity_links SET canonical_status='excluded' WHERE key=%s",
            (mb.key,),
        )
        rebuild_artists(conn)
        rebuild_artists(conn)
        groups = artist_groups(conn, [mb.key, deezer.key])
        assert groups[mb.key]["canonical_id"] != groups[deezer.key]["canonical_id"]
        assert conn.execute("SELECT count(*) AS n FROM entities").fetchone()["n"] == 2
    # A subsequent observation must not silently undo an operator exclusion.
    link(store, mb, "deezer", "27")
    with store.transaction() as conn:
        assert (
            conn.execute(
                "SELECT canonical_status FROM entity_links",
            ).fetchone()["canonical_status"]
            == "excluded"
        )


def test_untrusted_or_non_artist_links_do_not_group_records(store, song):
    deezer = artist("deezer", "27")
    mb = artist("musicbrainz", ARTIST_ID)
    ingest(store, deezer, mb, song)
    link(store, deezer, "musicbrainz", ARTIST_ID)
    link(store, mb, "deezer", "100", kind="album")
    link(store, song, "musicbrainz", ARTIST_ID)
    with store.transaction() as conn:
        groups = artist_groups(conn, [deezer.key, mb.key])
        assert groups[deezer.key]["canonical_id"] != groups[mb.key]["canonical_id"]
        assert len(groups[mb.key]["providers"]) == 1


def test_same_youtube_channel_and_apple_artist_storefronts_share_identity(store):
    records = [
        artist("youtube", CHANNEL),
        artist("ytmusic", CHANNEL),
        artist("apple", "123", country="us"),
        artist("apple", "123", country="gb"),
    ]
    ingest(store, *records)
    with store.transaction() as conn:
        groups = artist_groups(conn, [row.key for row in records])
        assert groups[records[0].key]["canonical_id"] == groups[records[1].key]["canonical_id"]
        assert groups[records[2].key]["canonical_id"] == groups[records[3].key]["canonical_id"]
        assert groups[records[0].key]["canonical_id"] != groups[records[2].key]["canonical_id"]


def test_grouping_happens_before_limit_and_preserves_vector_revision_fencing(
    store,
    vectors,
    embeddings,
):
    mb = artist("musicbrainz", ARTIST_ID)
    deezer = artist("deezer", "27")
    other = artist("deezer", "28")
    ingest(store, mb, deezer, other)
    link(store, mb, "deezer", "27")
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 16))
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        result = client.get("/v1/search", params={"q": "Shared", "limit": 2}).json()
        assert len(result["results"]) == 2
        assert result["has_more"] is False
        result = client.get("/v1/search", params={"q": "Shared", "limit": 1}).json()
        assert result["has_more"] is True
        ingest(store, replace(mb, title="Changed", artist="Changed"))
        ingest(store, replace(deezer, title="Changed", artist="Changed"))
        ingest(store, replace(other, title="Changed", artist="Changed"))
        result = client.get("/v1/search", params={"q": "Shared"}).json()
        assert result["results"] == []


def test_v3_migration_backfills_existing_evidence_and_preserves_vectors(store):
    schema = Path(__file__).parents[1] / "catalog"
    mb = artist("musicbrainz", ARTIST_ID)
    with store.transaction() as conn:
        conn.execute("DROP SCHEMA public CASCADE")
        conn.execute("CREATE SCHEMA public")
        for name in ("schema.sql", "schema-v2.sql", "schema-v3.sql"):
            conn.execute((schema / name).read_text())
        # Use the old schema shape, as the current ingestion needs the v4 mapping.
        conn.execute(
            """INSERT INTO entities(key,source,origin,quality,country,kind,provider_id,
               title,artist,album,genres,url,document,indexed_revision)
               VALUES (%s,'musicbrainz','musicbrainz',1,'global','artist',%s,
               'Shared','Shared','',ARRAY[]::text[],%s,'artist Shared',1)""",
            (mb.key, ARTIST_ID, mb.url),
        )
        conn.execute("UPDATE catalog_budget SET entities=1")
        conn.execute(
            """INSERT INTO entity_links(key,provider,kind,identifier,url)
               VALUES (%s,'deezer','artist','27','https://example.org/deezer/27')""",
            (mb.key,),
        )
    store.migrate()
    store.migrate()
    ingest(store, artist("deezer", "27"))
    with store.transaction() as conn:
        assert conn.execute("SELECT max(version) AS n FROM catalog_schema").fetchone()["n"] == 8
        assert len(artist_groups(conn, [mb.key])[mb.key]["providers"]) == 2
        assert (
            conn.execute(
                "SELECT indexed_revision FROM entities WHERE key=%s",
                (mb.key,),
            ).fetchone()["indexed_revision"]
            == 1
        )


def test_youtube_crosswalk_requires_an_explicit_valid_channel():
    assert external_identity(f"https://www.youtube.com/channel/{CHANNEL}") == (
        "ytmusic",
        "artist",
        CHANNEL,
    )
    for url in (
        "https://www.youtube.com/@SharedArtist",
        "https://www.youtube.com/channel/not-a-channel",
        "https://www.youtube.com.evil.example/channel/" + CHANNEL,
    ):
        assert external_identity(url) is None


def test_reconciliation_cli_refreshes_only_available_evidence_jobs_and_can_undo_links(
    store,
    monkeypatch,
    capsys,
):
    import json
    from catalog import main as cli

    mb = artist("musicbrainz", ARTIST_ID)
    deezer = artist("deezer", "27")
    ingest(store, mb, deezer)
    link(store, mb, "deezer", "27")
    with store.transaction() as conn:
        store.enqueue(conn, "mb-lookup", "global", "artist", ALBUM_ID)
        store.enqueue(conn, "mb-lookup", "global", "artist", "00000000-0000-4000-8000-000000000009")
        conn.execute("UPDATE jobs SET due_at=now()+interval '7 days',ready=false")
        conn.execute(
            "UPDATE jobs SET dead=true WHERE provider_id=%s",
            (ALBUM_ID,),
        )
        conn.execute(
            """UPDATE jobs SET lease_until=now()+interval '1 minute'
               WHERE provider_id='00000000-0000-4000-8000-000000000009'""",
        )
    monkeypatch.setattr(cli.Settings, "load", lambda: store.settings)
    monkeypatch.setattr(cli, "Store", lambda _: store)
    with patch.object(store, "close"):
        monkeypatch.setattr("sys.argv", ["mint-catalog", "reconcile-artists", "--refresh-evidence"])
        cli.main()
        assert json.loads(capsys.readouterr().out)["evidence_jobs_rescheduled"] == 1
        monkeypatch.setattr(
            "sys.argv",
            ["mint-catalog", "exclude-artist-link", mb.key, "deezer", "27"],
        )
        cli.main()
        assert json.loads(capsys.readouterr().out)["status"] == "reconciled"
    with store.transaction() as conn:
        groups = artist_groups(conn, [mb.key, deezer.key])
        assert groups[mb.key]["canonical_id"] != groups[deezer.key]["canonical_id"]


def test_provider_attribution_is_bounded_even_with_many_storefront_rows(store):
    # Raw SQL tests the API's defensive bound beyond configured storefront limits.
    with store.transaction() as conn:
        conn.execute(
            """INSERT INTO entities(key,source,origin,quality,country,kind,provider_id,
               title,artist,album,genres,url,document)
               SELECT 'fixture-'||n,'apple','apple',1,'us','artist','123',
               'Shared','Shared','',ARRAY[]::text[],'https://example.org','artist Shared'
               FROM generate_series(1,105) n"""
        )
        conn.execute(
            """INSERT INTO canonical_artists(identity,canonical_id)
               VALUES ('apple:artist:123','apple:artist:123')"""
        )
        group = artist_groups(conn, ["fixture-1"])["fixture-1"]
        assert len(group["providers"]) == 100
        assert group["providers_truncated"]
