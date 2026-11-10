from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, MagicMock

import httpx
import pytest
from fastapi.testclient import TestClient

from catalog.api import create_app
from catalog.config import Settings
from catalog.console import snapshot
from catalog.crawler import process
from catalog.importer import normalized_entity
from catalog.indexer import index_batch
from catalog.model import entity_key
from catalog.providers import PUBLIC_SOURCES, RESEARCH, external_identity
from catalog.public_sources import parse
from catalog.sources import Deferred, Sources, request_url
from catalog.youtube import Discovery


SPOTIFY = "a" * 22
UUID = "00000000-0000-4000-8000-000000000003"


def job(source, kind="song", identifier="123", task=None, page=0):
    return {
        "source": source,
        "task": task or f"{source}-lookup",
        "kind": kind,
        "provider_id": identifier,
        "country": "global",
        "page": page,
    }


def fixtures():
    return [
        (
            job("spotify", identifier=SPOTIFY),
            {
                "provider_name": "Spotify",
                "title": "Signal Test",
                "html": "<iframe>not retained</iframe>",
            },
        ),
        (
            job("deezer"),
            {
                "id": 123,
                "title": "Signal Test",
                "artist": {"id": 9, "name": "Fixture Artist"},
                "album": {"id": 8, "title": "Fixture Album"},
            },
        ),
        (
            job("archive", "album", "fixture-concert"),
            {
                "result": {
                    "identifier": "fixture-concert",
                    "title": "Signal Test",
                    "creator": ["Fixture Artist"],
                    "collection": ["etree"],
                    "mediatype": "etree",
                }
            },
        ),
        (
            job("wikidata", "artist", "Q123"),
            {
                "entities": {
                    "Q123": {"id": "Q123", "labels": {"en": {"value": "Signal Test"}}, "claims": {}}
                }
            },
        ),
        (
            job("soundcloud", identifier="fixture~signal"),
            {
                "provider_name": "SoundCloud",
                "title": "Signal Test by Fixture Artist",
                "author_name": "Fixture Artist",
            },
        ),
        (
            job("openverse", identifier=UUID),
            {
                "id": UUID,
                "title": "Signal Test",
                "category": "music",
                "creator": "Fixture Artist",
                "genres": ["ambient"],
                "license": "by",
                "license_url": "https://creativecommons.org/licenses/by/4.0/",
                "attribution": "Signal Test by Fixture Artist (CC BY 4.0)",
                "foreign_landing_url": "https://example.org/fixture",
            },
        ),
    ]


@pytest.mark.parametrize("work,payload", fixtures())
def test_public_metadata_has_source_identity_and_no_media_or_embeds(work, payload):
    result = parse(work, {**payload, "audio": "private-media", "preview": "private-media"})
    assert len(result.entities) == 1
    item = result.entities[0]
    assert item.source == work["source"]
    assert item.provider_id == work["provider_id"]
    assert "private-media" not in repr(result)
    assert "<iframe>" not in repr(result)


@pytest.mark.parametrize(
    "source,kind,identifier",
    [
        ("spotify", "song", "../secret"),
        ("spotify", "song", "a" * 21),
        ("deezer", "song", "-1"),
        ("audius", "song", "abc"),
        ("archive", "song", "valid-id"),
        ("archive", "album", "http://host"),
        ("wikidata", "artist", "Q0"),
        ("soundcloud", "song", "user/track"),
        ("soundcloud", "artist", "user~track"),
        ("openverse", "artist", UUID),
        ("amazon", "album", "B000000000"),
    ],
)
def test_provider_specific_scope_and_identifier_budgets(source, kind, identifier):
    with pytest.raises(ValueError):
        entity_key("global", kind, identifier, source)


def test_chart_rank_is_explicit_not_a_popularity_score_or_result_order():
    payload = {
        "tracks": {"data": [{"id": 1, "title": "Song", "rank": 900000, "position": 3}]},
        "albums": {"data": []},
        "artists": {"data": []},
    }
    result = parse(job("deezer", task="deezer-chart"), payload)
    assert result.ranked[0][1] == 3
    del payload["tracks"]["data"][0]["position"]
    assert parse(job("deezer", task="deezer-chart"), payload).ranked == []
    with pytest.raises(ValueError, match="API error"):
        parse(job("deezer"), {"error": {"code": 4}})


def test_deezer_album_expansion_preserves_artist_and_album_relationships():
    result = parse(
        job("deezer", "album", "12"),
        {
            "id": 12,
            "title": "Album",
            "artist": {"id": 9, "name": "Artist"},
            "tracks": {"data": [{"id": 123, "title": "Song"}]},
        },
    )
    assert result.entities[1].album_keys == ("deezer:global:album:12",)
    assert result.entities[1].artist_keys == ("deezer:global:artist:9",)
    result = parse(
        job("deezer", "artist", "9", "deezer-albums", 100),
        {
            "data": [{"id": 12, "title": "Album"}],
            "next": "https://untrusted.invalid/url",
        },
    )
    assert result.pages == [("deezer-albums", "artist", "9", 200)]
    # Pagination builds a fixed endpoint; an upstream `next` URL is never followed.
    result = parse(
        job("deezer", "album", "12"),
        {
            "id": 12,
            "title": "Long Album",
            "nb_tracks": 2,
            "tracks": {"data": [{"id": 123, "title": "Song"}]},
        },
    )
    assert result.pages == [("deezer-tracks", "album", "12", 1)]
    result = parse(
        job("deezer", "album", "12", "deezer-tracks", 1),
        {
            "data": [{"id": 124, "title": "Second Song"}],
        },
    )
    assert result.entities[0].album_keys == ("deezer:global:album:12",)
    with pytest.raises(ValueError, match="budget"):
        parse(
            job("deezer", "artist", "9", "deezer-albums", 10000),
            {
                "data": [],
                "next": "https://example.org/more",
            },
        )


@pytest.mark.parametrize(
    "source,payload",
    [
        ("deezer", {"id": 999, "title": "Wrong"}),
        ("archive", {"result": {"identifier": "wrong", "title": "Wrong"}}),
        ("wikidata", {"entities": {"123": {"id": "Q999"}}}),
        ("openverse", {"id": UUID, "category": "music"}),
    ],
)
def test_lookup_identity_mismatch_is_not_ingested(source, payload):
    with pytest.raises(ValueError, match="identity"):
        parse(job(source), payload)


def test_wikidata_retains_only_explicit_non_deprecated_identifiers_and_amazon_links():
    def claim(value):
        return {"rank": "normal", "mainsnak": {"snaktype": "value", "datavalue": {"value": value}}}

    result = parse(
        job("wikidata", "album", "Q123"),
        {
            "entities": {
                "Q123": {
                    "id": "Q123",
                    "labels": {"en": {"value": "Fixture Album"}},
                    "claims": {"P5749": [claim("B000000000")], "P2205": [claim(SPOTIFY)]},
                }
            }
        },
    )
    assert len(result.links) == 2
    assert {row[1] for row in result.links} == {"amazon", "spotify"}
    assert (
        next(row[-1] for row in result.links if row[1] == "amazon")
        == "https://www.amazon.com/dp/B000000000"
    )
    assert not result.jobs
    assert external_identity(f"https://open.spotify.com/album/{SPOTIFY}") == (
        "spotify",
        "album",
        SPOTIFY,
    )
    assert external_identity("http://127.0.0.1/private") is None
    assert external_identity("https://open.spotify.com.evil.example/track/1") is None


@pytest.mark.parametrize(
    "labels,language,title",
    [
        ({"fr": {"value": "Titre public"}, "en": {"value": "Public title"}}, "en", "Public title"),
        (
            {"mul": {"value": "Public title"}, "fr": {"value": "Titre public"}},
            "mul",
            "Public title",
        ),
        ({"fr": {"value": "Titre public"}, "de": {"value": "Titel"}}, "de", "Titel"),
    ],
)
def test_wikidata_missing_english_uses_a_real_label_with_language_provenance(
    labels, language, title
):
    result = parse(
        job("wikidata", "album", "Q123"),
        {
            "entities": {"Q123": {"id": "Q123", "labels": labels, "claims": {}}},
        },
    )
    assert result.entities[0].title == title
    assert result.annotations == [("wikidata:global:album:Q123", {"label_language": language})]


@pytest.mark.parametrize(
    "labels", [{}, None, {"en": {"value": ""}}, {"en": {"language": "fr", "value": "Incorrect"}}]
)
def test_wikidata_label_errors_are_explicit_not_success_shaped_placeholders(labels):
    with pytest.raises(ValueError):
        parse(
            job("wikidata", "album", "Q123"),
            {
                "entities": {"Q123": {"id": "Q123", "labels": labels}},
            },
        )


def test_wikidata_artist_crosswalk_retains_explicit_youtube_channel():
    channel = "UC" + "a" * 22
    result = parse(
        job("wikidata", "artist", "Q123"),
        {
            "entities": {
                "Q123": {
                    "id": "Q123",
                    "labels": {"en": {"value": "Fixture Artist"}},
                    "claims": {
                        "P2397": [
                            {
                                "rank": "normal",
                                "mainsnak": {
                                    "snaktype": "value",
                                    "datavalue": {"value": channel},
                                },
                            },
                            {"rank": "deprecated"},
                        ],
                    },
                },
            },
        },
    )
    assert result.links == [
        (
            "wikidata:global:artist:Q123",
            "ytmusic",
            "artist",
            channel,
            f"https://music.youtube.com/channel/{channel}",
        ),
    ]


def test_openverse_license_attribution_is_required_and_no_nonmusic_is_mislabeled():
    work, payload = fixtures()[-1]
    result = parse(work, payload)
    assert result.annotations[0][1]["attribution"].endswith("CC BY 4.0)")
    for changed in (
        {**payload, "category": "sound_effect"},
        {**payload, "license_url": "javascript:x"},
    ):
        with pytest.raises(ValueError):
            parse(work, changed)
    with pytest.raises(ValueError, match="attribution"):
        normalized_entity(
            {
                "source": "openverse",
                "country": "global",
                "kind": "song",
                "provider_id": UUID,
                "title": "Fixture",
            }
        )


def test_public_sources_config_and_fixed_endpoint_transport(settings, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused")
    monkeypatch.setenv("CRAWLER_USER_AGENT", "Tests/1.0")
    monkeypatch.setenv("PUBLIC_SOURCES", ",".join(PUBLIC_SOURCES))
    assert Settings.load().public_sources == PUBLIC_SOURCES
    for unsupported in ("amazon", "audius"):
        monkeypatch.setenv("PUBLIC_SOURCES", unsupported)
        with pytest.raises(ValueError, match="unsupported"):
            Settings.load()
    enabled = replace(settings, public_sources=PUBLIC_SOURCES)
    for work, _ in fixtures():
        with pytest.raises(Deferred):
            request_url(work, settings)
        url, _ = request_url(work, enabled)
        assert url.startswith("https://")
    store = MagicMock()
    store.settings = enabled
    store.reserve_host.return_value = 0
    store.transaction.return_value.__enter__.return_value.execute.return_value.fetchone.return_value = {
        "paused": False,
    }
    sources = Sources(store, enabled)
    sources.client.close()
    sources.client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                302, headers={"location": "https://example.org/redirect"}
            )
        )
    )
    try:
        with pytest.raises(ValueError, match="redirected"):
            sources.fetch(fixtures()[0][0])
    finally:
        sources.close()
    assert len(RESEARCH) >= 20
    assert len({row[0] for row in RESEARCH}) == len(RESEARCH)


@pytest.mark.integration
def test_all_public_adapters_flow_through_queue_storage_index_and_filtered_search(
    store,
    vectors,
    embeddings,
):
    store.settings = replace(store.settings, public_sources=PUBLIC_SOURCES)
    for work, payload in fixtures():
        with store.transaction() as conn:
            store.enqueue(conn, work["task"], "global", work["kind"], work["provider_id"])
        jobs = store.claim(count=100)
        actual = next(
            item
            for item in jobs
            if item["source"] == work["source"] and item["provider_id"] == work["provider_id"]
        )
        sources = Mock()
        sources.fetch.return_value = payload
        process(store, sources, actual)
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 100))
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        for work, _ in fixtures():
            response = client.get("/v1/search", params={"q": "Signal", "source": work["source"]})
            assert response.status_code == 200
            assert len(response.json()["results"]) == 1
            detail = client.get(
                "/v1/entities/"
                + entity_key("global", work["kind"], work["provider_id"], work["source"])
            ).json()
            if work["source"] == "openverse":
                assert detail["annotations"]["license"] == "by"
        data = client.get("/v1/console/snapshot").json()
        assert data["entities"] == data["indexed"] == 6
        assert len(data["research"]) >= 20
        assert len(data["sources"]) == 14


@pytest.mark.integration
def test_claim_skips_paused_disabled_and_host_backoff_without_starving_other_sources(store):
    store.settings = replace(store.settings, public_sources=("spotify", "deezer", "wikidata"))
    with store.transaction() as conn:
        store.enqueue(conn, "spotify-lookup", "global", "song", SPOTIFY, 100)
        store.enqueue(conn, "deezer-lookup", "global", "song", "123", 10)
        store.enqueue(conn, "wikidata-lookup", "global", "artist", "Q123", 50)
        conn.execute("UPDATE source_controls SET paused=true WHERE source='wikidata'")
    store.pause_host("open.spotify.com", 600)
    data = snapshot(store)
    assert data["queues"]["jobs"]["due"] == 3
    assert data["eligible"] == 1
    assert store.claim()[0]["source"] == "deezer"
    assert store.claim() == []
    store.settings = replace(store.settings, public_sources=())
    with store.transaction() as conn:
        conn.execute("UPDATE host_budgets SET next_at='-infinity'")
        conn.execute("UPDATE source_controls SET paused=false")
    assert store.claim() == []


@pytest.mark.integration
def test_explicit_amazon_link_is_retained_without_claiming_an_amazon_adapter(store, song):
    with store.transaction() as conn:
        store.ingest(conn, [song])
        store.public_observations(
            conn,
            Discovery(
                [],
                [],
                [],
                [],
                links=[
                    (
                        song.key,
                        "amazon",
                        "album",
                        "B000000000",
                        "https://www.amazon.com/dp/B000000000",
                    ),
                ],
            ),
        )
        assert conn.execute("SELECT provider FROM entity_links").fetchone()["provider"] == "amazon"
        assert (
            conn.execute("SELECT count(*) AS n FROM jobs WHERE source='amazon'").fetchone()["n"]
            == 0
        )


@pytest.mark.integration
def test_v2_upgrade_preserves_jobs_pauses_and_host_budgets(store):
    schema = Path(__file__).parents[1] / "catalog"
    with store.transaction() as conn:
        conn.execute("DROP SCHEMA public CASCADE")
        conn.execute("CREATE SCHEMA public")
        conn.execute((schema / "schema.sql").read_text())
        conn.execute((schema / "schema-v2.sql").read_text())
        conn.execute("""
            INSERT INTO jobs(key,task,country,kind,provider_id,source,attempts,last_error)
            VALUES ('preserved','yt-video','global','song','abcdefghijk','youtube',2,'FixtureError')
        """)
        conn.execute("UPDATE source_controls SET paused=true WHERE source='youtube'")
        conn.execute("INSERT INTO host_budgets(host,next_at) VALUES ('www.youtube.com','infinity')")
    store.migrate()
    store.migrate()
    with store.transaction() as conn:
        existing = conn.execute(
            "SELECT host,attempts,last_error FROM jobs WHERE key='preserved'"
        ).fetchone()
        assert existing["host"] == "www.youtube.com"
        assert existing["attempts"] == 2 and existing["last_error"] == "FixtureError"
        assert conn.execute("SELECT paused FROM source_controls WHERE source='youtube'").fetchone()[
            "paused"
        ]
        assert (
            conn.execute("SELECT next_at::text AS next_at FROM host_budgets").fetchone()["next_at"]
            == "infinity"
        )
        assert conn.execute("SELECT count(*) AS n FROM source_controls").fetchone()["n"] == 14
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 0
