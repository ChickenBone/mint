from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from catalog.api import create_app
from catalog.catalog_network import catalog_network, genre_key
from test_identity import artist, ingest, link
from conftest import ARTIST_ID


pytestmark = pytest.mark.integration


def graph(store, **kwargs):
    with store.transaction() as conn:
        return catalog_network(conn, **kwargs)


def record(song, identifier, kind="song", **kwargs):
    return replace(
        song,
        key=f"deezer:global:{kind}:{identifier}",
        provider_id=str(identifier),
        country="global",
        source="deezer",
        origin="deezer",
        kind=kind,
        url=f"https://example.org/{kind}/{identifier}",
        artist_keys=(),
        album_keys=(),
        **kwargs,
    )


def test_mixed_graph_connects_four_kinds_through_stored_edges_and_source_tags(store, song):
    performer = replace(artist("deezer", "1", "Synthetic Artist"), genres=(" Electronic ",))
    album = record(song, 2, "album", genres=("electronic",))
    track = replace(
        record(song, 3, title="Synthetic Song", genres=("Electronic", "Ambient")),
        artist_keys=(performer.key, "deezer:global:artist:999"),
        album_keys=(album.key,),
    )
    ingest(store, performer, album, track)
    result = graph(store)
    assert {node["kind"] for node in result["nodes"]} == {"artist", "song", "album", "genre"}
    genres = [node for node in result["nodes"] if node["kind"] == "genre"]
    assert {node["title"] for node in genres} == {"electronic", "ambient"}
    assert all(node["derived"] for node in genres)
    relationships = {(edge["source"], edge["target"], edge["relation"]) for edge in result["edges"]}
    assert (track.key, performer.key, "artist") in relationships
    assert (track.key, album.key, "album") in relationships
    assert (track.key, genre_key("electronic"), "genre") in relationships
    assert not any(node["key"].endswith(":999") for node in result["nodes"])
    assert all(
        edge["evidence"][0]["url"].startswith("https://example.org")
        or edge["evidence"][0]["url"] == performer.url
        for edge in result["edges"]
    )
    assert all(edge["relation"] != "shared_credit" for edge in result["edges"])


def test_artist_focus_expands_verified_alias_credits_and_retains_record_evidence(store, song):
    performer = artist("musicbrainz", ARTIST_ID, "Synthetic Artist")
    alias = artist("deezer", "27", "Synthetic Artist")
    track = replace(record(song, 3), artist_keys=(alias.key,))
    ingest(store, performer, alias, track)
    link(store, performer, "deezer", "27")
    result = graph(store, key=performer.key)
    assert len([node for node in result["nodes"] if node["kind"] == "artist"]) == 1
    representative = next(node for node in result["nodes"] if node["kind"] == "artist")
    assert set(representative["sources"]) == {"musicbrainz", "deezer"}
    edge = next(edge for edge in result["edges"] if edge["relation"] == "artist")
    assert edge["target"] == representative["key"]
    assert edge["evidence"][0]["key"] == track.key
    assert result["focus"] == representative["key"]


def test_catalog_root_pages_balance_kinds_and_advance_independent_keysets(store, song):
    records = [
        record(song, i, kind, genres=())
        for kind in ("artist", "album", "song")
        for i in range(1, 5)
    ]
    ingest(store, *records)
    found = set()
    after = ""
    for _ in range(4):
        page = graph(store, limit=1, after=after)
        assert {node["kind"] for node in page["nodes"]} == {"artist", "album", "song"}
        keys = {node["key"] for node in page["nodes"]}
        assert not found.intersection(keys)
        found.update(keys)
        after = page["next"]
    assert after is None
    assert found == {row.key for row in records}
    assert graph(store, query="Absent Label")["nodes"] == []


def test_genre_expansion_matches_explicit_normalized_tags_and_pages_without_fabrication(
    store, song
):
    records = [record(song, i, genres=(" New   Wave ",)) for i in range(1, 66)]
    ingest(store, *records)
    first = graph(store, key=genre_key("new wave"))
    assert first["focus"] == genre_key("new wave")
    assert first["next"]
    second = graph(store, key=first["focus"], after=first["next"])
    assert second["next"] is None
    first_keys = {node["key"] for node in first["nodes"] if node["kind"] == "song"}
    second_keys = {node["key"] for node in second["nodes"] if node["kind"] == "song"}
    assert not first_keys.intersection(second_keys)
    assert first_keys | second_keys == {row.key for row in records}
    assert all(edge["target"] == genre_key("new wave") for edge in first["edges"])


def test_entity_neighbor_pages_include_loaded_album_and_artist_targets(store, song):
    performer = artist("deezer", "1")
    album = record(song, 2, "album")
    tracks = [
        replace(record(song, 100 + i), artist_keys=(performer.key,), album_keys=(album.key,))
        for i in range(65)
    ]
    ingest(store, performer, album, *tracks)
    page = graph(store, key=performer.key)
    assert page["limits"]["neighbors"]
    assert album.key in {node["key"] for node in page["nodes"]}
    next_page = graph(store, key=performer.key, after=page["next"])
    assert next_page["next"] is None
    loaded = {node["key"] for node in page["nodes"] + next_page["nodes"]}
    assert {row.key for row in tracks} <= loaded


def test_mixed_graph_caps_tags_and_edges_without_dangling_endpoints(store, song):
    performer = artist("deezer", "1")
    tracks = [
        replace(
            record(song, 100 + i, genres=tuple(f"Tag {i} {j}" for j in range(20))),
            artist_keys=(performer.key,),
        )
        for i in range(65)
    ]
    ingest(store, performer, *tracks)
    result = graph(store, key=performer.key)
    assert result["truncated"]
    assert result["limits"]["genres"]
    assert len(result["nodes"]) <= 180
    assert len(result["edges"]) <= 400
    keys = {node["key"] for node in result["nodes"]}
    assert all(edge["source"] in keys and edge["target"] in keys for edge in result["edges"])


def test_catalog_graph_endpoint_validates_inputs_and_does_not_create_unknown_genres(
    store,
    vectors,
    embeddings,
    song,
):
    ingest(store, record(song, 1, genres=("Ambient",)))
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        response = client.get("/v1/console/catalog-network")
        assert response.status_code == 200
        assert response.json()["scope"] == "catalog"
        assert "no-store" in response.headers["cache-control"]
        assert (
            client.get("/v1/console/catalog-network", params={"key": "missing"}).status_code == 404
        )
        assert (
            client.get("/v1/console/catalog-network", params={"key": "genre:unknown"}).status_code
            == 404
        )
        assert (
            client.get("/v1/console/catalog-network", params={"key": "genre:%FF"}).status_code
            == 400
        )
        assert (
            client.get("/v1/console/catalog-network", params={"after": "not-a-cursor"}).status_code
            == 400
        )
        for params in (
            {"limit": 0},
            {"limit": 21},
            {"key": "x" * 1301},
            {"after": "x" * 1001},
            {"q": "x" * 101},
        ):
            assert client.get("/v1/console/catalog-network", params=params).status_code == 422
