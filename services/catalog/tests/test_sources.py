from datetime import datetime, timezone
from unittest.mock import MagicMock, Mock

import httpx
import pytest

from catalog.sources import Deferred, MAX_BODY, Sources, request_url, retry_after
from conftest import ARTIST_ID


def job(task="chart", **kwargs):
    return {"task": task, "country": "us", "kind": "song", "provider_id": "123", **kwargs}


def test_request_building_cannot_use_arbitrary_urls(settings):
    url, params = request_url(job("lookup"), settings)
    assert url == "https://itunes.apple.com/lookup"
    assert params["id"] == "123"
    url, params = request_url(
        job(
            "mb-songs",
            country="global",
            kind="artist",
            provider_id=ARTIST_ID,
            page=100,
        ),
        settings,
    )
    assert url == "https://musicbrainz.org/ws/2/recording"
    assert params["offset"] == 100
    with pytest.raises(ValueError):
        request_url(job("lookup", provider_id="https://localhost"), settings)


@pytest.mark.parametrize("kind", ["artist", "album", "song"])
def test_musicbrainz_lookup_requests_public_genres_without_an_extra_request(settings, kind):
    _, params = request_url(job("mb-lookup", kind=kind, provider_id=ARTIST_ID), settings)
    assert "genres" in params["inc"].split("+")
    assert "user-genres" not in params["inc"]


@pytest.mark.parametrize("kind,size", [("song", 50), ("album", 5), ("artist", 5)])
def test_apple_lookup_batches_are_bounded_validated_provider_ids(settings, kind, size):
    identifiers = [str(n) for n in range(1, size + 1)]
    _, params = request_url(
        job("lookup", kind=kind, provider_id="1", lookup_ids=identifiers), settings
    )
    assert params["id"] == ",".join(identifiers)
    assert params["limit"] == 200
    for invalid in ([], identifiers + ["999"], ["2"], ["1", "1"], ["1", "https://localhost"]):
        with pytest.raises(ValueError):
            request_url(job("lookup", kind=kind, provider_id="1", lookup_ids=invalid), settings)


def test_retry_after_seconds_and_http_date():
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert retry_after("120", now) == 120
    assert retry_after("Thu, 01 Jan 2026 00:01:00 GMT", now) == 60
    assert retry_after("invalid", now) == 60
    assert retry_after("-1", now) == 1


@pytest.fixture
def source(settings):
    store = MagicMock()
    store.transaction.return_value.__enter__.return_value.execute.return_value.fetchone.return_value = {
        "paused": False,
        "admitted": True,
    }
    store.reserve_host.return_value = 0
    instance = Sources(store, settings)
    instance.client.close()
    yield instance
    instance.close()


def test_shared_rate_budget_defers_without_network(source):
    source.store.reserve_host.return_value = 12
    source.client = Mock()
    with pytest.raises(Deferred) as caught:
        source.fetch(job())
    assert caught.value.seconds == 12
    source.client.stream.assert_not_called()


def test_dispatch_admission_is_consumed_once_and_redirects_still_reserve(source):
    seen = []

    def respond(request):
        seen.append(str(request.url))
        if len(seen) == 1:
            return httpx.Response(302, headers={"location": "/next"})
        return httpx.Response(200, json={})

    source.client = httpx.Client(transport=httpx.MockTransport(respond))
    admitted = job(
        request_host="rss.marketingtools.apple.com", request_until=datetime.now(timezone.utc)
    )
    assert source.fetch(admitted) == {}
    assert "request_host" not in admitted
    source.store.reserve_host.assert_called_once_with("rss.marketingtools.apple.com", 4)
    assert source.fetch(admitted) == {}
    assert source.store.reserve_host.call_count == 2


def test_dispatch_admission_for_a_different_host_cannot_skip_pacing(source):
    source.store.reserve_host.return_value = 10
    source.client = Mock()
    with pytest.raises(Deferred):
        source.fetch(job(request_host="musicbrainz.org"))
    source.client.stream.assert_not_called()


def test_redirect_continuation_does_not_restart_the_original_request(source, monkeypatch):
    seen = []

    def respond(request):
        seen.append(str(request.url))
        if len(seen) == 1:
            return httpx.Response(301, headers={"location": "/ws/2/artist/canonical?fmt=json"})
        return httpx.Response(200, json={"id": "canonical"})

    source.client = httpx.Client(transport=httpx.MockTransport(respond))
    source.store.reserve_host.side_effect = [0, 0.75, 0]
    sleep = Mock()
    monkeypatch.setattr("catalog.sources.time.sleep", sleep)
    assert source.fetch(job("mb-lookup", kind="artist", provider_id=ARTIST_ID)) == {
        "id": "canonical"
    }
    assert len(seen) == 2 and "canonical" in seen[1]
    sleep.assert_called_once_with(0.75)
    assert all(
        call.args == ("musicbrainz.org", 1) for call in source.store.reserve_host.call_args_list
    )


def test_transport_uses_per_source_fractional_interval(source):
    from dataclasses import replace

    source.settings = replace(source.settings, source_intervals=(("apple", 0.5),))
    source.client = httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={}))
    )
    assert source.fetch(job()) == {}
    source.store.reserve_host.assert_called_once_with("rss.marketingtools.apple.com", 0.5)


@pytest.mark.parametrize("status,expected", [(403, 86400), (429, 120), (503, 120)])
def test_upstream_throttling_pauses_all_workers(source, status, expected):
    source.client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(status, headers={"retry-after": "120"})
        )
    )
    with pytest.raises(Deferred) as caught:
        source.fetch(job())
    assert caught.value.seconds == expected
    source.store.pause_host.assert_called_once_with("rss.marketingtools.apple.com", expected)


def test_redirect_allowlist_and_challenges(source):
    source.client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(302, headers={"location": "http://127.0.0.1/private"})
        )
    )
    with pytest.raises(ValueError, match="allowlist"):
        source.fetch(job())
    source.client.close()
    source.client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, text="<html>challenge</html>")
        )
    )
    with pytest.raises(ValueError, match="non-JSON"):
        source.fetch(job())


def test_decompressed_response_budget(source):
    source.client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, content=b"x" * (MAX_BODY + 1), headers={"content-type": "application/json"}
            )
        )
    )
    with pytest.raises(ValueError, match="byte budget"):
        source.fetch(job())


def test_apple_lookup_accepts_json_served_as_javascript(source):
    source.client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                content=b'{"resultCount":0,"results":[]}',
                headers={"content-type": "text/javascript; charset=utf-8"},
            )
        )
    )
    assert source.fetch(job("lookup")) == {"resultCount": 0, "results": []}
    with pytest.raises(ValueError, match="non-JSON"):
        source.fetch(job("chart"))


@pytest.mark.parametrize(
    "body",
    [b"<html>challenge</html>", b'callback({"results":[]})', b"[]"],
)
def test_apple_javascript_mime_still_requires_a_json_object(source, body):
    source.client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, content=body, headers={"content-type": "text/javascript"}
            )
        )
    )
    with pytest.raises(ValueError):
        source.fetch(job("lookup"))
