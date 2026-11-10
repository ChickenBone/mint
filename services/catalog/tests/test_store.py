from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest

from catalog.ranker import refresh_batch
from catalog.store import LeaseLost


pytestmark = pytest.mark.integration


def test_ingestion_is_idempotent_and_indexes_only_changed_documents(store, song):
    with store.transaction() as conn:
        assert store.ingest(conn, [song]) == 1
        first = conn.execute("SELECT revision FROM entities").fetchone()["revision"]
        assert store.ingest(conn, [song]) == 0
        assert conn.execute("SELECT revision FROM entities").fetchone()["revision"] == first
        assert conn.execute("SELECT count(*) AS n FROM vector_outbox").fetchone()["n"] == 1
        assert conn.execute("SELECT count(*) AS n FROM edges").fetchone()["n"] == 2
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 1
        store.ingest(conn, [replace(song, title="Changed")])
        assert conn.execute("SELECT revision FROM entities").fetchone()["revision"] > first


def test_low_quality_chart_does_not_destroy_enriched_metadata_or_edges(store, song):
    with store.transaction() as conn:
        store.ingest(conn, [song])
        store.ingest(
            conn,
            [
                replace(
                    song,
                    title="Partial title",
                    artist_keys=(),
                    album_keys=(),
                    quality=0,
                    origin="listenbrainz",
                )
            ],
        )
        row = conn.execute("SELECT title,origin FROM entities").fetchone()
        assert row == {"title": song.title, "origin": "musicbrainz"}
        assert conn.execute("SELECT count(*) AS n FROM edges").fetchone()["n"] == 2


def test_unchanged_relationships_and_job_priorities_do_not_generate_rewrites(store, song):
    with store.transaction() as conn:
        store.ingest(conn, [song])
        edges = conn.execute(
            "SELECT target,xmin::text AS version FROM edges ORDER BY target"
        ).fetchall()
        jobs = conn.execute("SELECT key,xmin::text AS version FROM jobs ORDER BY key").fetchall()
    with store.transaction() as conn:
        store.ingest(conn, [replace(song, title="Changed document, same relationships")])
        assert (
            conn.execute(
                "SELECT target,xmin::text AS version FROM edges ORDER BY target"
            ).fetchall()
            == edges
        )
        assert (
            conn.execute("SELECT key,xmin::text AS version FROM jobs ORDER BY key").fetchall()
            == jobs
        )
        target = song.artist_keys[0].split(":")
        store.enqueue(conn, "mb-lookup", target[1], target[2], target[3], 10)
        assert (
            conn.execute(
                "SELECT priority FROM jobs WHERE entity_key=%s", (song.artist_keys[0],)
            ).fetchone()["priority"]
            == 10
        )


def test_duplicate_keys_in_one_ingest_keep_capacity_quality_and_revision_counts_correct(
    store, song
):
    with store.transaction() as conn:
        assert (
            store.ingest(
                conn,
                [
                    song,
                    replace(song, title="Partial", quality=0),
                    replace(song, title="Updated"),
                ],
            )
            == 1
        )
        row = conn.execute("SELECT title,revision,indexed_revision FROM entities").fetchone()
        assert row["title"] == "Updated"
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 1
        assert conn.execute("SELECT entities,indexed FROM source_metrics").fetchone() == {
            "entities": 1,
            "indexed": 0,
        }
        assert (
            conn.execute("SELECT revision FROM vector_outbox").fetchone()["revision"]
            == row["revision"]
        )


def test_changed_credit_ids_update_edges_even_if_embedding_document_is_identical(store, song):
    with store.transaction() as conn:
        store.ingest(conn, [song])
        revision = conn.execute("SELECT revision FROM entities").fetchone()["revision"]
    with store.transaction() as conn:
        store.ingest(conn, [replace(song, artist_keys=())])
        assert conn.execute("SELECT revision FROM entities").fetchone()["revision"] == revision
        assert conn.execute("SELECT relation FROM edges").fetchall() == [{"relation": "album"}]


def test_heartbeat_coalesces_idle_writes_but_preserves_transitions_and_liveness(store):
    import uuid

    worker = uuid.uuid4()
    store.heartbeat(worker, "crawler", "waiting for eligible work")
    with store.transaction() as conn:
        before = conn.execute(
            "SELECT xmin::text AS version FROM workers WHERE id=%s", (worker,)
        ).fetchone()
    store.heartbeat(worker, "crawler", "waiting for eligible work")
    with store.transaction() as conn:
        assert (
            conn.execute(
                "SELECT xmin::text AS version FROM workers WHERE id=%s", (worker,)
            ).fetchone()
            == before
        )
        conn.execute("UPDATE workers SET seen_at=now()-interval '6 seconds' WHERE id=%s", (worker,))
    store.heartbeat(worker, "crawler", "waiting for eligible work")
    with store.transaction() as conn:
        assert conn.execute(
            "SELECT seen_at>now()-interval '1 second' AS live FROM workers WHERE id=%s", (worker,)
        ).fetchone()["live"]
    store.heartbeat(worker, "crawler", "fetching", "synthetic-job")
    with store.transaction() as conn:
        assert conn.execute(
            "SELECT state,job_key FROM workers WHERE id=%s", (worker,)
        ).fetchone() == {"state": "fetching", "job_key": "synthetic-job"}


def test_catalog_capacity_rolls_back_whole_batch(store, song):
    store.settings = replace(store.settings, max_entities=0)
    with pytest.raises(ValueError, match="capacity"):
        with store.transaction() as conn:
            store.ingest(conn, [song])
    with store.transaction() as conn:
        assert conn.execute("SELECT count(*) AS n FROM entities").fetchone()["n"] == 0
        assert conn.execute("SELECT entities FROM catalog_budget").fetchone()["entities"] == 0


def test_competing_workers_never_claim_same_live_lease(store):
    with store.transaction() as conn:
        for identifier in range(1, 21):
            store.enqueue(conn, "lookup", "us", "song", str(identifier))
    with ThreadPoolExecutor(max_workers=6) as pool:
        claims = list(pool.map(lambda _: store.claim(count=4), range(6)))
    keys = [job["key"] for jobs in claims for job in jobs]
    assert len(keys) == len(set(keys)) == 20


def test_expired_worker_cannot_commit_reclaimed_job(store):
    with store.transaction() as conn:
        store.enqueue(conn, "lookup", "us", "song", "123")
    old = store.claim()[0]
    with store.transaction() as conn:
        conn.execute("UPDATE jobs SET lease_until=now()-interval '1 second'")
    new = store.claim()[0]
    assert old["lease_token"] != new["lease_token"]
    with pytest.raises(LeaseLost):
        with store.transaction() as conn:
            store.complete(conn, old, 60)
    store.fail(old, "Late failure", 10)
    with store.transaction() as conn:
        assert (
            conn.execute("SELECT lease_token FROM jobs").fetchone()["lease_token"]
            == new["lease_token"]
        )


def test_dead_letter_and_deferred_work_are_distinct(store):
    with store.transaction() as conn:
        store.enqueue(conn, "lookup", "us", "song", "123")
    job = store.claim()[0]
    store.fail(job, "rate-limited", 30, deferred=True)
    with store.transaction() as conn:
        assert conn.execute("SELECT attempts FROM jobs").fetchone()["attempts"] == 0
        conn.execute("UPDATE jobs SET due_at=now(),attempts=7")
    job = store.claim()[0]
    store.fail(job, "Invalid source", 30)
    with store.transaction() as conn:
        assert conn.execute("SELECT dead FROM jobs").fetchone()["dead"]
    assert not store.claim()


def test_rate_limit_is_persistent_and_shared(store):
    assert store.reserve_host("musicbrainz.org", 1) == 0
    assert store.reserve_host("musicbrainz.org", 1) > 0
    store.pause_host("musicbrainz.org", 120)
    assert store.reserve_host("musicbrainz.org", 1) > 119
    assert store.reserve_host("itunes.apple.com", 4) == 0


def test_fractional_rate_budget_and_deferral_remain_fractional(store):
    with store.transaction() as conn:
        store.enqueue(conn, "lookup", "us", "song", "123")
    job = store.claim()[0]
    store.fail(job, "Host pacing", 0.25, deferred=True)
    with store.transaction() as conn:
        row = conn.execute(
            "SELECT extract(epoch FROM due_at-now()) AS wait,attempts FROM jobs"
        ).fetchone()
        assert 0 < row["wait"] <= 0.25
        assert row["attempts"] == 0
    assert store.reserve_host("itunes.apple.com", 0.5) == 0
    wait = store.reserve_host("itunes.apple.com", 0.5)
    assert 0 < wait <= 0.5
    store.pause_host("itunes.apple.com", 120)
    assert store.reserve_host("itunes.apple.com", 0.5) > 119


def test_concurrent_host_reservations_admit_only_one_request(store):
    from threading import Barrier

    barrier = Barrier(8, timeout=10)

    def reserve(_):
        barrier.wait()
        return store.reserve_host("musicbrainz.org", 60)

    with ThreadPoolExecutor(max_workers=8) as pool:
        waits = list(pool.map(reserve, range(8)))
    assert waits.count(0) == 1
    assert all(wait == 0 or wait > 50 for wait in waits)


def test_atomic_dispatch_admits_one_job_per_host_across_independent_pools(store):
    from catalog.store import Store
    from threading import Barrier

    with store.transaction() as conn:
        for identifier in range(1, 21):
            store.enqueue(conn, "lookup", "us", "song", str(identifier))
        store.enqueue(conn, "mb-lookup", "global", "artist", "00000000-0000-4000-8000-000000000001")
    replica = Store(store.settings)
    barrier = Barrier(8, timeout=10)

    def claim(index):
        barrier.wait()
        return (store if index % 2 else replica).claim_crawl()

    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            claims = [job for batch in pool.map(claim, range(8)) for job in batch]
        assert len(claims) == 21
        assert {job.get("request_host") for job in claims} == {
            None,
            "itunes.apple.com",
            "musicbrainz.org",
        }
        assert not store.claim_crawl()
        assert store.reserve_host("itunes.apple.com", 4) > 0
        with store.transaction() as conn:
            assert (
                conn.execute(
                    "SELECT count(*) AS n FROM jobs WHERE lease_token IS NOT NULL"
                ).fetchone()["n"]
                == 21
            )
            assert conn.execute("SELECT count(*) AS n FROM activity").fetchone()["n"] == 0
            assert conn.execute("SELECT sum(attempts) AS n FROM jobs").fetchone()["n"] == 0
    finally:
        replica.close()


def test_atomic_dispatch_per_host_lanes_retain_bulk_exploration_and_enrichment(store):
    store.settings = replace(store.settings, public_sources=("deezer",))
    with store.transaction() as conn:
        store.enqueue(conn, "deezer-lookup", "global", "song", "1", 0)
        store.enqueue(conn, "deezer-lookup", "global", "song", "2", 100)
        for identifier in ("3", "4", "5"):
            store.enqueue(conn, "deezer-lookup", "global", "album", identifier, 1)
        conn.execute("UPDATE jobs SET due_at=now()-interval '1 day' WHERE provider_id='1'")
    selected = []
    for _ in range(5):
        selected.extend(store.claim_crawl())
        with store.transaction() as conn:
            conn.execute("UPDATE host_budgets SET next_at='-infinity'")
    assert [job["kind"] for job in selected] == ["song", "album", "album", "album", "song"]
    assert [job["provider_id"] for job in selected][::4] == ["1", "2"]


def test_atomic_dispatch_falls_back_and_honors_pause_disable_backoff_and_lease(store):
    with store.transaction() as conn:
        store.enqueue(conn, "lookup", "us", "song", "1")
        conn.execute("UPDATE host_budgets SET crawl_sequence=1")
        conn.execute("UPDATE source_controls SET paused=true WHERE source='apple'")
    assert not store.claim_crawl()
    with store.transaction() as conn:
        conn.execute("UPDATE source_controls SET paused=false WHERE source='apple'")
    store.settings = replace(store.settings, apple_enabled=False)
    assert not store.claim_crawl()
    store.settings = replace(store.settings, apple_enabled=True)
    store.pause_host("itunes.apple.com", 60)
    assert not store.claim_crawl()
    assert 0.9 <= store.crawl_delay() <= 1
    with store.transaction() as conn:
        conn.execute(
            "UPDATE host_budgets SET next_at=now()+interval '250 milliseconds' WHERE host='itunes.apple.com'"
        )
    assert 0.02 < store.crawl_delay() <= 0.25
    with store.transaction() as conn:
        conn.execute("UPDATE host_budgets SET next_at='-infinity'")
    first = store.claim_crawl()[0]
    with store.transaction() as conn:
        conn.execute("UPDATE host_budgets SET next_at='-infinity'")
    assert not store.claim_crawl()
    assert store.crawl_delay() == 1
    with store.transaction() as conn:
        conn.execute("UPDATE jobs SET lease_until=now()-interval '1 second'")
    second = store.claim_crawl()[0]
    assert first["lease_token"] != second["lease_token"]
    with pytest.raises(LeaseLost), store.transaction() as conn:
        store.complete(conn, first, 60)


def test_apple_batches_keep_storefront_kind_size_and_failed_jobs_separate(store):
    with store.transaction() as conn:
        for country in ("us", "gb"):
            for kind in ("album", "artist", "song"):
                for identifier in range(1, 62):
                    store.enqueue(
                        conn,
                        "lookup",
                        country,
                        kind,
                        str(identifier),
                        100 if country == "us" and kind == "album" else 0,
                    )
        conn.execute(
            "UPDATE jobs SET attempts=1,priority=1000 WHERE country='us' AND kind='album' AND provider_id='1'"
        )
        conn.execute("UPDATE host_budgets SET crawl_sequence=4 WHERE host='itunes.apple.com'")
    assert len(store.claim_crawl()) == 1
    with store.transaction() as conn:
        conn.execute("UPDATE host_budgets SET next_at='-infinity',crawl_sequence=4")
    jobs = store.claim_crawl()
    assert len(jobs) == 5
    assert {(job["source"], job["country"], job["kind"]) for job in jobs} == {
        ("apple", "us", "album")
    }
    assert jobs[0]["lookup_ids"] == [job["provider_id"] for job in jobs]
    with store.transaction() as conn:
        conn.execute("UPDATE host_budgets SET next_at='-infinity'")
        conn.execute("UPDATE jobs SET priority=200 WHERE kind='song' AND country='gb'")
        conn.execute("UPDATE host_budgets SET crawl_sequence=4 WHERE host='itunes.apple.com'")
    jobs = store.claim_crawl()
    assert len(jobs) == 50
    assert {(job["country"], job["kind"]) for job in jobs} == {("gb", "song")}


def test_dispatch_delay_handles_persisted_infinite_host_budgets(store):
    with store.transaction() as conn:
        store.enqueue(conn, "lookup", "us", "song", "1")
    assert store.crawl_delay() == 0.02
    store.pause_host("itunes.apple.com", 31536001)
    assert store.crawl_delay() == 1
    assert not store.claim_crawl()


@pytest.mark.parametrize("paused", [False, True])
def test_dispatch_ticket_cannot_bypass_later_backoff_or_reuse_an_expired_slot(store, paused):
    import httpx
    from catalog.sources import Deferred, Sources

    with store.transaction() as conn:
        store.enqueue(conn, "lookup", "us", "song", "1")
    job = store.claim_crawl()[0]
    sent = []
    sources = Sources(store, store.settings)
    sources.client.close()
    sources.client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: sent.append(request) or httpx.Response(200, json={})
        )
    )
    try:
        if paused:
            store.pause_host("itunes.apple.com", 120)
            with pytest.raises(Deferred):
                sources.fetch(job)
            assert not sent
        else:
            with store.transaction() as conn:
                conn.execute("UPDATE host_budgets SET next_at=now()-interval '1 second'")
            assert sources.fetch(job) == {}
            assert len(sent) == 1
            assert store.reserve_host("itunes.apple.com", 4) > 0
    finally:
        sources.close()


def test_popularity_propagates_only_over_explicit_relationships_and_decays(store, song):
    from catalog.model import Entity

    artist_key = song.artist_keys[0]
    artist = Entity(
        artist_key,
        "global",
        "artist",
        artist_key.split(":")[-1],
        "An Artist",
        "An Artist",
        "",
        (),
        "https://musicbrainz.org/artist/" + artist_key.split(":")[-1],
        source="musicbrainz",
        origin="musicbrainz",
    )
    with store.transaction() as conn:
        store.ingest(conn, [song, artist])
        store.signals(conn, "listenbrainz:weekly", [(song, 1)])
    assert refresh_batch(store) is not None
    with store.transaction() as conn:
        scores = {
            row["key"]: row["popularity"]
            for row in conn.execute("SELECT key,popularity FROM entities").fetchall()
        }
        assert scores[song.key] > scores[artist_key] > 0
        conn.execute("UPDATE chart_signals SET observed_at=now()-interval '30 days'")
    refresh_batch(store)
    with store.transaction() as conn:
        assert (
            conn.execute("SELECT popularity FROM entities WHERE key=%s", (song.key,)).fetchone()[
                "popularity"
            ]
            < scores[song.key] * 0.02
        )


def test_exploration_lane_does_not_starve_old_low_priority_work(store):
    with store.transaction() as conn:
        store.enqueue(conn, "lookup", "us", "song", "1", 0)
        store.enqueue(conn, "lookup", "us", "song", "2", 100)
        conn.execute("UPDATE jobs SET due_at=now()-interval '1 day' WHERE provider_id='1'")
    assert store.claim(explore=False)[0]["provider_id"] == "2"
    assert store.claim(explore=True)[0]["provider_id"] == "1"


def test_expansion_lane_selects_bulk_pages_before_high_priority_single_lookups(store):
    with store.transaction() as conn:
        store.enqueue(conn, "lookup", "us", "song", "1", 100)
        store.enqueue(
            conn,
            "mb-songs",
            "global",
            "artist",
            "00000000-0000-4000-8000-000000000001",
            0,
        )
    assert store.claim(expand=True)[0]["task"] == "mb-songs"
    assert store.claim()[0]["provider_id"] == "1"
    assert store.claim(expand=True) == []


@pytest.mark.parametrize("source,task", [("apple", "lookup"), ("deezer", "deezer-lookup")])
def test_expansion_lane_includes_artist_and_album_expansion_not_single_songs(store, source, task):
    store.settings = replace(store.settings, public_sources=("deezer",))
    country = "us" if source == "apple" else "global"
    with store.transaction() as conn:
        store.enqueue(conn, task, country, "song", "1", 100)
        store.enqueue(conn, task, country, "album", "2", 1)
        store.enqueue(conn, task, country, "artist", "3", 0)
    assert {job["kind"] for job in store.claim(expand=True, count=3)} == {"album", "artist"}
    assert store.claim()[0]["kind"] == "song"


def test_expansion_lane_preserves_source_pause_and_host_backoff(store):
    with store.transaction() as conn:
        store.enqueue(
            conn,
            "mb-songs",
            "global",
            "artist",
            "00000000-0000-4000-8000-000000000001",
            0,
        )
        conn.execute("UPDATE source_controls SET paused=true WHERE source='musicbrainz'")
    assert store.claim(expand=True) == []
    with store.transaction() as conn:
        conn.execute("UPDATE source_controls SET paused=false WHERE source='musicbrainz'")
    store.pause_host("musicbrainz.org", 60)
    assert store.claim(expand=True) == []


def test_ranker_resets_unobserved_scores_without_rewriting_unchanged_rows(store, song):
    with store.transaction() as conn:
        store.ingest(conn, [song])
        before = conn.execute("SELECT xmin::text AS version FROM entities").fetchone()["version"]
        job_before = {
            row["key"]: row["version"]
            for row in conn.execute("SELECT key,xmin::text AS version FROM jobs").fetchall()
        }
    refresh_batch(store)
    with store.transaction() as conn:
        assert (
            conn.execute("SELECT xmin::text AS version FROM entities").fetchone()["version"]
            == before
        )
        assert {
            row["key"]: row["version"]
            for row in conn.execute("SELECT key,xmin::text AS version FROM jobs").fetchall()
        } == job_before
        conn.execute("UPDATE entities SET popularity=10")
        conn.execute("UPDATE jobs SET priority=20")
    refresh_batch(store)
    with store.transaction() as conn:
        assert conn.execute("SELECT popularity FROM entities").fetchone()["popularity"] == 0
        assert all(
            row["priority"] == 0
            for row in conn.execute("SELECT priority FROM jobs WHERE entity_key=%s", (song.key,))
        )


def test_scheduled_refreshes_return_to_ready_lane_only_when_due(store):
    with store.transaction() as conn:
        store.enqueue(conn, "lookup", "us", "song", "1")
    job = store.claim()[0]
    with store.transaction() as conn:
        store.complete(conn, job, 60)
    assert store.claim() == []
    with store.transaction() as conn:
        conn.execute("UPDATE jobs SET due_at=now()-interval '1 second'")
    assert store.claim()[0]["key"] == job["key"]


def test_reindex_is_bounded_idempotent_and_rebuilds_outbox(store, song):
    with store.transaction() as conn:
        store.ingest(conn, [song])
        conn.execute("DELETE FROM vector_outbox")
        conn.execute("UPDATE entities SET indexed_revision=revision")
    assert store.reindex_batch(batch_size=1) == song.key
    assert store.reindex_batch(after=song.key, batch_size=1) is None
    assert store.reindex_batch(batch_size=1) == song.key
    with store.transaction() as conn:
        assert conn.execute("SELECT count(*) AS n FROM vector_outbox").fetchone()["n"] == 1
        assert (
            conn.execute("SELECT indexed_revision FROM entities").fetchone()["indexed_revision"]
            is None
        )


def test_extreme_retry_after_quarantines_host_instead_of_overflowing(store):
    store.pause_host("itunes.apple.com", 10**30)
    assert store.reserve_host("itunes.apple.com", 4) == 86400
