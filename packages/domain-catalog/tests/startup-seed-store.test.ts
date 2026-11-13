import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  startLocalJobRuntime,
  type LocalJobQueue,
  type LocalJobRuntime,
  type LocalJobRuntimeOptions,
} from "@mint/platform";
import pg from "pg";
import { createCatalogSeedStore } from "../src/startup-seed-store";
import {
  planCatalogStartupSeeds,
  scheduleCatalogStartupSeeds,
  type CatalogStartupSeedConfig,
} from "../src/startup-seeding";

const exec = promisify(execFile);
const config: CatalogStartupSeedConfig = {
  enabledSources: ["apple", "listenbrainz"], countries: ["us", "gb"],
  youtubeChannels: [], maxJobs: 10,
};
const queue: LocalJobQueue = {
  name: "catalog.startup", retryLimit: 2, retryDelaySeconds: 1, retryBackoff: false,
  expireInSeconds: 10, retentionSeconds: 60, deleteAfterSeconds: 1, concurrency: 1,
};

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail("Expected Catalog job state was not observed before the deadline.");
}

test("connection failures propagate without queueing intent", async () => {
  const pool = new pg.Pool({ host: "/nonexistent-mint-catalog-fixture", connectionTimeoutMillis: 100 });
  let called = false;
  const store = createCatalogSeedStore(pool, {
    async enqueue() { called = true; throw new Error("unexpected enqueue"); },
  }, queue.name);
  try {
    await assert.rejects(scheduleCatalogStartupSeeds(config, store));
    assert.equal(called, false);
  } finally {
    await pool.end();
  }
});

test("seed scheduling requires bounded pool acquisition and pre-abort never connects", async () => {
  const unbounded = new pg.Pool();
  const bounded = new pg.Pool({ host: "/nonexistent-mint-catalog-fixture", connectionTimeoutMillis: 100 });
  try {
    assert.throws(() => createCatalogSeedStore(unbounded, {
      async enqueue() { throw new Error("unexpected enqueue"); },
    }, queue.name), /connection timeout/);
    const store = createCatalogSeedStore(bounded, {
      async enqueue() { throw new Error("unexpected enqueue"); },
    }, queue.name);
    await assert.rejects(scheduleCatalogStartupSeeds(config, store, AbortSignal.abort()), { name: "AbortError" });
    assert.equal(bounded.totalCount, 0);
  } finally {
    await Promise.all([unbounded.end(), bounded.end()]);
  }
});

test("durable Catalog seed receipts on disposable PostgreSQL16 and real jobs", { timeout: 90_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to PostgreSQL16 binaries for disposable DB proof");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const postgresBin = bin;
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-catalog-seeds-pg-"));
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
  const errors: Parameters<LocalJobRuntimeOptions["onError"]>[0][] = [];
  const options: LocalJobRuntimeOptions = {
    migrations: { packagesRoot: fileURLToPath(new URL("../../", import.meta.url)), lockTimeoutMs: 5_000 },
    queues: [queue], pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 1,
    maintenanceIntervalSeconds: 1, shutdownTimeoutMs: 1_000,
    onError: (error) => { errors.push(error); },
  };
  const runtimes: LocalJobRuntime[] = [];
  let started = false;
  async function startDatabase() {
    await exec(path.join(postgresBin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-w", "start",
    ], { env });
    started = true;
  }
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ], { env });
    await startDatabase();
    assert.match((await pool.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.equal((await pool.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    const producer = await startLocalJobRuntime(pool, options);
    runtimes.push(producer);
    let store = createCatalogSeedStore(pool, producer, queue.name);

    await t.test("concurrent startups enqueue exactly one intent per permanent key", async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => scheduleCatalogStartupSeeds(config, store)));
      assert.equal(results.reduce((sum, result) => sum + result.inserted, 0), 3);
      assert.equal(results.reduce((sum, result) => sum + result.existing, 0), 27);
      assert.ok(results.every((result) => result.planned === 3));
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.startup_seed_receipts")).rows[0].count, 3);
      const jobs = await pool.query("SELECT singleton_key, data FROM mint_jobs.job ORDER BY singleton_key");
      assert.deepEqual(jobs.rows, planCatalogStartupSeeds(config).map((job) => ({
        singleton_key: job.key, data: { version: 1, payload: { version: 1, job } },
      })).sort((a, b) => a.singleton_key.localeCompare(b.singleton_key)));
      const existingOnly = createCatalogSeedStore(pool, {
        async enqueue() { throw new Error("Existing receipts must not access the queue"); },
      }, queue.name);
      const before = (await pool.query("SELECT * FROM mint_jobs.job ORDER BY id")).rows;
      assert.deepEqual(await scheduleCatalogStartupSeeds(config, existingOnly), { planned: 3, inserted: 0, existing: 3 });
      assert.deepEqual((await pool.query("SELECT * FROM mint_jobs.job ORDER BY id")).rows, before);
    });

    const extraConfig: CatalogStartupSeedConfig = { ...config, enabledSources: ["apple"], countries: ["au"] };
    const extraJob = planCatalogStartupSeeds(extraConfig)[0]!;
    await t.test("an already queued singleton gains a receipt without replacing its intent or state", async () => {
      assert.equal((await producer.enqueue(queue.name, { original: true }, { key: extraJob.key })).status, "enqueued");
      const before = (await pool.query("SELECT * FROM mint_jobs.job WHERE singleton_key = $1", [extraJob.key])).rows;
      assert.equal(await store.insertIfAbsent(extraJob), "inserted");
      assert.equal(await store.insertIfAbsent(extraJob), "existing");
      assert.deepEqual((await pool.query("SELECT * FROM mint_jobs.job WHERE singleton_key = $1", [extraJob.key])).rows, before);
    });

    const failedJob = { ...extraJob, key: "catalog:startup:rollback" };
    await t.test("queue rejection rolls back the receipt and propagates the original failure", async () => {
      const invalidQueue = createCatalogSeedStore(pool, producer, "unregistered");
      await assert.rejects(invalidQueue.insertIfAbsent(failedJob), /Unknown local job queue/);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.startup_seed_receipts WHERE key = $1", [failedJob.key])).rows[0].count, 0);
    });

    await t.test("failure after real enqueue rolls back both writes; retry can commit both", async () => {
      const failure = new Error("fixture queue failure after insert");
      const failingStore = createCatalogSeedStore(pool, {
        async enqueue(name, payload, enqueueOptions) {
          assert.ok(enqueueOptions.transaction);
          const result = await producer.enqueue(name, payload, enqueueOptions);
          assert.equal(result.status, "enqueued");
          assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.startup_seed_receipts WHERE key = $1", [failedJob.key])).rows[0].count, 0);
          assert.equal((await pool.query("SELECT count(*)::int AS count FROM mint_jobs.job WHERE singleton_key = $1", [failedJob.key])).rows[0].count, 0);
          throw failure;
        },
      }, queue.name);
      await assert.rejects(failingStore.insertIfAbsent(failedJob), (error) => error === failure);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.startup_seed_receipts WHERE key = $1", [failedJob.key])).rows[0].count, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM mint_jobs.job WHERE singleton_key = $1", [failedJob.key])).rows[0].count, 0);
      assert.equal(await store.insertIfAbsent(failedJob), "inserted");
    });

    await t.test("receipt SQL failures propagate, do not enqueue, and leave the connection reusable", async () => {
      await pool.query("ALTER TABLE catalog.startup_seed_receipts RENAME TO fixture_hidden_receipts");
      let called = false;
      try {
        const missingTable = createCatalogSeedStore(pool, {
          async enqueue() { called = true; throw new Error("unexpected enqueue"); },
        }, queue.name);
        await assert.rejects(missingTable.insertIfAbsent(extraJob), { code: "42P01" });
        assert.equal(called, false);
        assert.equal((await pool.query("SELECT 1 AS ready")).rows[0].ready, 1);
      } finally {
        await pool.query("ALTER TABLE catalog.fixture_hidden_receipts RENAME TO startup_seed_receipts");
      }
    });

    await t.test("same-key lock wait is bounded, rolls back, and retry preserves atomic intent", async () => {
      const blockedJob = { ...extraJob, key: "catalog:startup:blocked-lock" };
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query("INSERT INTO catalog.startup_seed_receipts (key) VALUES ($1)", [blockedJob.key]);
      const before = performance.now();
      try {
        await assert.rejects(store.insertIfAbsent(blockedJob), { code: "55P03" });
        assert.ok(performance.now() - before < 3000);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.startup_seed_receipts WHERE key = $1", [blockedJob.key])).rows[0].count, 0);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM mint_jobs.job WHERE singleton_key = $1", [blockedJob.key])).rows[0].count, 0);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      assert.equal(await store.insertIfAbsent(blockedJob), "inserted");
      await pool.query("DELETE FROM mint_jobs.job WHERE singleton_key = $1", [blockedJob.key]);
      await pool.query("DELETE FROM catalog.startup_seed_receipts WHERE key = $1", [blockedJob.key]);
    });

    await t.test("saturated pool acquisition rejects within its configured bound", async () => {
      const saturated = new pg.Pool({ ...poolConfig, max: 1, connectionTimeoutMillis: 100 });
      const borrowed = await saturated.connect();
      const boundedStore = createCatalogSeedStore(saturated, producer, queue.name);
      const before = performance.now();
      try {
        await assert.rejects(boundedStore.insertIfAbsent(extraJob), /timeout/i);
        assert.ok(performance.now() - before < 1000);
      } finally {
        borrowed.release();
        await saturated.end();
      }
    });

    await t.test("abort during a blocked same-key INSERT destroys only the borrowed client and leaks no session", async () => {
      const blockedJob = { ...extraJob, key: "catalog:startup:blocked-abort" };
      const blocker = await pool.connect();
      const abortPool = new pg.Pool({ ...poolConfig, max: 1, application_name: "catalog-seed-abort-fixture" });
      await blocker.query("BEGIN");
      await blocker.query("INSERT INTO catalog.startup_seed_receipts (key) VALUES ($1)", [blockedJob.key]);
      const controller = new AbortController();
      const abortStore = createCatalogSeedStore(abortPool, producer, queue.name);
      const waiting = abortStore.insertIfAbsent(blockedJob, controller.signal);
      const rejected = assert.rejects(waiting, { name: "AbortError" });
      try {
        await until(async () => (await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = 'catalog-seed-abort-fixture' AND wait_event_type = 'Lock') AS blocked",
        )).rows[0].blocked);
        const before = performance.now();
        controller.abort();
        await rejected;
        assert.ok(performance.now() - before < 1000);
        await until(async () => (await pool.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'catalog-seed-abort-fixture'",
        )).rows[0].count === 0);
        assert.equal(abortPool.totalCount, 0);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM mint_jobs.job WHERE singleton_key = $1", [blockedJob.key])).rows[0].count, 0);
        await blocker.query("ROLLBACK");
        assert.equal(await abortStore.insertIfAbsent(blockedJob), "inserted");
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.startup_seed_receipts WHERE key = $1", [blockedJob.key])).rows[0].count, 1);
      } finally {
        controller.abort();
        await blocker.query("ROLLBACK");
        blocker.release();
        await abortPool.end();
        await pool.query("DELETE FROM mint_jobs.job WHERE singleton_key = $1", [blockedJob.key]);
        await pool.query("DELETE FROM catalog.startup_seed_receipts WHERE key = $1", [blockedJob.key]);
      }
    });

    await t.test("abort after real enqueue rolls back both uncommitted writes without reusing the evicted client", async () => {
      const abortedJob = { ...extraJob, key: "catalog:startup:abort-enqueue" };
      const controller = new AbortController();
      const cancelling = createCatalogSeedStore(pool, {
        async enqueue(name, payload, enqueueOptions) {
          const result = await producer.enqueue(name, payload, enqueueOptions);
          controller.abort();
          return result;
        },
      }, queue.name);
      await assert.rejects(cancelling.insertIfAbsent(abortedJob, controller.signal), { name: "AbortError" });
      await until(async () => (await pool.query(
        "SELECT count(*)::int AS count FROM catalog.startup_seed_receipts WHERE key = $1", [abortedJob.key],
      )).rows[0].count === 0);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM mint_jobs.job WHERE singleton_key = $1", [abortedJob.key])).rows[0].count, 0);
      assert.equal(await store.insertIfAbsent(abortedJob), "inserted");
      await pool.query("DELETE FROM mint_jobs.job WHERE singleton_key = $1", [abortedJob.key]);
      await pool.query("DELETE FROM catalog.startup_seed_receipts WHERE key = $1", [abortedJob.key]);
    });

    await t.test("whole transaction deadline stops slow SQL and preserves caller pool ownership", async () => {
      const slowJob = { ...extraJob, key: "catalog:startup:slow-sql" };
      await pool.query(`CREATE FUNCTION catalog.fixture_slow_seed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(30); RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER fixture_slow_seed BEFORE INSERT ON catalog.startup_seed_receipts
        FOR EACH ROW EXECUTE FUNCTION catalog.fixture_slow_seed()`);
      const before = performance.now();
      try {
        await assert.rejects(store.insertIfAbsent(slowJob));
        assert.ok(performance.now() - before < 7000);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalog.startup_seed_receipts WHERE key = $1", [slowJob.key])).rows[0].count, 0);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM mint_jobs.job WHERE singleton_key = $1", [slowJob.key])).rows[0].count, 0);
        assert.equal((await pool.query("SELECT 1 AS ready")).rows[0].ready, 1);
      } finally {
        await pool.query("DROP TRIGGER fixture_slow_seed ON catalog.startup_seed_receipts");
        await pool.query("DROP FUNCTION catalog.fixture_slow_seed()");
      }
    });

    await t.test("receipts survive real job retention and a database/runtime restart", async () => {
      await producer.stop();
      let completed = 0;
      const worker = await startLocalJobRuntime(pool, {
        ...options, queues: [{ ...queue, handle: async () => { completed += 1; } }],
      });
      runtimes.push(worker);
      await until(async () => (await pool.query("SELECT count(*)::int AS count FROM mint_jobs.job")).rows[0].count === 0);
      assert.equal(completed, 5);
      const receipts = (await pool.query("SELECT * FROM catalog.startup_seed_receipts ORDER BY key")).rows;
      assert.equal(receipts.length, 5);
      await worker.stop();
      await pool.end();
      await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env });
      started = false;
      await startDatabase();
      pool = new pg.Pool(poolConfig);
      const restarted = await startLocalJobRuntime(pool, options);
      runtimes.push(restarted);
      store = createCatalogSeedStore(pool, restarted, queue.name);
      assert.deepEqual(await scheduleCatalogStartupSeeds(config, store), { planned: 3, inserted: 0, existing: 3 });
      assert.equal(await store.insertIfAbsent(extraJob), "existing");
      assert.equal(await store.insertIfAbsent(failedJob), "existing");
      assert.deepEqual((await pool.query("SELECT * FROM catalog.startup_seed_receipts ORDER BY key")).rows, receipts);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM mint_jobs.job")).rows[0].count, 0);
      assert.deepEqual(errors, []);
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
