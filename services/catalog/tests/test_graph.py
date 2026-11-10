from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from catalog.api import create_app
from catalog.graph import artist_network
from test_identity import artist, ingest, link, CHANNEL
from conftest import ARTIST_ID, ALBUM_ID


pytestmark = pytest.mark.integration


def graph(store, **kwargs):
    with store.transaction() as conn:
        return artist_network(conn, **kwargs)


def test_shared_credits_connect_artists_with_evidence_not_matching_names(store, song):
    first = artist("musicbrainz", ARTIST_ID, "First Artist")
    second = artist("musicbrainz", ALBUM_ID, "Second Artist")
    same_name = artist("deezer", "99", "First Artist")
    recording = replace(song, artist_keys=(first.key, second.key))
    ingest(store, first, second, same_name, recording)
    network = graph(store)
    assert len(network["nodes"]) == 3
    assert len(network["edges"]) == 1
    edge = network["edges"][0]
    assert {edge["source"], edge["target"]} == {first.key, second.key}
    assert edge["relation"] == "shared_credit"
    assert edge["evidence"] == [
        {"key": recording.key, "title": recording.title, "kind": "song", "url": recording.url},
    ]
    assert edge["evidence_count"] == 1


def test_connections_cross_verified_identities_but_identity_is_not_collaboration(store, song):
    first = artist("musicbrainz", ARTIST_ID)
    second = artist("musicbrainz", ALBUM_ID)
    alias = artist("deezer", "27")
    video_alias = artist("ytmusic", CHANNEL)
    ingest(store, first, second, alias, video_alias)
    link(store, first, "deezer", "27")
    link(store, first, "ytmusic", CHANNEL)
    assert graph(store)["edges"] == []
    recording = replace(song, artist_keys=(alias.key, second.key))
    ingest(store, recording)
    network = graph(store, key=video_alias.key)
    assert len(network["nodes"]) == 2
    assert len(network["edges"]) == 1
    grouped = next(node for node in network["nodes"] if len(node["sources"]) > 1)
    assert set(grouped["sources"]) == {"musicbrainz", "deezer", "ytmusic"}
    assert network["focus"] == grouped["key"]


def test_pages_cover_stored_artists_not_just_recent_records_and_search_all(store):
    records = [artist("deezer", str(i), f"Fictional Artist {i}") for i in range(1, 33)]
    ingest(store, *records)
    found = set()
    after = ""
    while True:
        page = graph(store, after=after, limit=7)
        keys = {node["key"] for node in page["nodes"]}
        assert not found.intersection(keys)
        found.update(keys)
        if not page["next"]:
            break
        after = page["next"]
    assert found == {record.key for record in records}
    page = graph(store, query="Fictional Artist 32")
    assert [node["key"] for node in page["nodes"]] == [records[-1].key]
    assert graph(store, query="Nonexistent")["nodes"] == []


def test_focus_credit_pages_expose_connections_after_initial_slice(store, song):
    first = artist("musicbrainz", ARTIST_ID)
    second = artist("musicbrainz", ALBUM_ID)
    ingest(store, first, second)
    records = [
        replace(
            song,
            key=f"fixture-{i:03d}",
            artist_keys=(first.key,) if i < 50 else (first.key, second.key),
        )
        for i in range(53)
    ]
    ingest(store, *records)
    overview = graph(store)
    assert overview["limits"]["overview_credits"]
    page = graph(store, key=first.key)
    assert page["edges"] == []
    assert page["next"] == "fixture-049"
    page = graph(store, key=first.key, after=page["next"])
    assert len(page["edges"]) == 1
    assert page["edges"][0]["evidence_count"] == 3
    assert page["next"] is None


def test_missing_artist_records_and_same_identity_do_not_fabricate_connections(store, song):
    first = artist("musicbrainz", ARTIST_ID)
    alias = artist("deezer", "27")
    ingest(store, first, alias)
    link(store, first, "deezer", "27")
    missing = f"musicbrainz:global:artist:{ALBUM_ID}"
    ingest(store, replace(song, artist_keys=(first.key, alias.key, missing)))
    result = graph(store, key=first.key)
    assert len(result["nodes"]) == 1
    assert result["edges"] == []


def test_graph_evidence_has_per_record_and_response_bounds(store, song):
    records = [artist("deezer", str(i)) for i in range(1, 24)]
    ingest(store, *records)
    ingest(store, replace(song, artist_keys=tuple(record.key for record in records)))
    result = graph(store, key=records[0].key)
    assert len(result["nodes"]) == 21
    assert len(result["edges"]) == 20
    assert result["limits"]["record_artists"]
    assert result["truncated"]


def test_evidence_records_are_bounded_and_albums_are_labeled_honestly(store, song):
    first = artist("musicbrainz", ARTIST_ID)
    second = artist("musicbrainz", ALBUM_ID)
    ingest(store, first, second)
    ingest(
        store,
        *[
            replace(
                song,
                key=f"fixture-{i}",
                kind="album" if i == 0 else "song",
                artist_keys=(first.key, second.key),
            )
            for i in range(8)
        ],
    )
    result = graph(store, key=first.key)
    edge = result["edges"][0]
    assert edge["evidence_count"] == 8
    assert len(edge["evidence"]) == 5
    assert edge["evidence_truncated"]
    assert edge["evidence"][0]["kind"] == "album"


def test_graph_endpoint_filters_validation_and_missing_artist(store, vectors, embeddings, song):
    first = artist("musicbrainz", ARTIST_ID, "<script>not executable</script>")
    ingest(store, first, song)
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        response = client.get("/v1/console/artist-network")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json()["nodes"][0]["title"] == first.title
        assert client.get("/v1/console/artist-network", params={"key": song.key}).status_code == 404
        assert (
            client.get("/v1/console/artist-network", params={"key": "missing"}).status_code == 404
        )
        for params in ({"limit": 0}, {"limit": 21}, {"q": "x" * 101}, {"after": "x" * 301}):
            assert client.get("/v1/console/artist-network", params=params).status_code == 422


def test_large_neighborhood_is_capped_with_no_dangling_links(store, song):
    records = [artist("deezer", str(i)) for i in range(1, 202)]
    ingest(store, *records)
    ingest(
        store,
        *[
            replace(
                song,
                key=f"large-{i:03d}",
                artist_keys=tuple(
                    [records[0].key] + [record.key for record in records[1 + i * 20 : 21 + i * 20]]
                ),
            )
            for i in range(10)
        ],
    )
    result = graph(store, key=records[0].key)
    assert len(result["nodes"]) == 180
    assert len(result["edges"]) <= 400
    assert result["limits"]["view_capacity"]
    keys = {node["key"] for node in result["nodes"]}
    assert all(edge["source"] in keys and edge["target"] in keys for edge in result["edges"])
