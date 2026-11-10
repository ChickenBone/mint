import hashlib
import logging
from contextlib import contextmanager

from psycopg.types.json import Jsonb

from catalog.youtube import Discovery


log = logging.getLogger(__name__)
BATCH_SIZE = 2048
MAX_INPUT_BYTES = 2 * 1024**4
MAX_LINE_BYTES = 64 * 1024**2


def fingerprint(path, stop=None):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        while chunk := stream.read(8 * 1024**2):
            if stop and stop.is_set():
                raise InterruptedError("Import stopped while verifying its input")
            digest.update(chunk)
    return digest.hexdigest()


@contextmanager
def import_run(store, path, source, kind, stop=None):
    checksum = fingerprint(path, stop)
    identifier = hashlib.sha256(f"{source}:{kind}:{checksum}".encode()).hexdigest()
    lock = int.from_bytes(bytes.fromhex(identifier[:16]), signed=True)
    with store.pool.connection() as guard:
        held = False
        try:
            held = guard.execute("SELECT pg_try_advisory_lock(%s) AS held", (lock,)).fetchone()[
                "held"
            ]
            if not held:
                raise ValueError("This database snapshot is already being imported")
            guard.commit()
            with store.transaction() as conn:
                conn.execute(
                    """INSERT INTO import_runs(id,source,kind,fingerprint) VALUES (%s,%s,%s,%s)
                       ON CONFLICT DO NOTHING""",
                    (identifier, source, kind, checksum),
                )
                state = conn.execute(
                    "SELECT * FROM import_runs WHERE id=%s", (identifier,)
                ).fetchone()
            yield BulkWriter(store, identifier, state)
        finally:
            guard.rollback()
            if held:
                guard.execute("SELECT pg_advisory_unlock(%s)", (lock,))
                guard.commit()


class BulkWriter:
    def __init__(self, store, identifier, state):
        self.store = store
        self.identifier = identifier
        self.records = state["records"]
        self.observations = state["observations"]
        self.complete = state["status"] == "complete"
        self.pending_records = self.records
        self.entities = []
        self.annotations = []
        self.metrics = []
        self.edges = []
        self.links = []

    def add(self, discovery, record):
        # A large source record may span transactions; its cursor advances only
        # with its last chunk, so a crash safely replays any earlier chunks.
        annotations = dict(discovery.annotations)
        metrics = {}
        links = {}
        for link in discovery.links:
            links.setdefault(link[0], []).append(link)
        for item, kind, value in discovery.metrics:
            metrics.setdefault(item.key, []).append((item, kind, value))
        for index, item in enumerate(discovery.entities):
            self.entities.append(item)
            if item.key in annotations:
                self.annotations.append((item.key, annotations[item.key]))
            self.metrics.extend(metrics.get(item.key, []))
            self.links.extend(links.get(item.key, []))
            if index == len(discovery.entities) - 1:
                self.pending_records = record
            if len(self.entities) == BATCH_SIZE:
                self.flush()
        self.pending_records = record

    def add_edge(self, source, target, relation, record):
        self.edges.append({"source": source, "target": target, "relation": relation})
        self.pending_records = record
        if len(self.edges) == BATCH_SIZE:
            self.flush()

    def flush(self, status="running"):
        with self.store.transaction() as conn:
            self.store.ingest(conn, self.entities, schedule=False, merge_relationships=True)
            if self.edges:
                conn.execute(
                    """INSERT INTO edges(source,target,relation)
                       SELECT DISTINCT source,target,relation FROM jsonb_to_recordset(%s)
                       AS e(source text,target text,relation text) ON CONFLICT DO NOTHING""",
                    (Jsonb(self.edges),),
                )
            self.store.public_observations(
                conn,
                Discovery(
                    [],
                    [],
                    [],
                    [],
                    annotations=self.annotations,
                    metrics=self.metrics,
                    links=self.links,
                ),
                schedule=False,
            )
            conn.execute(
                """UPDATE import_runs SET records=%s,observations=observations+%s,
                   status=%s,updated_at=now() WHERE id=%s""",
                (self.pending_records, len(self.entities), status, self.identifier),
            )
            if self.entities:
                self.store.activity(
                    conn,
                    "importer",
                    "imported",
                    "Bulk snapshot metadata",
                    amount=len(self.entities),
                )
        self.records = self.pending_records
        self.observations += len(self.entities)
        log.info(
            "bulk_import id=%s records=%s observations=%s status=%s",
            self.identifier,
            self.records,
            self.observations,
            status,
        )
        self.entities.clear()
        self.annotations.clear()
        self.metrics.clear()
        self.edges.clear()
        self.links.clear()

    def result(self, status):
        self.flush(status)
        return {
            "import_id": self.identifier,
            "records": self.records,
            "observations": self.observations,
            "status": status,
        }
