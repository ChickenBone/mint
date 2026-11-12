from dataclasses import replace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from catalog.api import create_app
from catalog.bridge import create_bridge, tls_files
from catalog.model import entity_key, musicbrainz_entity
from catalog.ranker import refresh_batch
from conftest import ALBUM_ID, ARTIST_ID, SONG_ID


TOKEN = "fixture-token-not-a-real-secret-1234567890"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def test_bridge_tls_requires_both_files(monkeypatch):
    monkeypatch.delenv("CATALOG_BRIDGE_TLS_CERT", raising=False)
    monkeypatch.delenv("CATALOG_BRIDGE_TLS_KEY", raising=False)
    assert tls_files() == {}
    monkeypatch.setenv("CATALOG_BRIDGE_TLS_CERT", "/fixture/cert")
    with pytest.raises(ValueError):
        tls_files()
    monkeypatch.setenv("CATALOG_BRIDGE_TLS_KEY", "/fixture/key")
    assert tls_files() == {"ssl_certfile": "/fixture/cert", "ssl_keyfile": "/fixture/key"}


def test_bridge_is_separate_authenticated_and_bounds_inputs(settings):
    with pytest.raises(ValueError):
        create_bridge(settings, "short", MagicMock())
    with TestClient(create_bridge(settings, TOKEN, MagicMock())) as client:
        assert client.get(f"/v1/artists/{ARTIST_ID}/albums").status_code == 401
        assert client.get("/v1/console", headers=AUTH).status_code == 404
        assert client.post("/v1/priority/artists", headers=AUTH, json={}).status_code == 422
        assert client.post(
            "/v1/priority/artists", headers=AUTH,
            json={"add": [ARTIST_ID], "remove": [ARTIST_ID]},
        ).status_code == 422
        assert client.post(
            "/v1/priority/artists", headers=AUTH,
            json={"add": [str(i) for i in range(101)]},
        ).status_code == 422
        assert client.post(
            "/v1/priority/artists", headers=AUTH, content=b"x" * 16385,
        ).status_code == 413
        assert client.get(f"/v1/artists/{ARTIST_ID}/albums?limit=101", headers=AUTH).status_code == 422


@pytest.mark.integration
def test_bridge_paginates_explicit_musicbrainz_relationships_and_priority_is_idempotent(
    settings, store
):
    artist = musicbrainz_entity("artist", {"id": ARTIST_ID, "name": "Artist"})
    album = musicbrainz_entity("album", {
        "id": ALBUM_ID, "title": "Album",
        "artist-credit": [{"artist": {"id": ARTIST_ID, "name": "Artist"}}],
    })
    second_id = "00000000-0000-4000-8000-000000000004"
    songs = [
        musicbrainz_entity("song", {
            "id": song_id, "title": f"Song {song_id}",
            "releases": [{"release-group": {"id": ALBUM_ID}}],
        })
        for song_id in (SONG_ID, second_id)
    ]
    with store.transaction() as conn:
        store.ingest(conn, [artist, album, *songs], schedule=False)
    with TestClient(create_bridge(settings, TOKEN, store)) as client:
        albums = client.get(f"/v1/artists/{ARTIST_ID}/albums", headers=AUTH)
        assert albums.status_code == 200 and albums.headers["cache-control"] == "no-store"
        assert albums.json()["items"][0]["id"] == ALBUM_ID
        first = client.get(f"/v1/albums/{ALBUM_ID}/recordings?limit=1", headers=AUTH).json()
        assert first["items"][0]["id"] == SONG_ID and first["next_cursor"] == SONG_ID
        second = client.get(
            f"/v1/albums/{ALBUM_ID}/recordings?limit=1&after={SONG_ID}", headers=AUTH
        ).json()
        assert second["items"][0]["id"] == second_id and second["next_cursor"] is None
        assert client.get(f"/v1/artists/{second_id}/albums", headers=AUTH).status_code == 404
        assert client.get("/v1/artists/invalid/albums", headers=AUTH).status_code == 422
        path = "/v1/priority/artists"
        assert client.post(path, headers=AUTH, json={"add": [ARTIST_ID]}).json() == {
            "added": 1, "removed": 0
        }
        assert client.post(path, headers=AUTH, json={"add": [ARTIST_ID]}).json() == {
            "added": 0, "removed": 0
        }
        assert client.post(path, headers=AUTH, json={"remove": [ARTIST_ID]}).json() == {
            "added": 0, "removed": 1
        }
    with store.transaction() as conn:
        assert conn.execute(
            "SELECT count(*) AS n FROM priority_artists WHERE entity_key=%s",
            (entity_key("global", "artist", ARTIST_ID, "musicbrainz"),),
        ).fetchone()["n"] == 0


@pytest.mark.integration
def test_bridge_and_demand_remain_independent_with_one_catalog(store):
    demand_token = "separate-demand-token-for-fixture-1234567890"
    store.settings = replace(store.settings, demand_token=demand_token)
    artist = musicbrainz_entity("artist", {"id": ARTIST_ID, "name": "Artist"})
    album = musicbrainz_entity("album", {
        "id": ALBUM_ID, "title": "Album",
        "artist-credit": [{"artist": {"id": ARTIST_ID, "name": "Artist"}}],
    })
    with store.transaction() as conn:
        store.ingest(conn, [artist, album], schedule=False)

    demand_auth = {"Authorization": f"Bearer {demand_token}"}
    batch = {"signals": [{"type": "album", "title": "Album", "artist": "Artist"}]}
    with (
        TestClient(create_bridge(store.settings, TOKEN, store)) as bridge,
        TestClient(create_app(store.settings, store, MagicMock(), MagicMock())) as consumer,
    ):
        assert bridge.post(
            "/v1/priority/artists", headers=demand_auth, json={"add": [ARTIST_ID]}
        ).status_code == 401
        assert consumer.post("/v1/demand", headers=AUTH, json=batch).status_code == 401
        assert bridge.post(
            "/v1/priority/artists", headers=AUTH, json={"add": [ARTIST_ID]}
        ).json() == {"added": 1, "removed": 0}
        assert consumer.post("/v1/demand", headers=demand_auth, json=batch).status_code == 202
        assert bridge.get(f"/v1/artists/{ARTIST_ID}/albums", headers=AUTH).json()["items"][0][
            "id"
        ] == ALBUM_ID
        assert bridge.post(
            "/v1/priority/artists", headers=AUTH, json={"remove": [ARTIST_ID]}
        ).json() == {"added": 0, "removed": 1}
    refresh_batch(store)
    with store.transaction() as conn:
        assert conn.execute(
            "SELECT priority,demand_priority FROM jobs WHERE task='mb-lookup' AND entity_key=%s",
            (album.key,),
        ).fetchone() == {"priority": 90, "demand_priority": 90}
