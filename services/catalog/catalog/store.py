import uuid
import math
from contextlib import contextmanager
from pathlib import Path

from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from psycopg.types.json import Jsonb

from catalog.config import Settings
from catalog.model import Entity, chart_weight, entity_key
from catalog.providers import HOSTS, SOURCES, lookup_task, task_source


BULK_JOB_SQL = """(task IN ('mb-albums','mb-songs','mb-releases','mb-release','deezer-albums',
    'deezer-tracks','audius-tracks','ytm-artist','ytm-album','ytm-playlist','discogs-albums')
    OR (task IN ('lookup','deezer-lookup') AND kind IN ('artist','album')))"""


class LeaseLost(RuntimeError):
    pass


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.pool = ConnectionPool(
            settings.database_url,
            min_size=1,
            max_size=max(6, settings.crawler_workers + 2, settings.indexer_workers + 2),
            timeout=10,
            open=True,
            kwargs={"row_factory": dict_row, "options": "-c statement_timeout=15000"},
        )

    def close(self):
        self.pool.close()

    def migrate(self):
        with self.pool.connection() as conn, conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(71628401)")
            conn.execute(Path(__file__).with_name("schema.sql").read_text())
            version = conn.execute("SELECT max(version) AS version FROM catalog_schema").fetchone()
            if version["version"] not in (1, 2, 3, 4, 5, 6, 7, 8, 9):
                raise ValueError("Unsupported catalog schema version")
            for target in range(version["version"] + 1, 10):
                conn.execute(Path(__file__).with_name(f"schema-v{target}.sql").read_text())
                if target == 4:
                    from catalog.identity import rebuild_artists

                    rebuild_artists(conn)
            for host in sorted({*HOSTS.values(), "rss.marketingtools.apple.com"}):
                conn.execute(
                    "INSERT INTO host_budgets(host) VALUES (%s) ON CONFLICT DO NOTHING", (host,)
                )

    @contextmanager
    def transaction(self):
        with self.pool.connection() as conn, conn.transaction():
            yield conn

    def enqueue(self, conn, task, country, kind, identifier, priority=0.0, page=0, *, album_key=None):
        source = task_source(task)
        if task == "chart" or task.endswith("-chart"):
            key = f"{task}:{country}"
            target_key = None
        elif task == "ytm-playlist":
            from catalog.model import provider_id

            key = f"{task}:{provider_id(identifier, 'ytmusic')}"
            target_key = None
        elif task == "mb-release":
            from catalog.model import provider_id

            identifier = provider_id(identifier, "musicbrainz")
            if not album_key or entity_key("global", "album", album_key.split(":")[-1], "musicbrainz") != album_key:
                raise ValueError("Release jobs require a MusicBrainz album key")
            target_key = album_key
            key = f"{task}:{album_key}:{identifier}:{page}"
        else:
            target_key = entity_key(
                country, kind, identifier, "musicbrainz" if source == "listenbrainz" else source
            )
            key = f"{task}:{target_key}:{page}"
        conn.execute(
            """INSERT INTO jobs(key, task, entity_key, country, kind, provider_id, priority, page,source,host)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(key) DO UPDATE
               SET priority = excluded.priority WHERE jobs.priority<excluded.priority""",
            (
                key,
                task,
                target_key,
                country,
                kind,
                identifier,
                priority,
                page,
                source,
                "rss.marketingtools.apple.com" if task == "chart" else HOSTS[source],
            ),
        )

    def seed(self):
        with self.transaction() as conn:
            if self.settings.apple_enabled:
                for country in self.settings.countries:
                    self.enqueue(conn, "chart", country, "song", "", 100)
            if self.settings.listenbrainz_enabled:
                self.enqueue(conn, "lb-chart", "global", "song", "", 100)
            if self.settings.ytmusic_enabled:
                for country in self.settings.countries:
                    self.enqueue(conn, "ytm-chart", country, "artist", "", 100)
            if self.settings.youtube_enabled:
                for channel in self.settings.youtube_channels:
                    self.enqueue(conn, "yt-feed", "global", "artist", channel, 20)
            for source in ("deezer", "audius", "archive", "openverse", "openwhyd"):
                if self.settings.enabled(source):
                    self.enqueue(
                        conn,
                        f"{source}-chart",
                        "global",
                        "album" if source == "archive" else "song",
                        "",
                        100,
                    )

    def priority_artist(self, conn, identifier, provenance, *, remove=False):
        key = entity_key("global", "artist", identifier, "musicbrainz")
        if remove:
            return conn.execute(
                "DELETE FROM priority_artists WHERE entity_key=%s AND provenance=%s",
                (key, provenance),
            ).rowcount
        inserted = conn.execute(
            """INSERT INTO priority_artists(entity_key,provenance) VALUES (%s,%s)
               ON CONFLICT DO NOTHING""",
            (key, provenance),
        ).rowcount
        self.enqueue(conn, "mb-lookup", "global", "artist", identifier, 10)
        if inserted:
            conn.execute(
                """UPDATE jobs SET priority=greatest(priority,10),due_at=now(),ready=true
                   WHERE NOT dead AND lease_until<=now() AND (
                     entity_key=%s OR entity_key IN (
                       SELECT source FROM edges WHERE target=%s AND relation='artist'
                     )
                   )""",
                (key, key),
            )
        return inserted

    def ingest(self, conn, entities: list[Entity], *, schedule=True, merge_relationships=False):
        from catalog.ingestion import ingest

        budget = conn.execute("SELECT entities FROM catalog_budget FOR UPDATE").fetchone()
        inserted, accepted = ingest(
            conn, entities, self.settings.max_entities - budget["entities"],
            merge_relationships=merge_relationships,
        )
        if schedule:
            targets = {
                tuple(key.split(":"))
                for item in accepted for key in (*item.artist_keys, *item.album_keys)
            }
            targets.update(
                (item.source, item.country, item.kind, item.provider_id) for item in accepted
            )
            jobs = []
            for source, country, kind, identifier in sorted(targets):
                if self.settings.enabled(source):
                    key = entity_key(country, kind, identifier, source)
                    task = lookup_task(source, kind)
                    jobs.append({
                        "key": f"{task}:{key}:0", "task": task, "entity_key": key,
                        "country": country, "kind": kind, "provider_id": identifier,
                        "source": source, "host": HOSTS[source],
                    })
            if jobs:
                conn.execute(
                    """INSERT INTO jobs(key,task,entity_key,country,kind,provider_id,source,host)
                       SELECT key,task,entity_key,country,kind,provider_id,source,host
                       FROM jsonb_to_recordset(%s) AS j(
                         key text,task text,entity_key text,country text,kind text,
                         provider_id text,source text,host text)
                       ON CONFLICT(key) DO UPDATE SET priority=excluded.priority
                       WHERE jobs.priority<excluded.priority""",
                    (Jsonb(jobs),),
                )
        return inserted

    def signals(self, conn, chart: str, ranked: list[tuple[Entity, int]], observed_at=None):
        conn.execute("DELETE FROM chart_signals WHERE chart=%s", (chart,))
        for entity, rank in ranked:
            conn.execute(
                """INSERT INTO chart_signals(chart,key,rank,weight,observed_at)
                   VALUES (%s,%s,%s,%s,coalesce(%s,now()))""",
                (chart, entity.key, rank, chart_weight(rank), observed_at),
            )
            task = lookup_task(entity.source, entity.kind)
            if self.settings.enabled(entity.source):
                self.enqueue(
                    conn,
                    task,
                    entity.country,
                    entity.kind,
                    entity.provider_id,
                    chart_weight(rank) * 50,
                )
                for artist_key in entity.artist_keys:
                    _, country, kind, identifier = artist_key.split(":")
                    self.enqueue(
                        conn,
                        lookup_task(entity.source, kind),
                        country,
                        kind,
                        identifier,
                        chart_weight(rank) * 17.5,
                    )

    def view_signals(self, conn, observations):
        for entity, views in observations:
            conn.execute(
                """INSERT INTO chart_signals(chart,key,rank,weight,signal_kind,raw_value)
                   VALUES (%s,%s,NULL,%s,'views',%s) ON CONFLICT(chart,key)
                   DO UPDATE SET weight=excluded.weight,raw_value=excluded.raw_value,
                   observed_at=now()""",
                (f"youtube:views:{entity.provider_id}", entity.key, math.log1p(views) / 20, views),
            )

    def public_observations(self, conn, discovery, *, schedule=True):
        conn.execute("SELECT entities FROM catalog_budget FOR UPDATE")
        if discovery.metrics:
            conn.execute(
                """INSERT INTO chart_signals(chart,key,rank,weight,signal_kind,raw_value)
                   SELECT DISTINCT ON (chart,key) chart,key,NULL,weight,signal_kind,raw_value
                   FROM jsonb_to_recordset(%s) AS m(
                     chart text,key text,weight double precision,signal_kind text,
                     raw_value bigint,position integer)
                   ORDER BY chart,key,position DESC ON CONFLICT(chart,key)
                   DO UPDATE SET weight=excluded.weight,raw_value=excluded.raw_value,observed_at=now()""",
                (Jsonb([
                    {
                        "chart": f"{item.source}:{kind}:{item.provider_id}", "key": item.key,
                        "weight": math.log1p(value) / 20, "signal_kind": kind,
                        "raw_value": value, "position": position,
                    }
                    for position, (item, kind, value) in enumerate(discovery.metrics)
                ]),),
            )
        if discovery.annotations:
            conn.execute(
                """INSERT INTO entity_annotations(key,metadata)
                   SELECT DISTINCT ON (key) key,metadata FROM
                   jsonb_to_recordset(%s) AS a(key text,metadata jsonb,position integer)
                   ORDER BY key,position DESC
                   ON CONFLICT(key) DO UPDATE SET metadata=excluded.metadata""",
                (Jsonb([
                    {"key": key, "metadata": metadata, "position": position}
                    for position, (key, metadata) in enumerate(discovery.annotations)
                ]),),
            )
        if discovery.links:
            conn.execute(
                """INSERT INTO entity_links(key,provider,kind,identifier,url)
                   SELECT DISTINCT ON (key,provider,kind,identifier)
                     key,provider,kind,identifier,url FROM jsonb_to_recordset(%s)
                   AS l(key text,provider text,kind text,identifier text,url text,position integer)
                   ORDER BY key,provider,kind,identifier,position DESC
                   ON CONFLICT(key,provider,kind,identifier) DO UPDATE SET observed_at=now()""",
                (Jsonb([
                    {
                        "key": key, "provider": source, "kind": kind, "identifier": identifier,
                        "url": url, "position": position,
                    }
                    for position, (key, source, kind, identifier, url)
                    in enumerate(discovery.links)
                ]),),
            )
        for key, source, kind, identifier, url in discovery.links:
            if kind == "artist":
                from catalog.identity import link_artist

                link_artist(conn, key, source, kind, identifier)
            if schedule and source in SOURCES and self.settings.enabled(source):
                self.enqueue(conn, lookup_task(source, kind), "global", kind, identifier, 5)

    def claim(self, table="jobs", count=1, explore=False, expand=False):
        if table not in ("jobs", "vector_outbox"):
            raise ValueError("Invalid queue")
        order = (
            sql.SQL("due_at,key")
            if explore or table == "vector_outbox"
            else sql.SQL("priority DESC,due_at,key")
        )
        token = uuid.uuid4()
        with self.transaction() as conn:
            if table == "jobs":
                conn.execute(
                    """WITH scheduled AS (
                       SELECT key FROM jobs WHERE NOT dead AND NOT ready AND due_at<=now()
                       ORDER BY due_at,key LIMIT 1000 FOR UPDATE SKIP LOCKED)
                       UPDATE jobs SET ready=true FROM scheduled WHERE jobs.key=scheduled.key"""
                )
            rows = conn.execute(
                sql.SQL(
                    """WITH selected AS (
                       SELECT key FROM {table}
                       WHERE NOT dead {ready} AND due_at<=now() AND lease_until<=now()
                       {sources} {expansion}
                       ORDER BY {order} LIMIT %s FOR UPDATE SKIP LOCKED)
                       UPDATE {table} q SET lease_token=%s,
                       lease_until=now()+make_interval(secs=>%s)
                       FROM selected WHERE q.key=selected.key RETURNING q.*"""
                ).format(
                    table=sql.Identifier(table),
                    order=order,
                    ready=sql.SQL("AND ready" if table == "jobs" else ""),
                    expansion=sql.SQL(f"AND {BULK_JOB_SQL}" if table == "jobs" and expand else ""),
                    sources=sql.SQL(
                        """AND NOT EXISTS (SELECT 1 FROM source_controls s
                           WHERE s.source=jobs.source AND s.paused)
                           AND source=ANY(%s)
                           AND NOT EXISTS (SELECT 1 FROM host_budgets b
                           WHERE b.host=jobs.host AND b.next_at>now())"""
                        if table == "jobs"
                        else ""
                    ),
                ),
                (
                    *(
                        ([source for source in SOURCES if self.settings.enabled(source)],)
                        if table == "jobs"
                        else ()
                    ),
                    count,
                    token,
                    self.settings.lease_seconds,
                ),
            ).fetchall()
        return rows

    def claim_crawl(self):
        enabled = [source for source in SOURCES if self.settings.enabled(source)]
        with self.transaction() as conn:
            conn.execute(
                """WITH scheduled AS (
                   SELECT key FROM jobs WHERE NOT dead AND NOT ready AND due_at<=now()
                   ORDER BY due_at,key LIMIT 1000 FOR UPDATE SKIP LOCKED)
                   UPDATE jobs SET ready=true FROM scheduled WHERE jobs.key=scheduled.key"""
            )
            host = conn.execute(
                """SELECT b.host,b.crawl_sequence FROM host_budgets b
                   WHERE b.next_at<=now() AND EXISTS (
                       SELECT 1 FROM jobs WHERE host=b.host AND NOT dead AND ready
                       AND due_at<=now() AND lease_until<=now() AND source=ANY(%s)
                       AND NOT EXISTS (SELECT 1 FROM source_controls s
                           WHERE s.source=jobs.source AND s.paused))
                   ORDER BY b.next_at,b.host LIMIT 1 FOR UPDATE OF b SKIP LOCKED""",
                (enabled,),
            ).fetchone()
            if host is None:
                return []
            lane = host["crawl_sequence"]
            selection = sql.SQL(
                """SELECT key,source FROM jobs WHERE host=%s AND NOT dead AND ready
                   AND due_at<=now() AND lease_until<=now() AND source=ANY(%s)
                   AND NOT EXISTS (SELECT 1 FROM source_controls s
                       WHERE s.source=jobs.source AND s.paused) {bulk}
                   ORDER BY {order} LIMIT 1 FOR UPDATE SKIP LOCKED"""
            )
            order = sql.SQL("due_at,key" if lane == 0 else "priority DESC,due_at,key")
            selected = conn.execute(
                selection.format(
                    bulk=sql.SQL(f"AND {BULK_JOB_SQL}" if lane in (1, 2, 3) else ""),
                    order=order,
                ),
                (host["host"], enabled),
            ).fetchone()
            if selected is None and lane in (1, 2, 3):
                selected = conn.execute(
                    selection.format(bulk=sql.SQL(""), order=order),
                    (host["host"], enabled),
                ).fetchone()
            if selected is None:
                return []
            interval = self.settings.request_interval(selected["source"], host["host"])
            admission = conn.execute(
                """UPDATE host_budgets SET next_at=clock_timestamp()+make_interval(secs=>%s),
                   crawl_sequence=(crawl_sequence+1)%%5 WHERE host=%s RETURNING next_at""",
                (interval, host["host"]),
            ).fetchone()
            keys = [selected["key"]]
            primary = conn.execute(
                "SELECT task,country,kind,attempts FROM jobs WHERE key=%s", (selected["key"],)
            ).fetchone()
            if (
                selected["source"] == "apple"
                and primary["task"] == "lookup"
                and not primary["attempts"]
            ):
                size = 50 if primary["kind"] == "song" else 5
                companions = conn.execute(
                    """SELECT key FROM jobs WHERE source='apple' AND task='lookup'
                       AND country=%s AND kind=%s AND attempts=0 AND NOT dead AND ready
                       AND due_at<=now() AND lease_until<=now() AND key<>%s
                       ORDER BY priority DESC,due_at,key LIMIT %s FOR UPDATE SKIP LOCKED""",
                    (primary["country"], primary["kind"], selected["key"], size - 1),
                ).fetchall()
                keys += [row["key"] for row in companions]
            jobs = conn.execute(
                """UPDATE jobs SET lease_token=%s,
                   lease_until=clock_timestamp()+make_interval(secs=>%s)
                   WHERE key=ANY(%s) RETURNING *""",
                (uuid.uuid4(), self.settings.lease_seconds, keys),
            ).fetchall()
            jobs.sort(key=lambda job: keys.index(job["key"]))
            job = jobs[0]
            job["request_host"] = host["host"]
            job["request_until"] = admission["next_at"]
            if len(jobs) > 1:
                job["lookup_ids"] = [row["provider_id"] for row in jobs]
            return jobs

    def crawl_delay(self):
        with self.transaction() as conn:
            row = conn.execute(
                """WITH waiting AS (
                   SELECT min(b.next_at) AS next_at FROM host_budgets b WHERE EXISTS (
                       SELECT 1 FROM jobs j WHERE j.host=b.host AND NOT j.dead AND j.ready
                       AND j.due_at<=now() AND j.lease_until<=now() AND j.source=ANY(%s)
                       AND NOT EXISTS (SELECT 1 FROM source_controls s
                           WHERE s.source=j.source AND s.paused)))
                   SELECT CASE WHEN next_at='infinity' THEN 1
                       WHEN next_at<=clock_timestamp() THEN 0.02
                       ELSE extract(epoch FROM next_at-clock_timestamp()) END AS seconds
                   FROM waiting""",
                ([source for source in SOURCES if self.settings.enabled(source)],),
            ).fetchone()
        return min(1.0, max(0.02, float(row["seconds"]))) if row["seconds"] is not None else 1.0

    def lock_job(self, conn, job, table="jobs"):
        row = conn.execute(
            sql.SQL(
                "SELECT key FROM {} WHERE key=%s AND lease_token=%s AND lease_until>now() FOR UPDATE"
            ).format(sql.Identifier(table)),
            (job["key"], job["lease_token"]),
        ).fetchone()
        if row is None:
            raise LeaseLost("Work lease expired or was reclaimed")

    def complete(self, conn, job, interval):
        self.lock_job(conn, job)
        conn.execute(
            """UPDATE jobs SET due_at=now()+make_interval(secs=>%s),
               ready=false, lease_until='-infinity', lease_token=NULL, attempts=0, last_error=NULL
               WHERE key=%s""",
            (interval, job["key"]),
        )

    def fail(self, job, message, delay, table="jobs", deferred=False):
        if table not in ("jobs", "vector_outbox"):
            raise ValueError("Invalid queue")
        with self.transaction() as conn:
            changed = conn.execute(
                sql.SQL(
                    """UPDATE {} SET attempts=attempts+%s,
                       dead=(attempts+%s >= %s), last_error=%s,
                       due_at=now()+make_interval(secs=>%s),
                       lease_until='-infinity', lease_token=NULL {ready}
                       WHERE key=%s AND lease_token=%s RETURNING key"""
                ).format(
                    sql.Identifier(table),
                    ready=sql.SQL(", ready=false" if table == "jobs" else ""),
                ),
                (
                    0 if deferred else 1,
                    0 if deferred else 1,
                    self.settings.max_attempts,
                    message[:500],
                    min(31536000, max(0.1 if deferred else 1, delay)),
                    job["key"],
                    job["lease_token"],
                ),
            ).fetchone()
            if changed:
                self.activity(
                    conn,
                    "indexer" if table == "vector_outbox" else "crawler",
                    "deferred" if deferred else "failed",
                    message[:300],
                    key=job["key"],
                    source=job.get("source"),
                )

    def reserve_host(self, host, interval):
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO host_budgets(host) VALUES (%s) ON CONFLICT DO NOTHING", (host,)
            )
            row = conn.execute(
                """SELECT CASE WHEN next_at='infinity' THEN 86400
                   WHEN next_at>now() THEN extract(epoch FROM next_at-now()) ELSE 0 END AS wait
                   FROM host_budgets WHERE host=%s FOR UPDATE""",
                (host,),
            ).fetchone()
            if row["wait"] > 0:
                return float(row["wait"])
            conn.execute(
                "UPDATE host_budgets SET next_at=now()+make_interval(secs=>%s) WHERE host=%s",
                (interval, host),
            )
            return 0

    def pause_host(self, host, seconds):
        with self.transaction() as conn:
            conn.execute(
                """INSERT INTO host_budgets(host,next_at) VALUES
                   (%s,CASE WHEN %s>31536000 THEN 'infinity'::timestamptz
                   ELSE now()+make_interval(secs=>%s) END)
                   ON CONFLICT(host) DO UPDATE SET
                   next_at=greatest(host_budgets.next_at,excluded.next_at)""",
                (host, seconds, min(31536000, seconds)),
            )

    def reindex_batch(self, after: str = "", batch_size: int = 1000) -> str | None:
        with self.transaction() as conn:
            conn.execute("SELECT entities FROM catalog_budget FOR UPDATE")
            rows = conn.execute(
                """SELECT key,revision,indexed_revision,source FROM entities WHERE key>%s ORDER BY key
                   LIMIT %s FOR UPDATE""",
                (after, batch_size),
            ).fetchall()
            for row in rows:
                if row["revision"] == row["indexed_revision"]:
                    conn.execute(
                        "UPDATE source_metrics SET indexed=indexed-1 WHERE source=%s",
                        (row["source"],),
                    )
                conn.execute(
                    """INSERT INTO vector_outbox(key,revision) VALUES (%s,%s)
                       ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,
                       attempts=0,dead=false,last_error=NULL,due_at=now()""",
                    (row["key"], row["revision"]),
                )
                conn.execute(
                    "UPDATE entities SET indexed_revision=NULL WHERE key=%s", (row["key"],)
                )
        return rows[-1]["key"] if rows else None

    def activity(self, conn, role, action, detail, key=None, source=None, amount=0):
        result = conn.execute(
            """INSERT INTO activity(role,source,action,key,detail,amount)
               VALUES (%s,%s,%s,%s,%s,%s) RETURNING id""",
            (role, source, action, key, detail[:500], amount),
        ).fetchone()
        conn.execute("DELETE FROM activity WHERE id<%s", (result["id"] - 2000,))

    def heartbeat(self, worker, role, state, key=None):
        with self.transaction() as conn:
            changed = conn.execute(
                """INSERT INTO workers(id,role,state,job_key) VALUES (%s,%s,%s,%s)
                   ON CONFLICT(id) DO UPDATE SET state=excluded.state,job_key=excluded.job_key,
                   seen_at=now() WHERE workers.state IS DISTINCT FROM excluded.state
                   OR workers.job_key IS DISTINCT FROM excluded.job_key
                   OR workers.seen_at<now()-interval '5 seconds'""",
                (worker, role, state, key),
            )
            if changed.rowcount:
                conn.execute("DELETE FROM workers WHERE seen_at<now()-interval '1 day'")
