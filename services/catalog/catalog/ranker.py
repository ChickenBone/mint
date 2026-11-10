import logging
import time
import uuid
from threading import Event

import psycopg

from catalog.store import Store


log = logging.getLogger(__name__)


def refresh_batch(store: Store, after: str = "", batch_size: int = 2000) -> str | None:
    started = time.monotonic()
    with store.transaction() as conn:
        # Serialize graph batches; one ranker is sufficient for a complete keyset sweep.
        if not conn.execute("SELECT pg_try_advisory_xact_lock(71628402) AS held").fetchone()[
            "held"
        ]:
            return after
        conn.execute("SELECT entities FROM catalog_budget FOR UPDATE")
        rows = conn.execute(
            "SELECT key FROM entities WHERE key>%s ORDER BY key LIMIT %s",
            (after, batch_size),
        ).fetchall()
        if not rows:
            return None
        keys = [row["key"] for row in rows]
        conn.execute(
            """WITH neighbors AS (
               SELECT key AS node, key AS neighbor, 1.0 AS weight
                 FROM entities WHERE key=ANY(%s)
               UNION ALL
               SELECT target, source, 0.35 FROM edges WHERE target=ANY(%s)
               UNION ALL
               SELECT source, target, 0.15 FROM edges WHERE source=ANY(%s)
               ), scores AS MATERIALIZED (
               SELECT n.node, sum(n.weight*s.weight*
                 exp(-greatest(0,extract(epoch FROM now()-s.observed_at))/604800)) AS score
               FROM neighbors n JOIN chart_signals s ON s.key=n.neighbor
               GROUP BY n.node
               ), desired AS (
                 SELECT e.key,coalesce(s.score,0) AS score FROM entities e
                 LEFT JOIN scores s ON s.node=e.key WHERE e.key=ANY(%s))
               UPDATE entities e SET popularity=d.score FROM desired d
               WHERE e.key=d.key AND e.popularity IS DISTINCT FROM d.score""",
            (keys, keys, keys, keys),
        )
        conn.execute(
            """UPDATE jobs j SET priority=10*ln(1+e.popularity)
               FROM entities e WHERE e.key=ANY(%s) AND
               j.entity_key=e.key AND j.priority IS DISTINCT FROM 10*ln(1+e.popularity)""",
            (keys,),
        )
    log.info(
        "rank_batch records=%s elapsed_ms=%.1f", len(keys), (time.monotonic() - started) * 1000
    )
    return keys[-1]


def run(store: Store, stop: Event):
    cursor = ""
    worker = uuid.uuid4()
    while not stop.is_set():
        try:
            store.heartbeat(worker, "ranker", "scoring" if cursor else "waiting")
            next_cursor = refresh_batch(store, cursor)
            cursor = next_cursor or ""
            if next_cursor is None:
                for _ in range(30):
                    if stop.wait(10):
                        break
                    store.heartbeat(worker, "ranker", "waiting")
            else:
                stop.wait(0.1)
        except psycopg.Error:
            log.exception("ranker_database_unavailable")
            stop.wait(10)
    store.heartbeat(worker, "ranker", "stopped")
