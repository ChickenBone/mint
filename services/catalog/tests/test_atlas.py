import hashlib
from dataclasses import replace
from unittest.mock import patch

import pytest
import psycopg
from fastapi.testclient import TestClient

from catalog.api import create_app
from catalog.atlas import LEAF_SIZE, atlas, group_key
from test_catalog_network import record
from test_identity import artist, ingest


pytestmark = pytest.mark.integration


def graph(store, **kwargs):
    with store.transaction() as conn:
        return atlas(conn, **kwargs)


def test_whole_overview_covers_all_records_and_exact_relationship_counts(store, song):
    performer = artist("deezer", "1")
    album = record(song, 2, "album", genres=("Electronic",))
    tracks = [
        replace(
            record(song, i, genres=(" Electronic ", "electronic", "Ambient")),
            artist_keys=(performer.key, "deezer:global:artist:999"),
            album_keys=(album.key,),
        )
        for i in range(10, 205)
    ]
    ingest(store, performer, album, *tracks)
    result = graph(store)
    assert result["total_records"] == result["represented"] == 197
    groups = [node for node in result["nodes"] if node["kind"] != "genre"]
    assert sum(node["count"] for node in groups) == 197
    assert result["genre_tags"] == 2
    assert result["tag_memberships"] == 391
    assert result["unresolved_links"] == 195
    assert {node["group"]["kind"] for node in groups} == {"artist", "album", "song"}
    edges = {
        edge["relation"]: edge
        for edge in result["edges"]
        if edge["source"] == group_key("deezer", "song")
    }
    assert edges["artist"]["count"] == 195
    assert edges["album"]["count"] == 195
    assert edges["genre"]["count"] == 390
    assert not result.get("truncated")


def test_recursive_groups_cover_every_record_once_without_top_n_truncation(store, song):
    records = [record(song, i) for i in range(1, 202)]
    ingest(store, *records)
    root = graph(store, source="deezer", kind="song")
    assert root["represented"] == len(records)
    assert sum(node["count"] for node in root["nodes"]) == len(records)
    seen = set()
    pending = [node["group"] for node in root["nodes"]]
    while pending:
        page = graph(store, **pending.pop())
        assert page["represented"] > 0
        leaves = [node for node in page["nodes"] if not node.get("group")]
        groups = [node for node in page["nodes"] if node.get("group") and not node.get("context")]
        if groups:
            assert sum(node["count"] for node in groups) == page["represented"]
            pending.extend(node["group"] for node in groups)
        else:
            assert len(leaves) == page["represented"] <= LEAF_SIZE
            keys = {node["key"] for node in leaves}
            assert not seen.intersection(keys)
            seen.update(keys)
    assert seen == {row.key for row in records}


def test_record_leaf_preserves_external_connected_groups_without_dangling_links(store, song):
    performer = artist("deezer", "1")
    tracks = [replace(record(song, i), artist_keys=(performer.key,)) for i in range(10, 20)]
    ingest(store, performer, *tracks)
    result = graph(store, source="deezer", kind="artist")
    assert result["represented"] == 1
    assert next(node for node in result["nodes"] if node.get("context"))["count"] == 10
    assert result["edges"] == [
        {
            "source": group_key("deezer", "song"),
            "target": performer.key,
            "relation": "artist",
            "count": 10,
        }
    ]
    keys = {node["key"] for node in result["nodes"]}
    assert all(edge["source"] in keys and edge["target"] in keys for edge in result["edges"])


def test_genre_groups_cover_all_distinct_normalized_tags(store, song):
    tags = tuple(f"Style {i}" for i in range(90))
    records = [record(song, i + 1, genres=tags[i * 10 : (i + 1) * 10]) for i in range(9)]
    ingest(store, *records)
    overview = graph(store, source="catalog", kind="genre")
    assert overview["represented"] == 90
    assert sum(node["count"] for node in overview["nodes"]) == 90
    leaves = [
        node for group in overview["nodes"] for node in graph(store, **group["group"])["nodes"]
    ]
    assert {node["title"] for node in leaves} == {tag.lower() for tag in tags}
    assert all(node["derived"] for node in leaves)


def test_empty_atlas_and_exact_leaf_boundary(store, song):
    assert graph(store)["nodes"] == []
    assert graph(store)["represented"] == 0
    ingest(store, *[record(song, i) for i in range(1, LEAF_SIZE + 1)])
    result = graph(store, source="deezer", kind="song")
    assert len(result["nodes"]) == LEAF_SIZE
    assert all(not node.get("group") for node in result["nodes"])
    key = result["nodes"][0]["key"]
    prefix = hashlib.md5(key.encode()).hexdigest()
    assert graph(store, source="deezer", kind="song", prefix=prefix)["nodes"][0]["key"] == key


def test_thirty_thousand_record_catalog_is_complete_without_a_large_browser_payload(store, song):
    import json

    ingest(store, artist("deezer", "1"), record(song, 2, "album"))
    with store.transaction() as conn:
        conn.execute(
            """INSERT INTO entities(key,source,origin,quality,country,kind,provider_id,
               title,artist,album,genres,url,document)
               SELECT 'deezer:global:song:'||i,'deezer','deezer',1,'global','song',i::text,
               'Synthetic track '||i,'Synthetic Artist','Synthetic Album',
               ARRAY['Electronic','Ambient'],'https://example.org/song/'||i,
               'song Synthetic track '||i||' Electronic Ambient'
               FROM generate_series(1,30000) i"""
        )
        conn.execute(
            """INSERT INTO edges(source,target,relation)
               SELECT key,'deezer:global:artist:1','artist' FROM entities WHERE kind='song'
               UNION ALL SELECT key,'deezer:global:album:2','album' FROM entities WHERE kind='song'"""
        )
    overview = graph(store)
    assert overview["total_records"] == 30002
    assert sum(node["count"] for node in overview["nodes"] if node["kind"] != "genre") == 30002
    assert overview["unresolved_links"] == 0
    assert overview["tag_memberships"] == 60000
    assert len(json.dumps(overview).encode()) < 10000
    branch = graph(store, source="deezer", kind="song")
    assert sum(node["count"] for node in branch["nodes"]) == 30000
    while any(node.get("group") and not node.get("context") for node in branch["nodes"]):
        selected = max(
            (node for node in branch["nodes"] if node.get("group") and not node.get("context")),
            key=lambda node: node["count"],
        )
        branch = graph(store, **selected["group"])
        if any(node.get("group") and not node.get("context") for node in branch["nodes"]):
            assert sum(node["count"] for node in branch["nodes"]) == branch["represented"]
    assert sum(not node.get("group") for node in branch["nodes"]) == branch["represented"]


def test_atlas_endpoint_validation_and_independent_measured_storage(
    store, vectors, embeddings, song
):
    ingest(store, song)
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        result = client.get("/v1/console/atlas")
        assert result.status_code == 200
        assert result.json()["represented"] == 1
        assert result.headers["cache-control"] == "no-store"
        for params in (
            {"source": "unknown", "kind": "song"},
            {"source": "deezer"},
            {"kind": "song"},
            {"prefix": "a"},
            {"source": "deezer", "kind": "song", "prefix": "x"},
            {"source": "deezer", "kind": "song", "prefix": "a" * 33},
            {"source": "musicbrainz", "kind": "genre"},
        ):
            assert client.get("/v1/console/atlas", params=params).status_code == 422
        with patch.object(
            client.app.state.vectors.client, "get_collection", side_effect=ValueError("Unavailable")
        ) as unavailable:
            storage = client.get("/v1/console/storage")
        unavailable.assert_not_called()
        assert storage.status_code == 200
        data = storage.json()
        assert data["postgres"]["database_bytes"] > 0
        assert data["postgres"]["index_bytes"] > 0
        assert data["postgres"]["queue_bytes"] > 0
        assert data["qdrant"]["disk_bytes"] is None
        assert "WAL" in data["notice"]
        with store.transaction() as conn:
            expected = conn.execute(
                "SELECT pg_database_size(current_database()) AS bytes"
            ).fetchone()["bytes"]
        assert data["postgres"]["database_bytes"] == expected


def test_cached_overview_is_consistent_and_drilldown_is_live(store, vectors, embeddings, song):
    ingest(store, record(song, 1))
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        first = client.get("/v1/console/atlas").json()
        ingest(store, record(song, 2))
        cached = client.get("/v1/console/atlas").json()
        assert first["at"] == cached["at"]
        assert cached["represented"] == 1
        branch = client.get("/v1/console/atlas", params={"source": "deezer", "kind": "song"}).json()
        assert branch["represented"] == 2


def test_storage_failure_is_explicit_and_does_not_break_other_console_reads(
    store, vectors, embeddings
):
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        with patch(
            "catalog.telemetry.storage", side_effect=psycopg.OperationalError("Synthetic failure")
        ):
            assert client.get("/v1/console/storage").status_code == 503
        assert client.get("/v1/console/snapshot").status_code == 200
        assert client.get("/v1/console/atlas").status_code == 200
        assert client.get("/v1/console/storage").status_code == 200


def test_overview_failure_does_not_return_a_success_shaped_empty_catalog(
    store, vectors, embeddings
):
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        with patch(
            "catalog.atlas.atlas", side_effect=psycopg.OperationalError("Synthetic failure")
        ):
            assert client.get("/v1/console/atlas").status_code == 503
        assert client.get("/v1/console/atlas").json()["total_records"] == 0


def test_genre_groups_match_record_explorer_whitespace_normalization(store, song):
    ingest(store, record(song, 1, genres=("\t New \n Wave \t", "new wave", "\n")))
    result = graph(store)
    assert result["genre_tags"] == result["tag_memberships"] == 1
    branch = graph(store, source="catalog", kind="genre")
    assert branch["nodes"][0]["key"] == "genre:new%20wave"
