from dataclasses import replace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from catalog import demand
from catalog.api import create_app
from catalog.sources import lucene_text, request_url
from catalog.store import search_text
from catalog.youtube import parse_ytmusic

CHANNEL = "UC" + "a" * 22
VIDEO = "abcdefghijk"
OTHER = "lmnopqrstuv"
ALBUM = "MPRE" + "b" * 16
TOKEN = "t" * 40
MBID = "00000000-0000-4000-8000-000000000009"
SONG = "00000000-0000-4000-8000-000000000010"


@pytest.fixture
def every_source(settings):
    return replace(settings, ytmusic_enabled=True)


def test_ytmusic_search_and_related_shelves_become_bounded_entities():
    result = parse_ytmusic(
        {"task": "ytm-search", "provider_id": "rnp cordae"},
        {
            "songs": [
                {
                    "resultType": "song",
                    "videoId": VIDEO,
                    "title": "RNP",
                    "artists": [{"id": CHANNEL, "name": "Cordae"}],
                    "album": {"id": ALBUM, "name": "The Lost Boy"},
                },
                {"resultType": "song", "title": "No video"},
                {"resultType": "song", "videoId": "bad", "title": "Bad"},
            ],
            "top": [
                {"resultType": "artist", "browseId": CHANNEL, "artist": "Cordae"},
                {"resultType": "album", "browseId": ALBUM, "title": "The Lost Boy"},
                {"resultType": "podcast", "browseId": "x"},
                {"resultType": "song", "videoId": VIDEO, "title": "RNP"},
            ],
        },
    )
    kinds = sorted((entity.kind, entity.provider_id) for entity in result.entities)
    assert kinds == [("album", ALBUM), ("artist", CHANNEL), ("song", VIDEO)]
    song = next(entity for entity in result.entities if entity.kind == "song")
    assert song.album_keys == (f"ytmusic:global:album:{ALBUM}",)
    related = parse_ytmusic(
        {"task": "ytm-related", "provider_id": VIDEO},
        {"tracks": [{"videoId": OTHER, "title": "Related", "artists": []}]},
    )
    assert [entity.provider_id for entity in related.entities] == [OTHER]
    with pytest.raises(ValueError, match="budget"):
        parse_ytmusic({"task": "ytm-related"}, {"tracks": [{"videoId": VIDEO}] * 51})


def test_search_jobs_use_fixed_endpoints_and_escaped_queries(settings):
    url, params = request_url(
        {"task": "apple-search", "country": "us", "kind": "song", "provider_id": "rnp cordae"},
        settings,
    )
    assert url == "https://itunes.apple.com/search"
    assert params["term"] == "rnp cordae" and params["entity"] == "song"
    url, params = request_url(
        {"task": "mb-search", "country": "global", "kind": "song", "provider_id": 'a:b "c"'},
        settings,
    )
    assert url == "https://musicbrainz.org/ws/2/recording"
    assert params["query"] == lucene_text('a:b "c"') == 'a\\:b \\"c\\"'
    assert search_text("  RNP   Cordae ") == "rnp cordae"
    for bad in ("", "x", "y" * 201):
        with pytest.raises(ValueError):
            search_text(bad)


def test_search_demand_targets_enabled_high_quality_sources(every_source, settings):
    signal = demand.Signal(type="search", query="RNP  Cordae")
    jobs = demand.plan(every_source, signal, lambda *_: [])
    assert {job[0] for job in jobs} == {"ytm-search", "mb-search", "apple-search"}
    assert all(job[3] == "rnp cordae" and job[4] == demand.SEARCH_PRIORITY for job in jobs)
    disabled = replace(settings, apple_enabled=False, musicbrainz_enabled=False)
    assert demand.plan(disabled, signal, lambda *_: []) == []


def test_artist_and_album_pages_fill_out_known_catalog_entities(every_source):
    artists = [
        {"source": "musicbrainz", "country": "global", "kind": "artist", "provider_id": MBID},
        {"source": "ytmusic", "country": "global", "kind": "artist", "provider_id": CHANNEL},
    ]
    jobs = demand.plan(
        every_source, demand.Signal(type="artist", artist="Cordae"), lambda *_: artists
    )
    tasks = {job[0] for job in jobs}
    assert {"mb-lookup", "mb-albums", "mb-songs", "ytm-artist", "ytm-search"} <= tasks
    assert all(job[4] == demand.PAGE_PRIORITY for job in jobs)
    album = [{"source": "ytmusic", "country": "global", "kind": "album", "provider_id": ALBUM}]
    jobs = demand.plan(
        every_source,
        demand.Signal(type="album", title="The Lost Boy", artist="Cordae"),
        lambda kind, *_: album if kind == "album" else [],
    )
    assert ("ytm-album", "global", "album", ALBUM, demand.PAGE_PRIORITY) in jobs
    assert ("ytm-search", "global", "song", "the lost boy cordae", demand.PAGE_PRIORITY) in jobs


def test_plays_expand_related_songs_and_scale_by_listening_volume(every_source):
    song = [{"source": "ytmusic", "country": "global", "kind": "song", "provider_id": VIDEO}]
    jobs = demand.plan(
        every_source,
        demand.Signal(type="play", title="RNP", artist="Cordae", count=8),
        lambda kind, *_: song if kind == "song" else [],
    )
    assert ("ytm-related", "global", "song", VIDEO) in {job[:4] for job in jobs}
    assert not any(job[0].endswith("-search") for job in jobs)
    fallback = demand.plan(
        every_source, demand.Signal(type="play", title="RNP", artist="Cordae"), lambda *_: []
    )
    assert {job[0] for job in fallback} == {"ytm-search", "mb-search", "apple-search"}
    assert demand.DEMAND_FLOOR < demand.play_priority(1) < demand.play_priority(100)
    assert demand.play_priority(10**6) == demand.PAGE_PRIORITY


def test_demand_batches_are_bounded():
    with pytest.raises(ValidationError):
        demand.Batch(signals=[])
    with pytest.raises(ValidationError):
        demand.Batch(signals=[{"type": "search", "query": "x"}] * 51)
    with pytest.raises(ValidationError):
        demand.Signal(type="search", query="x" * 201)
    with pytest.raises(ValidationError):
        demand.Signal(type="user", query="x")


def test_demand_name_matching_requires_same_title_and_credit():
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [
        {"source": "ytmusic", "title": "RNP", "artist": "Cordae, Anderson .Paak"},
        {"source": "ytmusic", "title": "RNP (Remix)", "artist": "Cordae"},
        {"source": "ytmusic", "title": "RNP", "artist": "Somebody Else"},
        {"source": "musicbrainz", "title": "Beyoncé", "artist": ""},
    ]
    matches = demand.matcher(conn)
    assert [row["artist"] for row in matches("song", "RNP", "Cordae")] == [
        "Cordae, Anderson .Paak"
    ]
    assert len(matches("artist", "Beyonce", None)) == 1
    assert matches("song", "  ", None) == []


def client(settings, token=""):
    store = MagicMock()
    store.settings = replace(settings, demand_token=token)
    return TestClient(create_app(store.settings, store, MagicMock(), MagicMock()))


def test_demand_endpoint_is_disabled_without_a_token_and_rejects_bad_tokens(settings):
    body = {"signals": [{"type": "search", "query": "rnp"}]}
    with client(settings) as disabled:
        assert disabled.post("/v1/demand", json=body).status_code == 404
    with client(settings, TOKEN) as app, patch.object(demand, "record", return_value=3) as record:
        assert app.post("/v1/demand", json=body).status_code == 401
        wrong = {"Authorization": "Bearer " + "x" * 40}
        assert app.post("/v1/demand", json=body, headers=wrong).status_code == 401
        headers = {"Authorization": f"Bearer {TOKEN}"}
        response = app.post("/v1/demand", json=body, headers=headers)
        assert response.status_code == 202 and response.json() == {"queued": 3}
        assert app.post("/v1/demand", json={"signals": []}, headers=headers).status_code == 422
        large = {"signals": [{"type": "search", "query": "x" * 200}] * 200}
        assert app.post("/v1/demand", json=large, headers=headers).status_code == 413
        record.assert_called_once()


def test_demand_rate_limit_is_bounded():
    limit = demand.RateLimit(limit=2, window=60)
    assert limit.allow() and limit.allow() and not limit.allow()


def test_demand_is_recorded_as_priority_jobs(store):
    queued = demand.record(
        replace_settings(store, ytmusic_enabled=True),
        demand.Batch(signals=[{"type": "search", "query": "RNP Cordae"}] * 2),
    )
    assert queued == 3
    with store.transaction() as conn:
        rows = conn.execute(
            "SELECT task,provider_id,priority FROM jobs WHERE task LIKE '%search' ORDER BY task"
        ).fetchall()
    assert [row["task"] for row in rows] == ["apple-search", "mb-search", "ytm-search"]
    assert all(row["provider_id"] == "rnp cordae" for row in rows)
    assert all(row["priority"] == demand.SEARCH_PRIORITY for row in rows)


def replace_settings(store, **changes):
    store.settings = replace(store.settings, **changes)
    return store


def test_served_search_demand_ingests_results_then_decays(store):
    from catalog.crawler import process

    demand.record(store, demand.Batch(signals=[{"type": "search", "query": "First"}]))
    job = next(job for job in store.claim(count=10) if job["task"] == "mb-search")
    sources = MagicMock()
    sources.fetch.return_value = {
        "recordings": [
            {
                "id": SONG,
                "title": "First",
                "artist-credit": [{"name": "Example Artist", "artist": {"id": MBID}}],
            },
            {"title": "Malformed row without an id"},
        ]
    }
    process(store, sources, job)
    with store.transaction() as conn:
        assert conn.execute(
            "SELECT title,quality FROM entities WHERE provider_id=%s", (SONG,)
        ).fetchone() == {"title": "First", "quality": 0}
        served = conn.execute(
            "SELECT priority,due_at>now()+interval '29 days' AS later FROM jobs WHERE key=%s",
            (job["key"],),
        ).fetchone()
    assert served == {"priority": 0, "later": True}
