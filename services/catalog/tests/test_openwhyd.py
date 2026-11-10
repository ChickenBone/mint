from dataclasses import replace
from unittest.mock import Mock

import httpx
import pytest

from catalog.crawler import process
from catalog.model import entity_key
from catalog.openwhyd import parse
from catalog.sources import Deferred, Sources, request_url


def job():
    return {
        "source": "openwhyd",
        "task": "openwhyd-chart",
        "kind": "song",
        "provider_id": "",
        "country": "global",
        "page": 0,
    }


def payload():
    return {
        "hasMore": False,
        "tracks": [
            {
                "name": "Fictional Video",
                "eId": "/yt/abcdefghijk",
                "nbL": 5,
                "nbR": 11,
                "uId": "private-user",
                "uNm": "private-name",
                "text": "private-comment",
                "img": "private-image",
                "src": {"id": "private-stream"},
            },
            {
                "name": "Fictional SoundCloud",
                "eId": "/sc/fixture/track#https://private-stream",
                "nbP": 6,
            },
            {"name": "Unsupported", "eId": "/vi/123"},
        ],
    }


def test_hot_tracks_keep_explicit_source_ids_not_people_streams_or_fake_ranks(caplog):
    with caplog.at_level("INFO"):
        result = parse(payload())
    assert [item.source for item in result.entities] == ["youtube", "soundcloud"]
    assert all(item.origin == "openwhyd" and item.quality == 0 for item in result.entities)
    assert result.entities[1].provider_id == "fixture~track"
    assert result.ranked == []
    assert [signal for _, signal, _ in result.metrics] == [
        "openwhyd_reposts",
        "openwhyd_likes",
        "openwhyd_posts",
    ]
    assert "private-" not in repr(result)
    assert "unsupported=1" in caplog.text
    assert not any(item.artist_keys or item.genres for item in result.entities)
    assert result.annotations[0][1]["landing_url"] == "https://openwhyd.org/hot"


def test_duplicate_posts_do_not_multiply_observations():
    row = payload()["tracks"][0]
    result = parse({"tracks": [row, row]})
    assert len(result.entities) == 1 and len(result.metrics) == 2


@pytest.mark.parametrize("identifier", ["/yt/bad", "/sc/missing-track", "/yt/abcdefghijk?url=evil"])
def test_invalid_supported_platform_identity_fails_visibly(identifier):
    with pytest.raises(ValueError):
        parse({"tracks": [{"name": "Fixture", "eId": identifier}]})


def test_discovery_only_identity_and_fixed_public_export(settings):
    with pytest.raises(ValueError):
        entity_key("global", "song", "123", "openwhyd")
    enabled = replace(settings, public_sources=("openwhyd",), source_interval=0.1)
    assert enabled.request_interval("openwhyd") == 2
    assert request_url(job(), enabled) == (
        "https://openwhyd.org/hot",
        {"format": "json", "limit": 20},
    )
    with pytest.raises(Deferred):
        request_url(job(), settings)


@pytest.mark.parametrize("as_array", [False, True])
def test_export_json_object_and_documented_array_transport(settings, as_array):
    store = Mock()
    store.transaction.return_value.__enter__ = Mock(return_value=Mock())
    store.transaction.return_value.__exit__ = Mock(return_value=False)
    conn = store.transaction.return_value.__enter__.return_value
    conn.execute.return_value.fetchone.return_value = {"paused": False, "admitted": False}
    store.reserve_host.return_value = 0
    sources = Sources(store, replace(settings, public_sources=("openwhyd",)))
    sources.client.close()
    data = payload()["tracks"] if as_array else payload()
    sources.client = httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=data))
    )
    try:
        assert len(parse(sources.fetch(job())).entities) == 2
    finally:
        sources.close()
    assert store.reserve_host.call_args.args == ("openwhyd.org", 4)


@pytest.mark.integration
def test_discovery_feeds_existing_source_queues_and_preserves_signal_provenance(store):
    store.settings = replace(
        store.settings, public_sources=("openwhyd", "soundcloud"), youtube_enabled=True
    )
    store.seed()
    with store.transaction() as conn:
        assert (
            conn.execute("SELECT count(*) AS n FROM jobs WHERE task='openwhyd-chart'").fetchone()[
                "n"
            ]
            == 1
        )
        conn.execute("UPDATE jobs SET due_at=now()+interval '1 day' WHERE source<>'openwhyd'")
    actual = store.claim_crawl()[0]
    source = Mock()
    source.fetch.return_value = payload()
    process(store, source, actual)
    with store.transaction() as conn:
        rows = conn.execute("SELECT source,origin FROM entities ORDER BY source").fetchall()
        assert rows == [
            {"source": "soundcloud", "origin": "openwhyd"},
            {"source": "youtube", "origin": "openwhyd"},
        ]
        assert (
            conn.execute("SELECT count(*) AS n FROM chart_signals WHERE rank IS NULL").fetchone()[
                "n"
            ]
            == 3
        )
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM jobs WHERE task IN ('yt-video','soundcloud-lookup')"
            ).fetchone()["n"]
            == 2
        )
        assert conn.execute(
            "SELECT due_at>now() AS scheduled FROM jobs WHERE source='openwhyd'"
        ).fetchone()["scheduled"]
