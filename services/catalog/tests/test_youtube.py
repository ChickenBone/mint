from dataclasses import replace
from io import BytesIO
from unittest.mock import MagicMock, Mock, patch

import pytest
import requests
from defusedxml.common import DefusedXmlException

from catalog.model import entity_key
from catalog.sources import Deferred, request_url
from catalog.youtube import (
    PublicMusicSession,
    YouTubeMusic,
    parse_feed,
    parse_oembed,
    parse_ytmusic,
)


CHANNEL = "UC" + "a" * 22
VIDEO = "abcdefghijk"
ALBUM = "MPRE" + "b" * 16


def feed():
    return f"""<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
      <yt:channelId>{CHANNEL}</yt:channelId><title>Fixture Channel</title>
      <entry><yt:videoId>{VIDEO}</yt:videoId><title>Fixture Video</title>
      <media:group><media:community><media:statistics views="12345"/>
      </media:community></media:group></entry></feed>"""


def test_youtube_public_feed_and_view_signals():
    result = parse_feed(feed(), CHANNEL)
    assert len(result.entities) == 2
    assert result.entities[1].artist_keys == (f"youtube:global:artist:{CHANNEL}",)
    assert result.views[0][1] == 12345
    assert result.ranked == []
    assert (
        len(
            parse_feed(
                feed().replace(
                    f"<yt:channelId>{CHANNEL}</yt:channelId>",
                    f"<yt:channelId>{CHANNEL[2:]}</yt:channelId>",
                ),
                CHANNEL,
            ).entities
        )
        == 2
    )
    with pytest.raises(ValueError, match="match"):
        parse_feed(feed(), "UC" + "z" * 22)
    with pytest.raises(DefusedXmlException):
        parse_feed('<!DOCTYPE a [<!ENTITY x "x">]><feed>&x;</feed>', CHANNEL)


def test_youtube_namespace_validates_video_channel_and_rejects_album():
    assert entity_key("global", "song", VIDEO, "youtube").endswith(VIDEO)
    for kind, identifier in (("song", "bad"), ("artist", VIDEO), ("album", ALBUM)):
        with pytest.raises(ValueError):
            entity_key("global", kind, identifier, "youtube")
    assert entity_key("global", "song", VIDEO, "youtube") != entity_key(
        "global", "song", VIDEO, "ytmusic"
    )


def test_oembed_keeps_metadata_and_explicit_channel_not_embed_html():
    result = parse_oembed(
        {
            "title": "Fixture Video",
            "author_name": "Fixture Channel",
            "author_url": f"https://www.youtube.com/channel/{CHANNEL}",
            "html": "<iframe>unsafe</iframe>",
        },
        VIDEO,
    )
    assert result.entities[0].artist_keys == (f"youtube:global:artist:{CHANNEL}",)
    assert "<iframe>" not in result.entities[0].document()
    result = parse_oembed(
        {
            "title": "Fixture Video",
            "author_name": "Fixture Channel",
            "author_url": "https://www.youtube.com/@unresolved",
        },
        VIDEO,
    )
    assert result.entities[0].artist_keys == ()


def test_ytmusic_never_invents_rank_from_unauthenticated_list_order():
    result = parse_ytmusic(
        {"task": "ytm-chart"},
        {
            "artists": [{"title": "Fixture Artist", "browseId": CHANNEL, "rank": None}],
            "videos": [{"playlistId": "PL" + "a" * 20}],
        },
    )
    assert result.ranked == []
    assert result.entities[0].source == "ytmusic"
    assert result.jobs[0][0] == "ytm-playlist"
    ranked = parse_ytmusic(
        {"task": "ytm-chart"},
        {
            "artists": [{"title": "Fixture Artist", "browseId": CHANNEL, "rank": "2"}],
            "videos": [],
        },
    )
    assert ranked.ranked[0][1] == 2
    albums = parse_ytmusic(
        {"task": "ytm-chart"},
        {
            "artists": [{"title": "Fixture Album", "browseId": ALBUM, "rank": "1"}],
            "videos": [],
        },
    )
    assert albums.entities[0].kind == "album"
    assert albums.ranked[0][1] == 1


def test_ytmusic_album_links_tracks_to_explicit_album_and_artist():
    result = parse_ytmusic(
        {"task": "ytm-album", "provider_id": ALBUM},
        {
            "title": "Fixture Album",
            "artists": [{"id": CHANNEL, "name": "Fixture Artist"}],
            "tracks": [{"videoId": VIDEO, "title": "Fixture Song"}],
        },
    )
    assert result.entities[1].album_keys == (f"ytmusic:global:album:{ALBUM}",)
    assert result.entities[1].artist_keys == (f"ytmusic:global:artist:{CHANNEL}",)
    assert result.entities[0].quality == 1 and result.entities[1].quality == 0


def test_ytmusic_public_uploader_channel_is_not_a_music_artist(music_session):
    adapter = YouTubeMusic(music_session.store)
    adapter.client = Mock()
    adapter.client.get_artist.side_effect = KeyError("musicImmersiveHeaderRenderer")
    adapter.client.get_user.return_value = {
        "name": "Public Fixture Channel",
        "songs": None,
        "videos": {"results": [{"videoId": VIDEO, "title": "Public Fixture Video"}]},
    }
    job = {"task": "ytm-artist", "provider_id": CHANNEL, "country": "global"}
    result = parse_ytmusic(job, adapter.fetch(job))
    assert len(result.entities) == 2
    adapter.client.get_user.assert_called_once_with(CHANNEL)
    adapter.client.get_artist.side_effect = KeyError("unexpectedNewSchema")
    with pytest.raises(KeyError, match="unexpectedNewSchema"):
        adapter.fetch(job)
    assert adapter.client.get_user.call_count == 1
    adapter.close()


def test_public_youtube_requests_use_only_fixed_endpoints(settings):
    settings = replace(settings, youtube_enabled=True)
    url, params = request_url(
        {
            "task": "yt-feed",
            "provider_id": CHANNEL,
            "country": "global",
        },
        settings,
    )
    assert url == "https://www.youtube.com/feeds/videos.xml"
    assert params == {"channel_id": CHANNEL}
    with pytest.raises(Deferred):
        request_url(
            {"task": "yt-video", "provider_id": VIDEO, "country": "global"},
            replace(settings, youtube_enabled=False),
        )


@pytest.fixture
def music_session(settings):
    store = MagicMock()
    store.settings = settings
    store.reserve_host.return_value = 0
    store.transaction.return_value.__enter__.return_value.execute.return_value.fetchone.return_value = {
        "paused": False,
        "admitted": True,
    }
    session = PublicMusicSession(store)
    session.begin()
    yield session
    session.close()


def test_every_ytmusic_request_respects_host_and_job_budgets(music_session):
    with pytest.raises(ValueError, match="fixed public host"):
        music_session.get("http://127.0.0.1/private")
    music_session.requests_left = 0
    with pytest.raises(ValueError, match="request budget"):
        music_session.get("https://music.youtube.com/youtubei/v1/browse")


def test_ytmusic_first_request_never_occupies_a_worker_waiting_for_pacing(music_session):
    music_session.store.reserve_host.return_value = 0.25
    with (
        patch("catalog.youtube.time.sleep") as sleep,
        patch.object(requests.Session, "request") as send,
    ):
        with pytest.raises(Deferred) as caught:
            music_session.get("https://music.youtube.com/youtubei/v1/browse")
    assert caught.value.seconds == 0.25
    sleep.assert_not_called()
    send.assert_not_called()


def test_ytmusic_dispatch_admission_only_covers_the_first_library_request(music_session):
    music_session.begin("music.youtube.com", "synthetic-ticket-deadline")
    response = requests.Response()
    response.status_code = 200
    response.raw = BytesIO(b"{}")
    music_session.store.reserve_host.return_value = 120
    with patch.object(requests.Session, "request", return_value=response) as send:
        assert music_session.get("https://music.youtube.com/youtubei/v1/browse").json() == {}
        music_session.store.reserve_host.assert_not_called()
        with pytest.raises(Deferred):
            music_session.get("https://music.youtube.com/youtubei/v1/browse")
        send.assert_called_once()
    music_session.store.reserve_host.assert_called_once()
    music_session.begin()
    assert music_session.admitted_host is None


def test_ytmusic_uses_fractional_source_override(music_session):
    music_session.store.settings = replace(
        music_session.store.settings, source_intervals=(("ytmusic", 0.25),)
    )
    music_session.store.reserve_host.return_value = 5
    with pytest.raises(Deferred):
        music_session.get("https://music.youtube.com/youtubei/v1/browse")
    music_session.store.reserve_host.assert_called_once_with("music.youtube.com", 0.25)


def test_ytmusic_followup_wait_preserves_library_continuation(music_session):
    def response():
        result = requests.Response()
        result.status_code = 200
        result.raw = BytesIO(b"{}")
        return result

    music_session.store.reserve_host.side_effect = [0, 0.25, 0]
    with (
        patch("catalog.youtube.time.sleep") as sleep,
        patch.object(requests.Session, "request", side_effect=[response(), response()]) as send,
    ):
        assert music_session.get("https://music.youtube.com/youtubei/v1/browse").json() == {}
        assert music_session.get("https://music.youtube.com/youtubei/v1/browse").json() == {}
    sleep.assert_called_once_with(0.25)
    assert send.call_count == 2
    music_session.begin()
    assert music_session.started_requests == 0


def test_ytmusic_http_throttle_is_shared_and_never_uses_login(music_session):
    response = requests.Response()
    response.status_code = 429
    response.headers["retry-after"] = "120"
    response.raw = Mock()
    response._content = b"{}"
    with patch.object(requests.Session, "request", return_value=response):
        with pytest.raises(Deferred) as caught:
            music_session.post("https://music.youtube.com/youtubei/v1/browse")
    assert caught.value.seconds == 120
    music_session.store.pause_host.assert_called_once_with("music.youtube.com", 120)
