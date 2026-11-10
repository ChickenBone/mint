import gzip
import io
from dataclasses import replace
from threading import Event
from unittest.mock import Mock

import httpx
import pytest
from defusedxml.common import DefusedXmlException

from catalog.crawler import process
from catalog.discogs import parse
from catalog.discogs_import import BoundedReader, import_discogs, records
from catalog.model import entity_key
from catalog.providers import canonical_url, external_identity
from catalog.sources import Deferred, Sources, request_url


def job(kind="album", identifier="m504", task="discogs-lookup", page=0):
    return {
        "source": "discogs",
        "country": "global",
        "kind": kind,
        "provider_id": identifier,
        "task": task,
        "page": page,
    }


def album(identifier=504):
    return {
        "id": identifier,
        "title": "Fictional Signals",
        "artists": [{"id": 45, "name": "Fixture Artist"}],
        "genres": ["Electronic"],
        "styles": ["Ambient"],
        "tracklist": [{"title": "Not a globally identified song"}],
        "images": [{"uri": "private-image"}],
        "videos": [{"uri": "private-video"}],
    }


@pytest.mark.parametrize(
    "kind,identifier,path",
    [
        ("artist", "45", "artist/45"),
        ("album", "m504", "master/504"),
        ("album", "r504", "release/504"),
    ],
)
def test_discogs_namespace_and_explicit_crosswalks(kind, identifier, path):
    url = canonical_url("discogs", kind, identifier)
    assert url == f"https://www.discogs.com/{path}"
    assert external_identity(url + "-fixture") == ("discogs", kind, identifier)
    assert entity_key("global", kind, identifier, "discogs").endswith(":" + identifier)


@pytest.mark.parametrize(
    "kind,identifier",
    [
        ("artist", "m45"),
        ("artist", "0"),
        ("album", "45"),
        ("album", "m0"),
        ("album", "r-1"),
        ("song", "r45"),
        ("album", "m45/anything"),
    ],
)
def test_discogs_rejects_mixed_and_fabricated_identities(kind, identifier):
    with pytest.raises(ValueError):
        entity_key("global", kind, identifier, "discogs")


def test_discogs_metadata_genres_credits_styles_and_scoped_counts():
    result = parse(
        job(identifier="r504"),
        {
            **album(),
            "community": {
                "have": 123,
                "want": 456,
                "submitter": {"username": "private-profile"},
            },
        },
    )
    item = result.entities[0]
    assert item.genres == ("Electronic",)
    assert item.artist_keys == ("discogs:global:artist:45",)
    assert result.annotations == [(item.key, {"record_type": "release", "styles": ["Ambient"]})]
    assert [signal for _, signal, _ in result.metrics] == ["discogs_have", "discogs_want"]
    assert result.ranked == []
    assert all(value not in repr(result) for value in ("private-", "tracklist", "globally"))
    assert len(result.entities) == 1


def test_discogs_master_keeps_main_edition_separate():
    result = parse(job(), {**album(), "main_release": 900})
    assert result.jobs == [("discogs-lookup", "album", "r900")]
    assert result.annotations[0][1]["main_release"] == "r900"
    assert result.entities[0].key != entity_key("global", "album", "r900", "discogs")


def test_discogs_artist_expands_discography_not_alias_names():
    result = parse(
        job("artist", "45"),
        {
            "id": 45,
            "name": "Fixture Artist",
            "profile": "private-biography",
            "aliases": [{"id": 98, "name": "Not identity proof"}],
            "urls": ["https://musicbrainz.org/artist/00000000-0000-4000-8000-000000000001"],
        },
    )
    assert result.jobs == [("discogs-albums", "artist", "45")]
    assert result.links[0][1:4] == ("musicbrainz", "artist", "00000000-0000-4000-8000-000000000001")
    assert "private-biography" not in repr(result)
    assert "98" not in repr(result)


def test_discogs_pagination_is_bounded_and_not_a_popularity_rank(settings):
    work = job("artist", "45", "discogs-albums", 100)
    url, params = request_url(work, replace(settings, public_sources=("discogs",)))
    assert url == "https://api.discogs.com/artists/45/releases"
    assert params == {"per_page": 100, "page": 2, "sort": "year", "sort_order": "desc"}
    payload = {
        "pagination": {"page": 2, "pages": 3, "per_page": 100},
        "releases": [
            {"id": 504, "type": "master", "title": "Master", "artist": "Fixture Artist"},
            {"id": 504, "type": "release", "title": "Edition", "artist": "Fixture Artist"},
        ],
    }
    result = parse(work, payload)
    assert [item.provider_id for item in result.entities] == ["m504", "r504"]
    assert all(item.quality == 0 for item in result.entities)
    assert result.pages == [("discogs-albums", "artist", "45", 200)]
    assert result.ranked == result.metrics == []
    payload["pagination"]["page"] = 1
    with pytest.raises(ValueError, match="pagination"):
        parse(work, payload)


@pytest.mark.parametrize(
    "payload",
    [
        {"message": "Unavailable"},
        {**album(), "id": 505},
        {**album(), "genres": ["genre"] * 21},
        {**album(), "styles": ["style"] * 101},
    ],
)
def test_discogs_fails_visibly_on_invalid_payloads(payload):
    with pytest.raises(ValueError):
        parse(job(), payload)


def test_discogs_source_policy_and_transport(settings):
    settings = replace(settings, public_sources=("discogs",), source_interval=0.1)
    assert settings.request_interval("discogs") == 2.5
    store = Mock()
    store.transaction.return_value.__enter__ = Mock(return_value=Mock())
    store.transaction.return_value.__exit__ = Mock(return_value=False)
    conn = store.transaction.return_value.__enter__.return_value
    conn.execute.return_value.fetchone.return_value = {"paused": False, "admitted": False}
    store.reserve_host.return_value = 0
    sources = Sources(store, settings)
    sources.client.close()
    sources.client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(429, headers={"Retry-After": "120"})
        )
    )
    try:
        with pytest.raises(Deferred):
            sources.fetch(job())
    finally:
        sources.close()
    store.pause_host.assert_called_once_with("api.discogs.com", 120)


@pytest.mark.parametrize("source,value", [("discogs", "2"), ("openwhyd", "1")])
def test_source_override_cannot_remove_provider_minimum(monkeypatch, source, value):
    from catalog.config import source_intervals

    monkeypatch.setenv("SOURCE_INTERVAL_OVERRIDES", f"{source}={value}")
    with pytest.raises(ValueError, match="requires at least"):
        source_intervals()


def xml(kind="master", count=1):
    root = {"artist": "artists", "master": "masters", "release": "releases"}[kind]
    entries = []
    for identifier in range(1, count + 1):
        if kind == "artist":
            entries.append(
                f"<artist><id>{identifier}</id><name>Fixture {identifier}</name></artist>"
            )
        else:
            entries.append(
                f'<{kind} id="{identifier}"><title>Fixture {identifier}</title>'
                "<artists><artist><id>45</id><name>Fixture Artist</name></artist></artists>"
                f"<genres><genre>Electronic</genre></genres><styles><style>Ambient</style></styles></{kind}>"
            )
    return ("<" + root + ">" + "".join(entries) + "</" + root + ">").encode()


@pytest.mark.integration
@pytest.mark.parametrize(
    "kind,compressed", [("artist", False), ("master", True), ("release", False)]
)
def test_streaming_dump_import_preserves_index_outbox_without_online_job_flood(
    store, tmp_path, kind, compressed
):
    path = tmp_path / ("dump.xml.gz" if compressed else "dump.xml")
    path.write_bytes(gzip.compress(xml(kind, 129)) if compressed else xml(kind, 129))
    store.settings = replace(store.settings, public_sources=("discogs",))
    assert import_discogs(store, path, kind) == {"imported": 129, "status": "complete"}
    with store.transaction() as conn:
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 129
        assert conn.execute("SELECT count(*) AS n FROM vector_outbox").fetchone()["n"] == 129
        assert conn.execute("SELECT count(*) AS n FROM jobs").fetchone()["n"] == 0
        annotations = conn.execute("SELECT metadata FROM entity_annotations LIMIT 1").fetchone()[
            "metadata"
        ]
        assert annotations["source_data_license"] == "CC0-1.0"
        if kind != "artist":
            assert annotations["styles"] == ["Ambient"]
            assert conn.execute("SELECT genres FROM entities LIMIT 1").fetchone()["genres"] == [
                "Electronic"
            ]
            assert conn.execute("SELECT count(*) AS n FROM edges").fetchone()["n"] == 129
    assert import_discogs(store, path, kind, limit=1) == {"imported": 1, "status": "limited"}
    with store.transaction() as conn:
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 129


def test_dump_parser_clears_previous_records_and_rejects_wrong_root(tmp_path):
    path = tmp_path / "dump.xml"
    path.write_bytes(xml(count=1000))
    with records(path, "master") as entries:
        previous = next(entries)
        assert len(previous) > 0
        next(entries)
        assert len(previous) == 0
        assert sum(1 for _ in entries) == 998
    with records(path, "artist") as entries, pytest.raises(ValueError, match="XML root"):
        next(entries)


@pytest.mark.parametrize(
    "raw",
    [
        b'<!DOCTYPE artists [<!ENTITY x "injected">]><artists><artist><name>&x;</name></artist></artists>',
        b'<!DOCTYPE artists SYSTEM "file:///etc/passwd"><artists/>',
    ],
)
def test_dump_rejects_dtd_and_entity_definitions(tmp_path, raw):
    path = tmp_path / "dump.xml"
    path.write_bytes(raw)
    with records(path, "artist") as entries, pytest.raises(DefusedXmlException):
        list(entries)


def test_dump_enforces_decompressed_byte_budgets(monkeypatch):
    monkeypatch.setattr("catalog.discogs_import.MAX_RECORD_BYTES", 10)
    with pytest.raises(ValueError, match="byte budget"):
        BoundedReader(io.BytesIO(b"x" * 100)).read(100)
    monkeypatch.setattr("catalog.discogs_import.MAX_XML_BYTES", 10)
    reader = BoundedReader(io.BytesIO(b"x" * 100))
    reader.read(8)
    reader.record_bytes = 0
    with pytest.raises(ValueError, match="byte budget"):
        reader.read(8)


@pytest.mark.integration
def test_dump_stop_and_invalid_record_are_explicit(store, tmp_path):
    path = tmp_path / "dump.xml"
    path.write_bytes(b"<artists><artist><id>1</id></artist></artists>")
    stop = Event()
    stop.set()
    assert import_discogs(store, path, "artist", stop) == {"imported": 0, "status": "interrupted"}
    with pytest.raises(ValueError, match="record 1"):
        import_discogs(store, path, "artist")
    with store.transaction() as conn:
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 0


@pytest.mark.integration
def test_discogs_flow_retains_identity_and_indexes_genre_metadata(store, vectors, embeddings):
    from catalog.indexer import index_batch
    from catalog.api import create_app
    from fastapi.testclient import TestClient

    store.settings = replace(store.settings, public_sources=("discogs",))
    with store.transaction() as conn:
        store.enqueue(conn, "discogs-lookup", "global", "album", "m504", 10)
    leased = store.claim_crawl()[0]
    source = Mock()
    source.fetch.return_value = album()
    process(store, source, leased)
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 100))
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        found = client.get("/v1/search", params={"q": "Fictional", "source": "discogs"}).json()
        assert found["results"][0]["key"] == "discogs:global:album:m504"
        detail = client.get("/v1/entities/discogs:global:album:m504").json()
        assert detail["annotations"]["styles"] == ["Ambient"]
    with store.transaction() as conn:
        assert (
            conn.execute("SELECT count(*) AS n FROM entities WHERE kind='song'").fetchone()["n"]
            == 0
        )
        assert conn.execute("SELECT max(version) AS n FROM catalog_schema").fetchone()["n"] == 8
        assert conn.execute("SELECT count(*) AS n FROM source_controls").fetchone()["n"] == 15
