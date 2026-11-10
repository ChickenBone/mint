import logging
import uuid
from threading import Event

import httpx
import psycopg
from qdrant_client.http.exceptions import ResponseHandlingException, UnexpectedResponse

from catalog.store import LeaseLost, Store
from catalog.vectors import Embeddings, Vectors
from catalog.workers import run_workers


log = logging.getLogger(__name__)
VECTOR_ERRORS = (ValueError, httpx.HTTPError, ResponseHandlingException, UnexpectedResponse)


def index_batch(store: Store, vectors: Vectors, embeddings: Embeddings, jobs: list[dict]):
    keys = [job["key"] for job in jobs]
    with store.transaction() as conn:
        rows = conn.execute(
            "SELECT key,document,revision,source,country,kind FROM entities WHERE key=ANY(%s)",
            (keys,),
        ).fetchall()
    documents = {row["key"]: row for row in rows}
    encoded = embeddings.documents([documents[job["key"]]["document"] for job in jobs])
    mapping = {job["key"]: vector for job, vector in zip(jobs, encoded, strict=True)}
    with store.transaction() as conn:
        conn.execute("SELECT entities FROM catalog_budget FOR UPDATE")
        ready = []
        for job in sorted(jobs, key=lambda value: value["key"]):
            # Use the same entity -> outbox lock order as ingestion.
            current = conn.execute(
                "SELECT revision,indexed_revision FROM entities WHERE key=%s FOR UPDATE",
                (job["key"],),
            ).fetchone()
            store.lock_job(conn, job, "vector_outbox")
            snapshot = documents[job["key"]]
            if current["revision"] != snapshot["revision"]:
                conn.execute(
                    """UPDATE vector_outbox SET lease_token=NULL,lease_until='-infinity'
                       WHERE key=%s""",
                    (job["key"],),
                )
                continue
            ready.append(snapshot)
        if ready:
            vectors.upsert(ready, [mapping[row["key"]] for row in ready])
        for row in ready:
            previous = conn.execute(
                "SELECT indexed_revision FROM entities WHERE key=%s", (row["key"],)
            ).fetchone()
            if previous["indexed_revision"] != row["revision"]:
                conn.execute(
                    "UPDATE source_metrics SET indexed=indexed+1 WHERE source=%s",
                    (row["source"],),
                )
            conn.execute(
                "UPDATE entities SET indexed_revision=%s WHERE key=%s",
                (row["revision"], row["key"]),
            )
            conn.execute("DELETE FROM vector_outbox WHERE key=%s", (row["key"],))
        if ready:
            store.activity(
                conn, "indexer", "indexed", f"Indexed {len(ready)} records", amount=len(ready)
            )
    log.info("indexed count=%s", len(ready))


def run(store: Store, stop: Event):
    run_workers("indexer", store.settings.indexer_workers, stop, lambda: index_worker(store, stop))


def index_worker(store: Store, stop: Event):
    worker = uuid.uuid4()
    store.heartbeat(worker, "indexer", "loading model")
    vectors = Vectors(store.settings)
    try:
        embeddings = Embeddings(
            store.settings.model_cache, threads=store.settings.embedding_threads
        )
        vectors.check()
        while not stop.is_set():
            jobs = []
            try:
                store.heartbeat(worker, "indexer", "idle")
                jobs = store.claim("vector_outbox", store.settings.batch_size)
                if not jobs:
                    stop.wait(2)
                    continue
                store.heartbeat(worker, "indexer", "embedding", jobs[0]["key"])
                index_batch(store, vectors, embeddings, jobs)
            except (*VECTOR_ERRORS, psycopg.Error, LeaseLost) as error:
                code = type(error).__name__
                log.exception("index_failed code=%s", code)
                for job in jobs:
                    store.fail(job, code, min(3600, 15 * 2 ** job["attempts"]), "vector_outbox")
                stop.wait(5)
    finally:
        vectors.close()
        store.heartbeat(worker, "indexer", "stopped")
