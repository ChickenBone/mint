from dataclasses import replace
from datetime import datetime, timezone
from email.utils import format_datetime
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from catalog.api import create_app
from catalog.crawler import process
from catalog.importer import import_jsonl
from catalog.indexer import index_batch
from catalog.model import DIMENSIONS, entity_key, musicbrainz_entity
from conftest import ALBUM_ID, ARTIST_ID, SONG_ID
from test_model import chart


pytestmark = pytest.mark.integration


def test_chart_ingestion_is_atomic_and_queues_popular_neighbors(store):
    store.seed()
    payload = chart()
    payload["feed"]["updated"] = format_datetime(datetime.now(timezone.utc))
    sources = Mock()
    sources.fetch.return_value = payload
    jobs = store.claim(count=10)
    job = next(job for job in jobs if job["task"] == "chart" and job["country"] == "us")
    process(store, sources, job)
    with store.transaction() as conn:
        assert conn.execute("SELECT count(*) AS n FROM chart_signals").fetchone()["n"] == 1
        priorities = conn.execute(
            "SELECT priority FROM jobs WHERE task='lookup' ORDER BY priority DESC"
        ).fetchall()
        assert priorities[0]["priority"] > priorities[1]["priority"] > 0


def test_batched_apple_lookup_completes_every_lease_atomically(store):
    with store.transaction() as conn:
        for identifier in ("1", "2", "3"):
            store.enqueue(conn, "lookup", "us", "song", identifier)
    jobs = store.claim_crawl()
    assert len(jobs) == 3
    sources = Mock()
    sources.fetch.return_value = {
        "resultCount": 3,
        "results": [
            {
                "wrapperType": "track",
                "kind": "song",
                "trackId": n,
                "trackName": f"Synthetic {n}",
                "artistId": 99,
                "collectionId": 88,
                "artistName": "Synthetic",
                "trackViewUrl": f"https://music.apple.com/us/song/{n}",
            }
            for n in (1, 2, 3)
        ],
    }
    process(store, sources, jobs[0], jobs[1:])
    with store.transaction() as conn:
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 3
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM jobs WHERE kind='song' AND NOT ready AND lease_token IS NULL AND due_at>now()"
            ).fetchone()["n"]
            == 3
        )
        assert conn.execute("SELECT count(*) AS n FROM vector_outbox").fetchone()["n"] == 3


def test_batched_apple_lookup_cannot_publish_after_one_companion_lease_is_lost(store):
    from catalog.store import LeaseLost

    with store.transaction() as conn:
        for identifier in ("1", "2"):
            store.enqueue(conn, "lookup", "us", "album", identifier)
    jobs = store.claim_crawl()
    sources = Mock()
    sources.fetch.return_value = {"resultCount": 0, "results": []}
    with store.transaction() as conn:
        conn.execute("UPDATE jobs SET lease_token=NULL WHERE key=%s", (jobs[1]["key"],))
    with pytest.raises(LeaseLost):
        process(store, sources, jobs[0], jobs[1:])
    with store.transaction() as conn:
        assert (
            conn.execute("SELECT count(*) AS n FROM jobs WHERE lease_token IS NOT NULL").fetchone()[
                "n"
            ]
            == 1
        )
        assert conn.execute("SELECT count(*) AS n FROM activity").fetchone()["n"] == 0


def test_mb_artist_expands_into_independently_paged_discography(store):
    with store.transaction() as conn:
        store.enqueue(conn, "mb-lookup", "global", "artist", ARTIST_ID, 20)
    sources = Mock()
    sources.fetch.return_value = {"id": ARTIST_ID, "name": "Example Artist"}
    process(store, sources, store.claim()[0])
    with store.transaction() as conn:
        tasks = {row["task"] for row in conn.execute("SELECT task FROM jobs").fetchall()}
    assert {"mb-albums", "mb-songs", "mb-lookup"} == tasks
    sources.fetch.return_value = {
        "recording-count": 101,
        "recordings": [
            {
                "id": SONG_ID,
                "title": "First",
                "artist-credit": [
                    {
                        "name": "Example Artist",
                        "artist": {"id": ARTIST_ID},
                    }
                ],
            }
        ],
    }
    jobs = store.claim(count=5)
    job = next(job for job in jobs if job["task"] == "mb-songs")
    process(store, sources, job)
    with store.transaction() as conn:
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM jobs WHERE task='mb-songs' AND page=1"
            ).fetchone()["n"]
            == 1
        )


def test_mb_album_release_browse_repairs_partial_album_and_preserves_existing_memberships(store):
    release_id = "00000000-0000-4000-8000-000000000004"
    other_album = "00000000-0000-4000-8000-000000000005"
    album_key = entity_key("global", "album", ALBUM_ID, "musicbrainz")
    other_key = entity_key("global", "album", other_album, "musicbrainz")
    song = musicbrainz_entity("song", {
        "id": SONG_ID, "title": "Enriched",
        "artist-credit": [{"artist": {"id": ARTIST_ID, "name": "Artist"}}],
        "releases": [{"release-group": {"id": other_album}}],
    })
    with store.transaction() as conn:
        store.ingest(conn, [song], schedule=False)
        store.enqueue(conn, "mb-releases", "global", "album", ALBUM_ID)
    sources = Mock()
    sources.fetch.return_value = {"releases": [{"id": release_id}]}
    process(store, sources, store.claim()[0])
    sources.fetch.return_value = {
        "recording-count": 2,
        "recordings": [{"id": SONG_ID, "title": "Partial"}],
    }
    process(store, sources, store.claim()[0])
    with store.transaction() as conn:
        rows = conn.execute(
            "SELECT target FROM edges WHERE source=%s AND relation='album'", (song.key,)
        ).fetchall()
        assert {row["target"] for row in rows} == {album_key, other_key}
        assert conn.execute("SELECT title FROM entities WHERE key=%s", (song.key,)).fetchone()[
            "title"
        ] == "Enriched"
        assert conn.execute(
            "SELECT count(*) AS n FROM jobs WHERE task='mb-release' AND page=1"
        ).fetchone()["n"] == 1


def test_mb_artist_discography_reaches_album_recordings(store):
    release_id = "00000000-0000-4000-8000-000000000004"
    sources = Mock()

    def run(task, payload, kind=None):
        jobs = store.claim(count=100)
        selected = next(row for row in jobs if row["task"] == task and (
            kind is None or row["kind"] == kind
        ))
        with store.transaction() as conn:
            for other in jobs:
                if other["key"] != selected["key"]:
                    conn.execute(
                        "UPDATE jobs SET lease_token=NULL,lease_until='-infinity' WHERE key=%s",
                        (other["key"],),
                    )
        sources.fetch.return_value = payload
        process(store, sources, selected)

    credit = [{"artist": {"id": ARTIST_ID, "name": "Artist"}}]
    with store.transaction() as conn:
        store.enqueue(conn, "mb-lookup", "global", "artist", ARTIST_ID)
    run("mb-lookup", {"id": ARTIST_ID, "name": "Artist"}, "artist")
    run("mb-albums", {
        "release-group-count": 1,
        "release-groups": [{"id": ALBUM_ID, "title": "Album", "artist-credit": credit}],
    })
    run("mb-lookup", {"id": ALBUM_ID, "title": "Album", "artist-credit": credit}, "album")
    run("mb-releases", {"releases": [{"id": release_id}]})
    run("mb-release", {
        "recording-count": 1,
        "recordings": [{"id": SONG_ID, "title": "Song", "artist-credit": credit}],
    })
    with store.transaction() as conn:
        assert conn.execute(
            "SELECT count(*) AS n FROM edges WHERE source=%s AND target=%s AND relation='album'",
            (entity_key("global", "song", SONG_ID, "musicbrainz"),
             entity_key("global", "album", ALBUM_ID, "musicbrainz")),
        ).fetchone()["n"] == 1


def test_ranker_schedules_bounded_existing_albums_and_prioritizes_observed_artist(store):
    from catalog.ranker import refresh_batch

    artist = musicbrainz_entity("artist", {"id": ARTIST_ID, "name": "Artist"})
    albums = [
        musicbrainz_entity("album", {
            "id": album_id, "title": "Album",
            "artist-credit": [{"artist": {"id": ARTIST_ID, "name": "Artist"}}],
        })
        for album_id in (ALBUM_ID, "00000000-0000-4000-8000-000000000005")
    ]
    with store.transaction() as conn:
        store.ingest(conn, [artist, *albums], schedule=False)
        conn.execute(
            """INSERT INTO chart_signals(chart,key,rank,weight,observed_at)
               VALUES ('fixture',%s,1,1,now())""",
            (artist.key,),
        )
    refresh_batch(store)
    refresh_batch(store)
    with store.transaction() as conn:
        jobs = conn.execute(
            "SELECT entity_key,priority FROM jobs WHERE task='mb-releases' ORDER BY entity_key"
        ).fetchall()
        assert len(jobs) == 2 and all(row["priority"] > 0 for row in jobs)
        assert conn.execute(
            "SELECT count(*) AS n FROM jobs WHERE task='mb-releases'"
        ).fetchone()["n"] == 2


def test_repair_admission_is_bounded_and_preferred_artist_wins_without_starving_others(store):
    from catalog.ranker import refresh_batch

    artist = musicbrainz_entity("artist", {"id": ARTIST_ID, "name": "Artist"})
    albums = [
        musicbrainz_entity("album", {
            "id": f"10000000-0000-4000-8000-{number:012d}", "title": f"Album {number}",
            "artist-credit": (
                [{"artist": {"id": ARTIST_ID, "name": "Artist"}}] if number == 50 else []
            ),
        })
        for number in range(51)
    ]
    with store.transaction() as conn:
        store.ingest(conn, [artist, *albums], schedule=False)
        conn.execute(
            "INSERT INTO priority_artists(entity_key,provenance) VALUES (%s,'library-export')",
            (artist.key,),
        )
    refresh_batch(store)
    with store.transaction() as conn:
        jobs = conn.execute(
            "SELECT entity_key,priority FROM jobs WHERE task='mb-releases'"
        ).fetchall()
    assert len(jobs) == 50
    preferred = next(row for row in jobs if row["entity_key"] == albums[-1].key)
    assert preferred["priority"] == 10
    assert any(row["priority"] == 0 for row in jobs)
    refresh_batch(store)
    with store.transaction() as conn:
        assert conn.execute(
            "SELECT count(*) AS n FROM jobs WHERE task='mb-releases'"
        ).fetchone()["n"] == 51


def test_repair_reserves_admission_for_popular_albums_when_unranked_queue_is_full(store):
    from catalog.ranker import refresh_batch

    artist = musicbrainz_entity("artist", {"id": ARTIST_ID, "name": "Artist"})
    album = musicbrainz_entity("album", {
        "id": ALBUM_ID, "title": "Album",
        "artist-credit": [{"artist": {"id": ARTIST_ID, "name": "Artist"}}],
    })
    with store.transaction() as conn:
        store.ingest(conn, [artist, album], schedule=False)
        conn.execute(
            """INSERT INTO chart_signals(chart,key,rank,weight,observed_at)
               VALUES ('fixture',%s,1,1,now())""",
            (artist.key,),
        )
        conn.execute(
            """INSERT INTO jobs(key,task,country,kind,provider_id,source,host,priority)
               SELECT 'unranked:'||n,'mb-releases','global','album','unused',
                 'musicbrainz','musicbrainz.org',0 FROM generate_series(1,800) n"""
        )
    refresh_batch(store)
    with store.transaction() as conn:
        job = conn.execute(
            "SELECT priority FROM jobs WHERE task='mb-releases' AND entity_key=%s",
            (album.key,),
        ).fetchone()
    assert job is not None and job["priority"] > 0


def test_artist_priority_labels_are_independent_and_recalculate_album_jobs(store):
    from catalog.ranker import refresh_batch

    artist = musicbrainz_entity("artist", {"id": ARTIST_ID, "name": "Artist"})
    album = musicbrainz_entity("album", {
        "id": ALBUM_ID, "title": "Album",
        "artist-credit": [{"artist": {"id": ARTIST_ID, "name": "Artist"}}],
    })
    with store.transaction() as conn:
        store.ingest(conn, [artist, album], schedule=False)
        assert store.priority_artist(conn, ARTIST_ID, "mint-library") == 1
        assert store.priority_artist(conn, ARTIST_ID, "library-export") == 1
        assert store.priority_artist(conn, ARTIST_ID, "mint-library") == 0
        assert store.priority_artist(conn, ARTIST_ID, "mint-library", remove=True) == 1
    refresh_batch(store)
    with store.transaction() as conn:
        assert conn.execute(
            "SELECT priority FROM jobs WHERE task='mb-releases' AND entity_key=%s", (album.key,)
        ).fetchone()["priority"] == 10
        assert store.priority_artist(conn, ARTIST_ID, "library-export", remove=True) == 1
    refresh_batch(store)
    with store.transaction() as conn:
        assert conn.execute(
            "SELECT priority FROM jobs WHERE task='mb-releases' AND entity_key=%s", (album.key,)
        ).fetchone()["priority"] == 0


def test_musicbrainz_genre_enrichment_updates_document_and_graph_without_inventing_tags(
    store, song
):
    from catalog.catalog_network import catalog_network

    with store.transaction() as conn:
        store.ingest(conn, [song])
    job = next(job for job in store.claim(count=10) if job["entity_key"] == song.key)
    sources = Mock()
    sources.fetch.return_value = {
        "id": SONG_ID,
        "title": song.title,
        "genres": [{"name": "Electronic", "count": 3}],
        "artist-credit": [{"artist": {"id": ARTIST_ID, "name": "Example Artist"}}],
    }
    process(store, sources, job)
    with store.transaction() as conn:
        row = conn.execute(
            "SELECT genres,document FROM entities WHERE key=%s", (song.key,)
        ).fetchone()
        assert row["genres"] == ["Electronic"]
        assert "Electronic" in row["document"]
        assert any(node["key"] == "genre:electronic" for node in catalog_network(conn)["nodes"])


def test_outbox_indexes_vectors_and_acks_revision(store, song, vectors, embeddings):
    with store.transaction() as conn:
        store.ingest(conn, [song])
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 16))
    with store.transaction() as conn:
        row = conn.execute("SELECT revision,indexed_revision FROM entities").fetchone()
        assert row["revision"] == row["indexed_revision"]
        assert conn.execute("SELECT count(*) AS n FROM vector_outbox").fetchone()["n"] == 0
    assert (
        vectors.search(embeddings.query("music"), {"source": "musicbrainz"}, 10)[0]["key"]
        == song.key
    )
    assert vectors.search(embeddings.query("music"), {"source": "apple"}, 10) == []


def test_document_changes_during_embedding_do_not_publish_stale_vectors(
    store,
    song,
    vectors,
    embeddings,
):
    with store.transaction() as conn:
        store.ingest(conn, [song])
    jobs = store.claim("vector_outbox", 16)

    class ConcurrentChange:
        def documents(self, documents):
            with store.transaction() as conn:
                store.ingest(conn, [replace(song, title="New title")])
            return [[1.0, *([0.0] * (DIMENSIONS - 1))]]

    index_batch(store, vectors, ConcurrentChange(), jobs)
    assert vectors.search(embeddings.query("music"), {}, 10) == []
    assert len(store.claim("vector_outbox", 16)) == 1


def test_reclaimed_index_lease_rejects_old_worker(store, song, vectors, embeddings):
    from catalog.store import LeaseLost

    with store.transaction() as conn:
        store.ingest(conn, [song])
    old = store.claim("vector_outbox", 16)
    with store.transaction() as conn:
        conn.execute("UPDATE vector_outbox SET lease_until=now()-interval '1 second'")
    new = store.claim("vector_outbox", 16)
    with pytest.raises(LeaseLost):
        index_batch(store, vectors, embeddings, old)
    assert vectors.search(embeddings.query("music"), {}, 10) == []
    index_batch(store, vectors, embeddings, new)
    assert vectors.search(embeddings.query("music"), {}, 10)[0]["key"] == song.key


def test_hybrid_search_filters_detail_and_explicit_degradation(store, song, vectors, embeddings):
    with store.transaction() as conn:
        store.ingest(conn, [song])
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 16))
    app = create_app(store.settings, store, vectors, embeddings)
    with TestClient(app) as client:
        assert client.get("/readyz").status_code == 200
        response = client.get("/v1/search", params={"q": "Northern", "kind": "song"})
        assert response.status_code == 200, response.text
        assert response.json()["results"][0]["key"] == song.key
        assert response.headers["cache-control"] == "no-store"
        assert (
            client.get("/v1/search", params={"q": "Northern", "source": "apple"}).json()["results"]
            == []
        )
        detail = client.get(f"/v1/entities/{song.key}").json()
        assert len(detail["edges"]) == 2
        assert client.get("/v1/search", params={"q": " ", "limit": 1}).status_code == 422
        assert client.get("/v1/search", params={"q": "Northern", "limit": 51}).status_code == 422
        original = vectors.search
        vectors.search = Mock(side_effect=ValueError("Unavailable"))
        assert client.get("/v1/search", params={"q": "Northern"}).status_code == 503
        assert (
            client.get("/v1/search", params={"q": "Northern", "mode": "lexical"}).json()["results"][
                0
            ]["key"]
            == song.key
        )
        vectors.search = original


def test_search_rejects_stale_vector_revisions(store, song, vectors, embeddings):
    with store.transaction() as conn:
        store.ingest(conn, [song])
    index_batch(store, vectors, embeddings, store.claim("vector_outbox", 16))
    with store.transaction() as conn:
        store.ingest(conn, [replace(song, title="New title")])
    with TestClient(create_app(store.settings, store, vectors, embeddings)) as client:
        response = client.get("/v1/search", params={"q": "unrelated"})
        assert response.status_code == 200
        assert response.json()["results"] == []


def test_streaming_normalized_import_is_idempotent_and_reports_bad_lines(store, tmp_path):
    import json

    path = tmp_path / "import.jsonl"
    path.write_text(
        json.dumps(
            {
                "source": "musicbrainz",
                "country": "global",
                "kind": "song",
                "provider_id": SONG_ID,
                "title": "Imported",
                "artist": "Example Artist",
                "artist_ids": [ARTIST_ID],
            }
        )
        + "\n"
    )
    assert import_jsonl(store, str(path)) == 1
    assert import_jsonl(store, str(path)) == 1
    with store.transaction() as conn:
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 1
    path.write_text("invalid\n")
    with pytest.raises(ValueError, match="line 1"):
        import_jsonl(store, str(path))


def test_interrupted_import_stops_before_reading_more_records(store, tmp_path):
    from threading import Event

    path = tmp_path / "import.jsonl"
    path.write_text("invalid\n")
    stop = Event()
    stop.set()
    assert import_jsonl(store, str(path), stop) == 0


def test_crawler_pool_fetches_concurrently_with_independent_sessions(store, monkeypatch):
    from threading import Barrier, Event, Lock

    from catalog import crawler

    store.settings = replace(store.settings, crawler_workers=4)
    with store.transaction() as conn:
        for number in range(1, 5):
            store.enqueue(conn, "mb-lookup", "global", "song", f"{SONG_ID[:-1]}{number}")
    stop = Event()
    barrier = Barrier(4, timeout=10)
    lock = Lock()
    sessions = []
    completed = 0
    original = crawler.process

    class Session:
        def __init__(self, *_):
            self.closed = False
            sessions.append(self)

        def fetch(self, job):
            barrier.wait()
            return {"id": job["provider_id"], "title": "Concurrent fixture"}

        def close(self):
            self.closed = True

    def process(*args):
        nonlocal completed
        original(*args)
        with lock:
            completed += 1
            if completed == 4:
                stop.set()

    monkeypatch.setattr(store, "seed", Mock())
    monkeypatch.setattr(crawler, "Sources", Session)
    monkeypatch.setattr(crawler, "process", process)
    crawler.run(store, stop)
    store.seed.assert_called_once()
    assert len(sessions) == 4
    assert all(session.closed for session in sessions)
    with store.transaction() as conn:
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 4
        assert conn.execute("SELECT count(*) AS n FROM jobs WHERE attempts<>0").fetchone()["n"] == 0
        workers = conn.execute("SELECT state FROM workers WHERE role='crawler'").fetchall()
        assert len(workers) == 4
        assert all(worker["state"] == "stopped" for worker in workers)


def test_index_pool_embeds_concurrently_and_acks_disjoint_batches(store, song, monkeypatch):
    from threading import Barrier, Event, Lock

    from catalog import indexer

    store.settings = replace(store.settings, indexer_workers=2, batch_size=1, embedding_threads=3)
    with store.transaction() as conn:
        store.ingest(
            conn,
            [
                replace(
                    song,
                    key=song.key[:-1] + str(number),
                    provider_id=SONG_ID[:-1] + str(number),
                )
                for number in range(1, 5)
            ],
        )
    stop = Event()
    barrier = Barrier(2, timeout=10)
    lock = Lock()
    clients = []
    models = []
    published = []

    class Client:
        def __init__(self, *_):
            self.closed = False
            clients.append(self)

        def check(self):
            pass

        def upsert(self, rows, vectors):
            assert len(rows) == len(vectors) == 1
            with lock:
                published.append(rows[0]["key"])
                if len(published) == 4:
                    stop.set()

        def close(self):
            self.closed = True

    class Model:
        def __init__(self, cache, *, threads):
            assert threads == 3
            models.append(self)

        def documents(self, documents):
            barrier.wait()
            return [[1.0] * DIMENSIONS for _ in documents]

    monkeypatch.setattr(indexer, "Vectors", Client)
    monkeypatch.setattr(indexer, "Embeddings", Model)
    indexer.run(store, stop)
    assert len(clients) == len(models) == 2
    assert all(client.closed for client in clients)
    assert len(published) == len(set(published)) == 4
    with store.transaction() as conn:
        assert conn.execute("SELECT count(*) AS n FROM vector_outbox").fetchone()["n"] == 0
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM entities WHERE revision=indexed_revision"
            ).fetchone()["n"]
            == 4
        )
        assert conn.execute("SELECT sum(indexed) AS n FROM source_metrics").fetchone()["n"] == 4
        workers = conn.execute("SELECT state FROM workers WHERE role='indexer'").fetchall()
        assert len(workers) == 2
        assert all(worker["state"] == "stopped" for worker in workers)
