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
        if store.settings.musicbrainz_enabled:
            conn.execute(
                """WITH pending AS MATERIALIZED (
                   SELECT count(*) FILTER (WHERE priority>0) AS preferred,
                     count(*) FILTER (WHERE priority<=0) AS ordinary
                   FROM jobs WHERE task='mb-releases' AND NOT dead AND (ready OR due_at<=now())
                   ), candidates AS MATERIALIZED (
                   SELECT e.key,e.provider_id,
                     10*ln(1+greatest(e.popularity,coalesce((
                       SELECT max(a.popularity) FROM edges ed
                       JOIN entities a ON a.key=ed.target AND a.kind='artist'
                       WHERE ed.source=e.key AND ed.relation='artist'
                     ),0))) + CASE WHEN EXISTS (
                       SELECT 1 FROM edges ed JOIN priority_artists p ON p.entity_key=ed.target
                       WHERE ed.source=e.key AND ed.relation='artist'
                     ) THEN 10 ELSE 0 END AS score
                   FROM entities e WHERE e.key=ANY(%s) AND e.source='musicbrainz'
                     AND e.kind='album'
                     AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.key='mb-releases:'||e.key||':0')
                   ), ranked AS (
                   SELECT *,row_number() OVER (PARTITION BY score>0 ORDER BY score DESC,key) AS n
                   FROM candidates)
                   INSERT INTO jobs(key,task,entity_key,country,kind,provider_id,source,host,priority)
                   SELECT 'mb-releases:'||r.key||':0','mb-releases',r.key,'global','album',
                     r.provider_id,'musicbrainz','musicbrainz.org',r.score
                   FROM ranked r CROSS JOIN pending p
                   WHERE (r.score>0 AND r.n<=greatest(0,200-p.preferred))
                      OR (r.score<=0 AND r.n<=greatest(0,800-p.ordinary))
                   ORDER BY r.score DESC,r.key
                   LIMIT greatest(0,least(50,1000-(
                     SELECT preferred+ordinary FROM pending
                   )))
                   ON CONFLICT DO NOTHING""",
                (keys,),
            )
        conn.execute(
            """WITH desired AS MATERIALIZED (
               SELECT e.key,
                 10*ln(1+greatest(e.popularity,coalesce((
                   SELECT max(a.popularity) FROM edges ed
                   JOIN entities a ON a.key=ed.target AND a.kind='artist'
                   WHERE ed.source=e.key AND ed.relation='artist' AND e.kind='album'
                 ),0))) +
                 CASE WHEN EXISTS (
                   SELECT 1 FROM priority_artists p WHERE p.entity_key=e.key
                 ) OR (e.kind='album' AND EXISTS (
                   SELECT 1 FROM edges ed JOIN priority_artists p ON p.entity_key=ed.target
                   WHERE ed.source=e.key AND ed.relation='artist'
                 )) THEN 10 ELSE 0 END AS priority
               FROM entities e WHERE e.key=ANY(%s))
               UPDATE jobs j SET priority=greatest(d.priority,j.demand_priority) FROM desired d
               WHERE j.entity_key=d.key
                 AND j.priority IS DISTINCT FROM greatest(d.priority,j.demand_priority)""",
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
