import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  runStartupMigrations, startLocalJobRuntime,
  type LocalJobQueue, type LocalJobRuntime, type LocalJobRuntimeOptions,
} from "@mint/platform";
import pg from "pg";
import {
  CATALOG_LISTENBRAINZ_SEED_QUEUE_V1 as queue,
  createCatalogSeedIngestor,
} from "../src/seed-ingestion";
import { LISTENBRAINZ_SEED_KEY as key, parseListenBrainzSnapshot } from "../src/listenbrainz-source";
import { claimCatalogSeed, publishCatalogSeed } from "../src/seed-ingestion-store";
import { createCatalogSeedStore } from "../src/startup-seed-store";
import { planCatalogStartupSeeds, scheduleCatalogStartupSeeds } from "../src/startup-seeding";

const exec = promisify(execFile);
const config = { enabledSources: ["listenbrainz"], countries: [], youtubeChannels: [], maxJobs: 1 } as const;
const job = planCatalogStartupSeeds(config)[0]!;
const payload = { version: 1, job: { ...job } };
const id = "12345678-1234-4234-8234-123456789012";
function fixture() {
  return { payload: { range: "week", from_ts: 100, to_ts: 200, last_updated: 201, recordings: [
    { track_name: "Unidentified" },
    { recording_mbid: id, artist_mbids: [id], track_name: "Song", artist_name: "Artist",
      release_name: "Album", listen_count: 7 },
    { recording_mbid: id, track_name: "Song", artist_name: "Artist", listen_count: 3 },
  ] } };
}
async function until(check: () => Promise<boolean>, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail("Expected Catalog ingestion state was not observed.");
}

test("real Catalog source ingestion on disposable PostgreSQL16 and pg-boss", { timeout: 120_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to PostgreSQL16 binaries for real ingestion proof");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-catalog-ingest-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "socket");
  const env: NodeJS.ProcessEnv = {
    ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture",
  };
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  delete env.DATABASE_URL;
  const poolConfig = {
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
    max: 12, connectionTimeoutMillis: 2_000,
  };
  let pool = new pg.Pool(poolConfig);
  const runtimes: LocalJobRuntime[] = [];
  const errors: Parameters<LocalJobRuntimeOptions["onError"]>[0][] = [];
  const options: LocalJobRuntimeOptions = {
    migrations: { packagesRoot: fileURLToPath(new URL("../../", import.meta.url)), lockTimeoutMs: 5_000 },
    queues: [queue], pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 1,
    maintenanceIntervalSeconds: 1, shutdownTimeoutMs: 1_000,
    onError: (error) => { errors.push(error); },
  };
  let started = false;
  async function startDatabase() {
    await exec(path.join(bin!, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-w", "start",
    ], { env });
    started = true;
  }
  async function reset() {
    await pool.query("DELETE FROM catalog.listenbrainz_seed_observations");
    await pool.query("DELETE FROM catalog.listenbrainz_seed_ingestions");
  }
  async function permitRetry() {
    await pool.query(`UPDATE catalog.listenbrainz_seed_ingestions SET
      lease_until = CASE WHEN state = 'running' THEN clock_timestamp() - interval '1 second' ELSE NULL END,
      not_before = clock_timestamp() - interval '1 second', paused = false`);
  }
  const readState = async () => (await pool.query(
    "SELECT * FROM catalog.listenbrainz_seed_ingestions WHERE seed_key = $1", [key],
  )).rows[0];
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ], { env });
    await startDatabase();
    assert.match((await pool.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.equal((await pool.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    await runStartupMigrations(pool, options.migrations);

    await t.test("central startup applies source SQL twice without changing canonical schema", async () => {
      const history = (await pool.query<{ hash: string }>(
        "SELECT * FROM mint_migrations.__drizzle_migrations ORDER BY id",
      )).rows;
      for (const migration of ["0001_startup_seed_receipts.sql", "0002_listenbrainz_seed_ingestion.sql"]) {
        const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url));
        const hash = createHash("sha256").update(sql).digest("hex");
        assert.equal(history.filter((row) => row.hash === hash).length, 1, `${migration} applied once`);
      }
      await runStartupMigrations(pool, options.migrations);
      assert.deepEqual((await pool.query("SELECT * FROM mint_migrations.__drizzle_migrations ORDER BY id")).rows, history);
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_schema = 'catalog' AND table_name = 'recordings'`)).rows[0].count, 6);
      await pool.query("INSERT INTO catalog.listenbrainz_seed_ingestions (seed_key) VALUES ($1)", [key]);
      for (const [sql, values] of [
        ["INSERT INTO catalog.listenbrainz_seed_ingestions (seed_key) VALUES ($1)", ["another key"]],
        ["UPDATE catalog.listenbrainz_seed_ingestions SET state = 'completed'", []],
        ["UPDATE catalog.listenbrainz_seed_ingestions SET origin = 'musicbrainz'", []],
        ["UPDATE catalog.listenbrainz_seed_ingestions SET received = 101", []],
      ] as const) await assert.rejects(pool.query(sql, [...values]), { code: "23514" });
      await reset();
    });

    await t.test("concurrent processes share admission and persist real attributed occurrences", async () => {
      let fetched = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const request: typeof fetch = async () => {
        fetched += 1;
        await gate;
        return Response.json(fixture());
      };
      const first = createCatalogSeedIngestor(pool, { enabledSources: ["listenbrainz"], request });
      const secondPool = new pg.Pool(poolConfig);
      const second = createCatalogSeedIngestor(secondPool, { enabledSources: ["listenbrainz"], request });
      try {
        const running = first.ingest(payload);
        await until(async () => fetched === 1);
        await assert.rejects(second.ingest(payload), { code: "busy" });
        release();
        assert.deepEqual(await running, {
          version: 1, key, status: "ingested", outcome: "observations",
          received: 3, persisted: 2, missingIdentifiers: 1,
        });
        assert.equal(fetched, 1);
        const state = await readState();
        assert.equal(state.origin, "listenbrainz");
        assert.equal(state.identifier_provider, "musicbrainz");
        assert.equal(state.country, "global");
        assert.equal(state.attempts, 1);
        assert.equal(state.lease_token, null);
        assert.equal(state.lease_until, null);
        assert.match(state.content_hash, /^[a-f0-9]{64}$/);
        const observed = (await pool.query(
          "SELECT * FROM catalog.listenbrainz_seed_observations ORDER BY position",
        )).rows;
        assert.deepEqual(observed.map((row) => [row.position, row.recording_mbid, row.artist_mbids, row.listen_count]),
          [[2, id, [id], "7"], [3, id, [], "3"]]);
        const replay = await second.ingest(payload);
        assert.equal(replay.status, "already_ingested");
        assert.equal(fetched, 1);
        assert.deepEqual(await readState(), state);
        await assert.rejects(pool.query("DELETE FROM catalog.listenbrainz_seed_ingestions"), { code: "23503" });
        for (const sql of [
          "UPDATE catalog.listenbrainz_seed_observations SET position = 101",
          "UPDATE catalog.listenbrainz_seed_observations SET title = ' '",
          "UPDATE catalog.listenbrainz_seed_observations SET listen_count = -1",
          "UPDATE catalog.listenbrainz_seed_observations SET artist_mbids = ARRAY[NULL]::uuid[]",
          "UPDATE catalog.listenbrainz_seed_observations SET artist_mbids = array_fill(NULL::uuid, ARRAY[101])",
        ]) await assert.rejects(pool.query(sql), { code: "23514" });
      } finally {
        release();
        await secondPool.end();
      }
    });

    await t.test("rollback after row insertion, lease takeover, cancellation and stale fencing", async () => {
      await reset();
      await pool.query(`CREATE FUNCTION catalog.fixture_reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.state = 'completed' THEN RAISE EXCEPTION 'fixture completion failure'; END IF;
        RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER fixture_completion BEFORE UPDATE ON catalog.listenbrainz_seed_ingestions
        FOR EACH ROW EXECUTE FUNCTION catalog.fixture_reject_completion()`);
      try {
        await assert.rejects(createCatalogSeedIngestor(pool, {
          enabledSources: ["listenbrainz"], request: async () => Response.json(fixture()),
        }).ingest(payload), /fixture completion failure/);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.listenbrainz_seed_observations")).rows[0].count, 0);
        assert.equal((await readState()).state, "running");
      } finally {
        await pool.query("DROP TRIGGER fixture_completion ON catalog.listenbrainz_seed_ingestions");
        await pool.query("DROP FUNCTION catalog.fixture_reject_completion()");
      }
      const oldToken = (await readState()).lease_token;
      await permitRetry();
      const replacement = await claimCatalogSeed(pool, new AbortController().signal);
      assert.ok("token" in replacement);
      const snapshot = parseListenBrainzSnapshot(fixture());
      await assert.rejects(publishCatalogSeed(pool, oldToken, snapshot, new AbortController().signal),
        { code: "lease_lost" });
      await assert.rejects(publishCatalogSeed(pool, replacement.token, snapshot, AbortSignal.abort()));
      assert.equal((await readState()).state, "running");
      await publishCatalogSeed(pool, replacement.token, snapshot, new AbortController().signal);
      assert.equal((await readState()).state, "completed");
    });

    await t.test("empty, unidentified and maximum-size pages have truthful outcomes and bounded writes", async () => {
      for (const [recordings, outcome, expected] of [
        [[], "empty_feed", 0],
        [[{ track_name: "Unidentified" }], "no_identified_recordings", 0],
        [Array.from({ length: 100 }, () => ({
          recording_mbid: id, track_name: "Song", artist_name: "Artist",
          artist_mbids: Array(100).fill(id), listen_count: Number.MAX_SAFE_INTEGER,
        })), "observations", 100],
      ] as const) {
        await reset();
        const body = { payload: { ...fixture().payload, recordings } };
        const result = await createCatalogSeedIngestor(pool, {
          enabledSources: ["listenbrainz"], request: async () => Response.json(body),
        }).ingest(payload);
        assert.equal(result.outcome, outcome);
        assert.equal(result.persisted, expected);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.listenbrainz_seed_observations")).rows[0].count, expected);
      }
    });

    await t.test("database lock waits are bounded and failure leaves the pool reusable", async () => {
      await reset();
      await pool.query("INSERT INTO catalog.listenbrainz_seed_ingestions (seed_key) VALUES ($1)", [key]);
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT seed_key FROM catalog.listenbrainz_seed_ingestions FOR UPDATE");
      const before = performance.now();
      try {
        await assert.rejects(createCatalogSeedIngestor(pool, {
          enabledSources: ["listenbrainz"], request: async () => { assert.fail("Blocked work must not fetch."); },
        }).ingest(payload), { code: "55P03" });
        assert.ok(performance.now() - before < 3000);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      assert.equal((await readState()).state, "pending");
      assert.equal((await pool.query("SELECT 1 AS ready")).rows[0].ready, 1);
    });

    await t.test("unavailable, malformed data, pause and cooldown remain failures across restart", async () => {
      await reset();
      let fetched = 0;
      const ingest = createCatalogSeedIngestor(pool, {
        enabledSources: ["listenbrainz"], request: async () => {
          fetched += 1;
          return new Response(null, { status: 429, headers: { "retry-after": "86400" } });
        },
      });
      await assert.rejects(ingest.ingest(payload), { code: "source_unavailable" });
      const failed = await readState();
      assert.equal(failed.state, "retry_wait");
      assert.equal(failed.last_error, "source_unavailable");
      assert.ok(failed.not_before.getTime() >= Date.now() + 86_390_000);
      await assert.rejects(ingest.ingest(payload), { code: "cooldown" });
      await pool.query("UPDATE catalog.listenbrainz_seed_ingestions SET paused = true");
      await assert.rejects(ingest.ingest(payload), { code: "paused" });
      assert.equal(fetched, 1);
      await pool.end();
      await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env });
      started = false;
      await startDatabase();
      pool = new pg.Pool(poolConfig);
      assert.equal((await readState()).paused, true);
      assert.equal((await readState()).not_before.getTime(), failed.not_before.getTime());
      await permitRetry();
      const malformed = createCatalogSeedIngestor(pool, {
        enabledSources: ["listenbrainz"], request: async () => Response.json({ payload: null }),
      });
      await assert.rejects(malformed.ingest(payload), { code: "invalid_source" });
      assert.equal((await readState()).last_error, "invalid_source");
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.listenbrainz_seed_observations")).rows[0].count, 0);
      await reset();
      await pool.query("ALTER TABLE catalog.listenbrainz_seed_ingestions RENAME TO fixture_hidden_ingestions");
      try {
        await assert.rejects(malformed.ingest(payload), { code: "42P01" });
      } finally {
        await pool.query("ALTER TABLE catalog.fixture_hidden_ingestions RENAME TO listenbrainz_seed_ingestions");
      }
    });

    await t.test("versioned real queue dispatch commits observations then replays after lost acknowledgment", async () => {
      await reset();
      const producer = await startLocalJobRuntime(pool, options);
      runtimes.push(producer);
      assert.deepEqual(await scheduleCatalogStartupSeeds(config, createCatalogSeedStore(pool, producer, queue.name)),
        { planned: 1, inserted: 1, existing: 0 });
      const dataRow = (await pool.query("SELECT data FROM mint_jobs.job WHERE singleton_key = $1", [key])).rows[0];
      assert.deepEqual(dataRow.data, { version: 1, payload });
      let fetched = 0;
      const ingest = createCatalogSeedIngestor(pool, {
        enabledSources: ["listenbrainz"], request: async () => { fetched += 1; return Response.json(fixture()); },
      });
      const worker = await startLocalJobRuntime(pool, {
        ...options, queues: [{ ...queue, handle: async (delivered) => {
          await ingest.ingest(delivered.payload, delivered.signal);
        } }],
      });
      runtimes.push(worker);
      await until(async () => (await pool.query("SELECT state FROM mint_jobs.job WHERE singleton_key = $1", [key])).rows[0]?.state === "completed");
      await worker.stop();
      await producer.stop();
      assert.equal(fetched, 1);
      const before = await readState();
      await pool.query("DELETE FROM mint_jobs.job WHERE singleton_key = $1", [key]);
      const replayProducer = await startLocalJobRuntime(pool, options);
      runtimes.push(replayProducer);
      assert.equal((await replayProducer.enqueue(queue.name, payload, { key })).status, "enqueued");
      const replayWorker = await startLocalJobRuntime(pool, {
        ...options, queues: [{ ...queue, handle: async (delivered) => {
          assert.equal((await ingest.ingest(delivered.payload, delivered.signal)).status, "already_ingested");
        } }],
      });
      runtimes.push(replayWorker);
      await until(async () => (await pool.query("SELECT state FROM mint_jobs.job WHERE singleton_key = $1", [key])).rows[0]?.state === "completed");
      assert.deepEqual(await readState(), before);
      assert.equal(fetched, 1);
      assert.deepEqual(await scheduleCatalogStartupSeeds(config, createCatalogSeedStore(pool, replayProducer, queue.name)),
        { planned: 1, inserted: 0, existing: 1 });
      await replayWorker.stop();
      await replayProducer.stop();
      assert.equal(errors.length, 0);
    });

    await t.test("a failure after domain commit but before queue acknowledgment retries without refetch", async () => {
      await reset();
      const ackQueue: LocalJobQueue = {
        ...queue, name: "fixture.catalog.ack", retryLimit: 1, retryDelaySeconds: 1,
        retryBackoff: false, retryDelayMaxSeconds: undefined,
      };
      let fetched = 0;
      const statuses: string[] = [];
      const ingest = createCatalogSeedIngestor(pool, {
        enabledSources: ["listenbrainz"], request: async () => { fetched += 1; return Response.json(fixture()); },
      });
      const runtime = await startLocalJobRuntime(pool, {
        ...options, queues: [{ ...ackQueue, handle: async (delivered) => {
          statuses.push((await ingest.ingest(delivered.payload, delivered.signal)).status);
          if (delivered.attempt === 1) throw new Error("fixture failure after committed observations");
        } }],
      });
      runtimes.push(runtime);
      assert.equal((await runtime.enqueue(ackQueue.name, payload, { key })).status, "enqueued");
      await until(async () => (await pool.query(
        "SELECT state FROM mint_jobs.job WHERE name = $1", [ackQueue.name],
      )).rows[0]?.state === "completed");
      assert.deepEqual(statuses, ["ingested", "already_ingested"]);
      assert.equal(fetched, 1);
      assert.equal((await readState()).attempts, 1);
      assert.equal((await readState()).state, "completed");
      await runtime.stop();
    });

    await t.test("exhausted/expired jobs retain intent and cooldown; explicit re-enqueue really recovers", async () => {
      await reset();
      const recoveryQueue: LocalJobQueue = {
        ...queue, name: "fixture.catalog.recovery", retryLimit: 1, retryDelaySeconds: 1,
        retryBackoff: false, retryDelayMaxSeconds: undefined, retentionSeconds: 2, deleteAfterSeconds: 2,
      };
      let healthy = false;
      let fetched = 0;
      const ingest = createCatalogSeedIngestor(pool, {
        enabledSources: ["listenbrainz"], request: async () => {
          fetched += 1;
          return healthy ? Response.json(fixture()) : new Response(null, { status: 204 });
        },
      });
      const recovery = await startLocalJobRuntime(pool, {
        ...options, queues: [{ ...recoveryQueue, handle: async (delivered) => {
          await ingest.ingest(delivered.payload, delivered.signal);
        } }],
      });
      runtimes.push(recovery);
      assert.equal((await recovery.enqueue(recoveryQueue.name, payload, { key })).status, "enqueued");
      await until(async () => (await pool.query("SELECT state FROM mint_jobs.job WHERE name = $1", [recoveryQueue.name])).rows[0]?.state === "failed");
      assert.equal(fetched, 1);
      assert.equal((await readState()).state, "retry_wait");
      assert.equal((await readState()).completed_at, null);
      await until(async () => (await pool.query("SELECT count(*)::int AS count FROM mint_jobs.job WHERE name = $1", [recoveryQueue.name])).rows[0].count === 0);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.startup_seed_receipts WHERE key = $1", [key])).rows[0].count, 1);
      healthy = true;
      await permitRetry();
      assert.equal((await recovery.enqueue(recoveryQueue.name, payload, { key })).status, "enqueued");
      await until(async () => (await readState())?.state === "completed");
      assert.equal(fetched, 2);
      await recovery.stop();
      const waiting = await startLocalJobRuntime(pool, { ...options, queues: [recoveryQueue] });
      runtimes.push(waiting);
      assert.equal((await waiting.enqueue(recoveryQueue.name, payload, { key: "waiting-expiry" })).status, "enqueued");
      await until(async () => (await pool.query("SELECT count(*)::int AS count FROM mint_jobs.job WHERE name = $1", [recoveryQueue.name])).rows[0].count === 0);
      assert.equal((await readState()).state, "completed");
      await waiting.stop();
    });

    await t.test("completion remains durable after database restart; zero canonical/media effects", async () => {
      const before = await readState();
      await pool.end();
      await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env });
      started = false;
      await startDatabase();
      pool = new pg.Pool(poolConfig);
      const ingest = createCatalogSeedIngestor(pool, {
        enabledSources: ["listenbrainz"], request: async () => { assert.fail("Completed source must not refetch."); },
      });
      assert.equal((await ingest.ingest(payload)).status, "already_ingested");
      assert.deepEqual(await readState(), before);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.recordings")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM library.media_files")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM library.roots")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.listenbrainz_seed_observations")).rows[0].count, 2);
    });
  } finally {
    try {
      await Promise.all(runtimes.map((runtime) => runtime.stop()));
    } finally {
      await pool.end();
      if (started) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { env });
      await rm(cluster, { recursive: true, force: true });
    }
  }
});
