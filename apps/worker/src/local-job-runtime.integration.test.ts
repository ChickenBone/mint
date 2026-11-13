import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CATALOG_LISTENBRAINZ_SEED_QUEUE_V1 as queue, planCatalogStartupSeeds } from "@mint/domain-catalog";
import pg from "pg";
import type { LocalWorkerConfiguration } from "./local-job-config";
import { startLocalWorker, type LocalWorkerRuntime, type LocalWorkerError } from "./local-job-runtime";

const exec = promisify(execFile);
const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail("Expected local worker state was not observed.");
}

test("local worker composes migrations, real ingestion, restart, failure and cleanup on PostgreSQL16", { timeout: 90_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) { t.skip("Set MINT_TEST_POSTGRES_BIN to PostgreSQL16 binaries"); return; }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-local-worker-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "sock");
  const db = {
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
    ssl: false as const, max: 4, connectionTimeoutMillis: 2000,
  };
  const config: Extract<LocalWorkerConfiguration, { database: unknown }> = {
    enabledSources: ["listenbrainz"], database: db, migrations: { packagesRoot, lockTimeoutMs: 2000 },
    pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 1, maintenanceIntervalSeconds: 60, shutdownTimeoutMs: 1000,
  };
  const env = { ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture", PGSERVICE: "", PGSERVICEFILE: "" };
  const observer = new pg.Pool(db);
  const errors: LocalWorkerError[] = [];
  const runtimes: LocalWorkerRuntime[] = [];
  let started = false;
  const connections = async () => Number((await observer.query(
    "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'mint-local-worker'",
  )).rows[0].count);
  const count = async (table: string) => Number((await observer.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  const start = async (request: typeof fetch, override = config) => {
    const runtime = await startLocalWorker(override, { request, onError(error) { errors.push(error); } });
    runtimes.push(runtime);
    return runtime;
  };
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), ["-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"], { env });
    await exec(path.join(bin, "pg_ctl"), ["-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`, "-w", "start"], { env });
    started = true;
    assert.match((await observer.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.equal((await observer.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    let fetched = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request: typeof fetch = async (input) => {
      assert.equal(await count("mint_migrations.__drizzle_migrations"), 9);
      assert.match(String(input), /^https:\/\/api\.listenbrainz\.org\//);
      fetched++;
      await gate;
      return Response.json({ payload: {
        range: "week", from_ts: 100, to_ts: 200, last_updated: 201,
        recordings: [{ recording_mbid: "12345678-1234-4234-8234-123456789012",
          track_name: "Fixture Song", artist_name: "Fixture Artist", listen_count: 7 }],
      } });
    };
    const runtime = await start(request);
    assert.equal(runtime.status, "running");
    await until(async () => fetched === 1);
    assert.equal(await count("catalog.startup_seed_receipts"), 1);
    assert.equal(await count("catalog.listenbrainz_seed_observations"), 0);
    const stopping = runtime.stop();
    assert.equal(stopping, runtime.stop());
    release();
    await stopping;
    assert.equal(await connections(), 0);
    assert.equal(await count("catalog.listenbrainz_seed_observations"), 1);
    assert.equal(await count("catalog.recordings"), 0);
    assert.equal(await count("library.media_files"), 0);
    assert.equal(errors.length, 0);
    const restarted = await start(async () => { assert.fail("Restart must not refetch permanent seed"); });
    await delay(600);
    assert.equal(fetched, 1);
    assert.equal(await count("catalog.startup_seed_receipts"), 1);
    assert.equal(await count("mint_jobs.job"), 1);
    await restarted.stop();
    assert.equal(await connections(), 0);

    await t.test("handler failure remains failed/retrying intent, never successful ingestion", async () => {
      await observer.query("DELETE FROM catalog.listenbrainz_seed_observations");
      await observer.query("DELETE FROM catalog.listenbrainz_seed_ingestions");
      await observer.query("DELETE FROM catalog.startup_seed_receipts");
      await observer.query("DELETE FROM mint_jobs.job");
      const failed = await start(async () => { throw new Error("private-provider-error"); });
      try {
        await until(async () => errors.some((error) => error.name === "LocalJobHandlerError"));
        // The error callback can precede pg-boss persisting the failed attempt.
        await until(async () => (await observer.query("SELECT state FROM mint_jobs.job")).rows[0]?.state === "retry");
        assert.equal(await count("mint_jobs.job"), 1);
        assert.equal(await count("catalog.listenbrainz_seed_observations"), 0);
        assert.doesNotMatch(JSON.stringify(errors), /private-provider-error/);
      } finally {
        await failed.stop();
      }
      assert.equal(await connections(), 0);
    });

    await t.test("seed scheduling failure rolls back intent and releases consumers and pool", async () => {
      await observer.query("DELETE FROM mint_jobs.job");
      await observer.query("DELETE FROM catalog.startup_seed_receipts");
      await observer.query(`CREATE FUNCTION public.fixture_reject_seed() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'private-seed-error'; END; $$;
        CREATE TRIGGER fixture_reject_seed BEFORE INSERT ON catalog.startup_seed_receipts
        FOR EACH ROW EXECUTE FUNCTION public.fixture_reject_seed()`);
      try {
        await assert.rejects(start(async () => { assert.fail("Cannot ingest rolled-back intent"); }), /seed-scheduling/);
        assert.equal(await connections(), 0);
        assert.equal(await count("catalog.startup_seed_receipts"), 0);
        assert.equal(await count("mint_jobs.job"), 0);
        assert.doesNotMatch(JSON.stringify(errors), /private-seed-error/);
      } finally {
        await observer.query("DROP TRIGGER fixture_reject_seed ON catalog.startup_seed_receipts; DROP FUNCTION public.fixture_reject_seed()");
      }
    });

    await t.test("migration and persisted queue failures release the owned pool", async () => {
      await assert.rejects(start(async () => { assert.fail("Must not fetch"); }, {
        ...config, migrations: { ...config.migrations, packagesRoot: path.join(cluster, "missing") },
      }), /startup failed/);
      assert.equal(await connections(), 0);
      await observer.query("UPDATE mint_jobs.queue SET retry_limit = 0 WHERE name = $1", [queue.name]);
      await assert.rejects(start(async () => { assert.fail("Must not fetch"); }), /startup failed/);
      assert.equal(await connections(), 0);
      assert.ok(errors.some((error) => error.name === "LocalWorkerStartupError"));
    });
    assert.equal(planCatalogStartupSeeds({ enabledSources: ["listenbrainz"], countries: [], youtubeChannels: [], maxJobs: 1 }).length, 1);
  } finally {
    try { await Promise.all(runtimes.map((runtime) => runtime.stop())); }
    finally {
      await observer.end();
      if (started) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { env });
      await rm(cluster, { recursive: true, force: true });
    }
  }
});
