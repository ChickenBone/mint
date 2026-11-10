from threading import Barrier, Event, Lock, get_ident
from dataclasses import replace
from unittest.mock import Mock

import pytest

from catalog.config import Settings
from catalog.vectors import Embeddings
from catalog.workers import run_workers


def test_workers_execute_concurrently_and_drain_on_shutdown():
    stop = Event()
    barrier = Barrier(4, timeout=5)
    identities = set()
    lock = Lock()

    def work():
        with lock:
            identities.add(get_ident())
        barrier.wait()
        stop.set()

    run_workers("test", 4, stop, work)
    assert len(identities) == 4


def test_worker_failure_stops_and_drains_siblings():
    stop = Event()
    barrier = Barrier(3, timeout=5)
    lock = Lock()
    started = 0
    drained = []

    def work():
        nonlocal started
        with lock:
            started += 1
            number = started
        barrier.wait()
        if number == 2:
            raise ValueError("worker failed")
        assert stop.wait(5)
        drained.append(number)

    with pytest.raises(ValueError, match="worker failed"):
        run_workers("test", 3, stop, work)
    assert sorted(drained) == [1, 3]
    assert stop.is_set()


def test_unexpected_normal_exit_is_not_reported_as_success():
    stop = Event()
    with pytest.raises(RuntimeError, match="exited before shutdown"):
        run_workers("test", 1, stop, lambda: None)
    assert stop.is_set()


def test_crawler_uses_shared_host_dispatch_instead_of_local_worker_lanes(monkeypatch):
    from catalog.crawler import crawl_worker

    stop = Event()
    store = Mock()
    transports = Mock()
    job = {"key": "fixture"}
    processed = 0

    def process(*args):
        nonlocal processed
        processed += 1
        if processed == 6:
            stop.set()

    store.claim_crawl.return_value = [job]
    monkeypatch.setattr("catalog.crawler.Sources", Mock(return_value=transports))
    monkeypatch.setattr("catalog.crawler.process", process)
    crawl_worker(store, stop)
    assert store.claim_crawl.call_count == 6
    store.claim.assert_not_called()
    assert processed == 6
    transports.close.assert_called_once()
    assert store.heartbeat.call_args.args[2] == "stopped"


@pytest.mark.parametrize("deferred", [False, True])
def test_crawler_failure_or_backoff_releases_every_batched_lease(monkeypatch, deferred):
    from catalog.crawler import crawl_worker
    from catalog.sources import Deferred

    stop = Event()
    store = Mock()
    jobs = [{"key": f"fixture-{n}", "attempts": 0} for n in range(3)]
    store.claim_crawl.return_value = jobs
    transports = Mock()

    def process(*args):
        assert args[2:] == (jobs[0], jobs[1:])
        stop.set()
        raise Deferred("Synthetic backoff", 120) if deferred else ValueError("Synthetic failure")

    monkeypatch.setattr("catalog.crawler.Sources", Mock(return_value=transports))
    monkeypatch.setattr("catalog.crawler.process", process)
    crawl_worker(store, stop)
    assert [call.args[0] for call in store.fail.call_args_list] == jobs
    assert all(call.kwargs.get("deferred", False) == deferred for call in store.fail.call_args_list)
    transports.close.assert_called_once()


@pytest.mark.parametrize(
    "name,value",
    [
        ("CRAWLER_WORKERS", "0"),
        ("CRAWLER_WORKERS", "33"),
        ("INDEXER_WORKERS", "0"),
        ("INDEXER_WORKERS", "9"),
        ("INDEX_BATCH_SIZE", "0"),
        ("INDEX_BATCH_SIZE", "257"),
        ("EMBEDDING_THREADS", "0"),
        ("EMBEDDING_THREADS", "33"),
    ],
)
def test_parallelism_settings_reject_unbounded_or_empty_pools(monkeypatch, name, value):
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused/unused")
    monkeypatch.setenv("CRAWLER_USER_AGENT", "CatalogTests/0.1 (https://example.org)")
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=name):
        Settings.load()


def test_parallelism_settings_are_loaded_from_environment(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused/unused")
    monkeypatch.setenv("CRAWLER_USER_AGENT", "CatalogTests/0.1 (https://example.org)")
    for name, value in {
        "CRAWLER_WORKERS": "12",
        "INDEXER_WORKERS": "3",
        "INDEX_BATCH_SIZE": "128",
        "EMBEDDING_THREADS": "4",
    }.items():
        monkeypatch.setenv(name, value)
    settings = Settings.load()
    assert (settings.crawler_workers, settings.indexer_workers) == (12, 3)
    assert (settings.batch_size, settings.embedding_threads) == (128, 4)


@pytest.mark.parametrize("value", ["nan", "inf", "0", "-1", "0.09", "3601", "bad"])
def test_request_intervals_reject_invalid_values(monkeypatch, value):
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused/unused")
    monkeypatch.setenv("CRAWLER_USER_AGENT", "CatalogTests/0.1 (https://example.org)")
    monkeypatch.setenv("SOURCE_INTERVAL_SECONDS", value)
    with pytest.raises(ValueError, match="SOURCE_INTERVAL_SECONDS"):
        Settings.load()


@pytest.mark.parametrize(
    "value", ["unknown=1", "apple=1,apple=2", "apple", "ytmusic=nan", "musicbrainz=0.5"]
)
def test_source_interval_overrides_reject_invalid_values(monkeypatch, value):
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused/unused")
    monkeypatch.setenv("CRAWLER_USER_AGENT", "CatalogTests/0.1 (https://example.org)")
    monkeypatch.setenv("SOURCE_INTERVAL_OVERRIDES", value)
    with pytest.raises(ValueError, match="SOURCE_INTERVAL_OVERRIDES"):
        Settings.load()


def test_request_intervals_allow_higher_independent_source_rates(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://unused/unused")
    monkeypatch.setenv("CRAWLER_USER_AGENT", "CatalogTests/0.1 (https://example.org)")
    monkeypatch.setenv("SOURCE_INTERVAL_SECONDS", "0.5")
    monkeypatch.setenv("SOURCE_INTERVAL_OVERRIDES", "ytmusic=0.25,deezer=0.1,musicbrainz=2")
    settings = Settings.load()
    assert settings.request_interval("apple") == 0.5
    assert settings.request_interval("ytmusic") == 0.25
    assert settings.request_interval("deezer") == 0.1
    assert settings.request_interval("musicbrainz") == 2
    assert settings.request_interval("apple", "musicbrainz.org") == 1
    assert replace(settings, source_intervals=()).request_interval("musicbrainz") == 1


def test_crawler_idle_polling_does_not_hide_fractional_request_rates(settings, monkeypatch):
    from catalog.crawler import crawl_worker

    store = Mock()
    store.settings = replace(settings, source_interval=0.25)
    store.claim_crawl.return_value = []
    store.crawl_delay.return_value = 0.03
    stop = Mock()
    stop.is_set.side_effect = [False, True]
    monkeypatch.setattr("catalog.crawler.Sources", Mock())
    crawl_worker(store, stop)
    stop.wait.assert_called_once_with(0.03)


def test_embedding_batch_and_cpu_threads_are_explicit(monkeypatch):
    constructor = Mock()
    monkeypatch.setattr("fastembed.TextEmbedding", constructor)
    vector = Mock()
    vector.tolist.return_value = [1.0]
    constructor.return_value.embed.return_value = [vector, vector]
    embeddings = Embeddings("/unused", threads=4)
    assert constructor.call_args.kwargs["threads"] == 4
    assert embeddings.documents(["first", "second"]) == [[1.0], [1.0]]
    constructor.return_value.embed.assert_called_once_with(["first", "second"], batch_size=2)
