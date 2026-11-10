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
from catalog.model import DIMENSIONS
from conftest import ARTIST_ID, SONG_ID
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
