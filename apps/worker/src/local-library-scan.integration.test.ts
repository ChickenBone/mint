import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createLibraryRepository } from "@mint/domain-library";
import { runStartupMigrations } from "@mint/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  dispatchLibraryScans, LIBRARY_SCAN_QUEUE, requestLibraryScan, runLibraryScanBatch,
  type LocalLibraryScanConfiguration,
} from "./local-library-scan";
import { startLocalWorker, type LocalWorkerError, type LocalWorkerRuntime } from "./local-job-runtime";

const exec = promisify(execFile);
const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));
const options: LocalLibraryScanConfiguration["options"] = {
  maxEntries: 1, maxFiles: 1, maxDepth: 8, timeoutMs: 30_000, maxReplayEntries: 100_000,
  audio: {
    ffprobePath: "/usr/bin/ffprobe", ffmpegPath: "/usr/bin/ffmpeg",
    maxProbeInputBytes: 1024 * 1024, maxDecodeInputBytes: 1024 * 1024,
    maxOutputBytes: 1024 * 1024, probeTimeoutMs: 5000, decodeTimeoutMs: 5000,
  },
};

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail("Expected durable Library scan state was not observed.");
}

test("durable Library scans use disposable PostgreSQL16 and original media", { timeout: 120_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) { t.skip("Set MINT_TEST_POSTGRES_BIN to PostgreSQL16 binaries"); return; }
  const fixture = await mkdtemp(path.join(tmpdir(), "mint-local-scan-"));
  const socket = path.join(fixture, "sock");
  const data = path.join(fixture, "data");
  const media = path.join(fixture, "music");
  const db = {
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
    ssl: false as const, max: 4, connectionTimeoutMillis: 2000,
  };
  const env = {
    ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture",
    PGSERVICE: "", PGSERVICEFILE: "",
  };
  const pool = new pg.Pool(db);
  const repository = createLibraryRepository(drizzle(pool));
  const signal = new AbortController().signal;
  const runtimes: LocalWorkerRuntime[] = [];
  let started = false;
  const state = async (id: string) => (await pool.query(
    "SELECT * FROM library.scan_jobs WHERE root_id = $1", [id],
  )).rows[0];
  const root = async (name: string) => {
    const location = path.join(media, name);
    await mkdir(location);
    const { id } = await repository.createRoot({ path: location });
    return { id, location, config: { rootIds: [id], options } };
  };
  async function finish(id: string, config: LocalLibraryScanConfiguration) {
    for (let batch = 0; batch < 30 && (await state(id)).status === "pending"; batch++) {
      await runLibraryScanBatch(pool, id, config, signal);
    }
    return state(id);
  }
  async function startWorker(libraryScan: LocalLibraryScanConfiguration, errors: LocalWorkerError[]) {
    const runtime = await startLocalWorker({
      enabledSources: ["library"], libraryScan, database: db,
      migrations: { packagesRoot, lockTimeoutMs: 2000 },
      pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 1, maintenanceIntervalSeconds: 60, shutdownTimeoutMs: 1000,
    }, { request: async () => assert.fail("Library-only worker cannot fetch providers"), onError(error) { errors.push(error); } });
    runtimes.push(runtime);
    return runtime;
  }
  try {
    await mkdir(socket);
    await mkdir(media);
    await exec(path.join(bin, "initdb"), ["-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"], { env });
    await exec(path.join(bin, "pg_ctl"), ["-D", data, "-l", path.join(fixture, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`, "-w", "start"], { env });
    started = true;
    assert.match((await pool.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.equal((await pool.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    await runStartupMigrations(pool, { packagesRoot, lockTimeoutMs: 2000 });
    const audio = path.join(fixture, "original.wav");
    await exec("/usr/bin/ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
      "sine=frequency=440:sample_rate=44100:duration=0.1", "-c:a", "pcm_s16le",
      "-metadata", "title=Fixture title", audio]);
    const original = await readFile(audio);

    await t.test("explicit requests checkpoint across fresh processes, preserve originals and do not rescan completed roots", async () => {
      const { id, location, config } = await root("restarted");
      await mkdir(path.join(location, "album"));
      for (const name of ["one.wav", "two.wav", "album/three.wav"]) await writeFile(path.join(location, name), original);
      assert.equal(await state(id), undefined);
      await assert.rejects(requestLibraryScan(pool, randomUUID(), "start"), /foreign key/);
      await assert.rejects(runLibraryScanBatch(pool, id, { ...config, rootIds: [randomUUID()] }, signal), /not enabled/);
      assert.equal(await requestLibraryScan(pool, id, "start"), "accepted");
      const source = `
        import pg from "pg";
        import { runLibraryScanBatch } from ${JSON.stringify(fileURLToPath(new URL("./local-library-scan.ts", import.meta.url)))};
        const pool = new pg.Pool({ max: 1 });
        try { await runLibraryScanBatch(pool, process.argv[1], JSON.parse(process.argv[2]), new AbortController().signal); }
        finally { await pool.end(); }
      `;
      for (let batch = 0; batch < 10 && (await state(id)).status === "pending"; batch++) {
        await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, id, JSON.stringify(config)], { env });
        const stored = await state(id);
        assert.ok(stored.last_result.entriesVisited <= 1);
        assert.ok(stored.last_result.filesVisited <= 1);
        assert.equal(stored.last_result.issues, undefined);
      }
      assert.equal((await state(id)).status, "completed");
      assert.equal((await state(id)).cursor, null);
      const files = await pool.query("SELECT * FROM library.media_files WHERE root_id = $1", [id]);
      assert.equal(files.rowCount, 3);
      assert.ok(files.rows.every((row) => row.availability === "verified" && row.recording_id === null));
      for (const name of ["one.wav", "two.wav", "album/three.wav"]) assert.deepEqual(await readFile(path.join(location, name)), original);
      const completed = await state(id);
      await requestLibraryScan(pool, id, "start");
      await requestLibraryScan(pool, id, "resume");
      await runLibraryScanBatch(pool, id, config, signal);
      assert.deepEqual(await state(id), completed);
      await requestLibraryScan(pool, id, "restart");
      assert.equal((await state(id)).cursor, null);
      assert.equal((await finish(id, config)).status, "completed");
      assert.equal((await pool.query("SELECT count(*) FROM library.media_files WHERE root_id = $1", [id])).rows[0].count, "3");
    });

    await t.test("per-root session lock serializes independent workers and operator requests", async () => {
      const { id, location, config } = await root("serialized");
      await writeFile(path.join(location, "one.wav"), original);
      await requestLibraryScan(pool, id, "start");
      const lock = await pool.connect();
      try {
        await lock.query("SELECT pg_advisory_lock(hashtextextended('mint.library.scan:' || $1, 0))", [id]);
        await runLibraryScanBatch(pool, id, config, signal);
        assert.equal((await state(id)).last_result, null);
        assert.equal(await requestLibraryScan(pool, id, "restart"), "busy");
      } finally {
        await lock.query("SELECT pg_advisory_unlock(hashtextextended('mint.library.scan:' || $1, 0))", [id]);
        lock.release();
      }
      await Promise.all([runLibraryScanBatch(pool, id, config, signal), runLibraryScanBatch(pool, id, config, signal)]);
      assert.equal((await finish(id, config)).status, "completed");
      assert.equal((await pool.query("SELECT count(*) FROM library.media_files WHERE root_id = $1", [id])).rows[0].count, "1");
    });

    await t.test("stale/replay-rejected cursors remain blocked until an explicit restart", async () => {
      const { id, location, config } = await root("stale");
      await writeFile(path.join(location, "one.wav"), original);
      await writeFile(path.join(location, "two.wav"), original);
      await requestLibraryScan(pool, id, "start");
      await runLibraryScanBatch(pool, id, config, signal);
      const cursor = (await state(id)).cursor;
      assert.ok(cursor);
      await assert.rejects(runLibraryScanBatch(pool, id, {
        ...config, options: { ...options, maxReplayEntries: 0 },
      }, signal), /cursor rejected/);
      assert.equal((await state(id)).last_error, "cursor-rejected");
      assert.equal((await state(id)).cursor, cursor);
      await requestLibraryScan(pool, id, "resume");
      await delay(5);
      await writeFile(path.join(location, "added.txt"), "fixture");
      await assert.rejects(runLibraryScanBatch(pool, id, config, signal), /cursor rejected/);
      assert.equal((await state(id)).status, "blocked");
      await requestLibraryScan(pool, id, "start");
      assert.equal((await state(id)).status, "blocked");
      await requestLibraryScan(pool, id, "restart");
      assert.equal((await state(id)).cursor, null);
      assert.equal((await finish(id, config)).status, "completed");
    });

    await t.test("mount and tool failures are explicit and preserve previous checkpoints and audio evidence", async () => {
      const { id, location, config } = await root("unavailable");
      await writeFile(path.join(location, "one.wav"), original);
      await requestLibraryScan(pool, id, "start");
      await runLibraryScanBatch(pool, id, config, signal);
      const cursor = (await state(id)).cursor;
      await rename(location, `${location}-detached`);
      await assert.rejects(runLibraryScanBatch(pool, id, config, signal), /blocked/);
      assert.equal((await state(id)).status, "blocked");
      assert.equal((await state(id)).last_error, "root-unavailable");
      assert.equal((await state(id)).cursor, cursor);
      await rename(`${location}-detached`, location);
      await requestLibraryScan(pool, id, "resume");
      await assert.rejects(runLibraryScanBatch(pool, id, config, signal), /cursor rejected/);
      assert.equal((await state(id)).cursor, cursor, "Moving the directory changes its stamp, never silently reset it");
      await requestLibraryScan(pool, id, "restart");
      const toolFailure = { ...config, options: { ...options, audio: { ...options.audio, ffmpegPath: "/nonexistent-mint-ffmpeg" } } };
      assert.equal((await finish(id, toolFailure)).status, "partial");
      const stored = (await pool.query("SELECT * FROM library.media_files WHERE root_id = $1", [id])).rows[0];
      assert.equal(stored.availability, "verified");
      assert.equal(stored.imported_title, "Fixture title");
      assert.equal(stored.decoded_sample_frames, 4410);
    });

    await t.test("thrown failures are bounded across queue recovery and explicit resume reuses the saved intent", async () => {
      const { id, location, config } = await root("failures");
      await writeFile(path.join(location, "one.wav"), original);
      await requestLibraryScan(pool, id, "start");
      await pool.query(`CREATE FUNCTION public.fixture_reject_scan() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'private-scan-error'; END; $$;
        CREATE TRIGGER fixture_reject_scan BEFORE INSERT ON library.media_files
        FOR EACH ROW EXECUTE FUNCTION public.fixture_reject_scan()`);
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          await assert.rejects(runLibraryScanBatch(pool, id, config, signal), /scan batch failed/);
        }
        const failed = await state(id);
        assert.equal(failed.failures, 5);
        assert.equal(failed.status, "failed");
        assert.equal(failed.last_error, "scan-failed");
        assert.doesNotMatch(JSON.stringify(failed), /private-scan-error/);
        await runLibraryScanBatch(pool, id, config, signal);
        assert.deepEqual(await state(id), failed);
      } finally {
        await pool.query("DROP TRIGGER fixture_reject_scan ON library.media_files; DROP FUNCTION public.fixture_reject_scan()");
      }
      await requestLibraryScan(pool, id, "resume");
      assert.equal((await finish(id, config)).status, "completed");
    });

    await t.test("a checkpoint write failure replays file verification without duplicating media identity", async () => {
      const { id, location, config } = await root("checkpoint-failure");
      await writeFile(path.join(location, "one.wav"), original);
      await requestLibraryScan(pool, id, "start");
      await pool.query(`CREATE FUNCTION public.fixture_reject_checkpoint() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'fixture-checkpoint-failure'; END; $$;
        CREATE TRIGGER fixture_reject_checkpoint BEFORE UPDATE ON library.scan_jobs
        FOR EACH ROW EXECUTE FUNCTION public.fixture_reject_checkpoint()`);
      try {
        await assert.rejects(runLibraryScanBatch(pool, id, config, signal), /fixture-checkpoint-failure/);
        assert.equal((await state(id)).cursor, null);
        assert.equal((await state(id)).status, "pending");
        assert.equal((await pool.query("SELECT availability FROM library.media_files WHERE root_id = $1", [id])).rows[0].availability, "verified");
      } finally {
        await pool.query("DROP TRIGGER fixture_reject_checkpoint ON library.scan_jobs; DROP FUNCTION public.fixture_reject_checkpoint()");
      }
      assert.equal((await finish(id, config)).status, "completed");
      assert.equal((await pool.query("SELECT count(*) FROM library.media_files WHERE root_id = $1", [id])).rows[0].count, "1");
    });

    await t.test("losing a checked-out PostgreSQL connection leaves recoverable intent without an unhandled client error", async () => {
      const { id, location, config } = await root("connection-loss");
      await writeFile(path.join(location, "one.wav"), original);
      await requestLibraryScan(pool, id, "start");
      const scannerPool = new pg.Pool({ ...db, application_name: "mint-fixture-lock-loss" });
      await pool.query(`CREATE FUNCTION public.fixture_block_scan() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN PERFORM pg_sleep(10); RETURN NEW; END; $$;
        CREATE TRIGGER fixture_block_scan BEFORE INSERT ON library.media_files
        FOR EACH ROW EXECUTE FUNCTION public.fixture_block_scan()`);
      try {
        const rejected = assert.rejects(runLibraryScanBatch(scannerPool, id, config, signal));
        let pid: number | undefined;
        await until(async () => {
          pid = (await pool.query("SELECT pid FROM pg_stat_activity WHERE application_name = 'mint-fixture-lock-loss' AND wait_event = 'PgSleep'")).rows[0]?.pid;
          return pid !== undefined;
        });
        await pool.query("SELECT pg_terminate_backend($1)", [pid]);
        await rejected;
        assert.equal((await state(id)).status, "pending");
        assert.equal((await state(id)).cursor, null);
      } finally {
        await scannerPool.end();
        await pool.query("DROP TRIGGER fixture_block_scan ON library.media_files; DROP FUNCTION public.fixture_block_scan()");
      }
      assert.equal((await finish(id, config)).status, "completed");
    });

    await t.test("cancelled batches preserve pending intent and recovery dispatch is allowlisted", async () => {
      const { id, config } = await root("cancelled");
      await requestLibraryScan(pool, id, "start");
      const aborted = AbortSignal.abort();
      await assert.rejects(runLibraryScanBatch(pool, id, config, aborted), { name: "AbortError" });
      assert.equal((await state(id)).status, "pending");
      assert.equal((await state(id)).failures, 0);
      const enqueued: string[] = [];
      await dispatchLibraryScans(pool, {
        async enqueue(queue, payload, send) {
          assert.equal(queue, LIBRARY_SCAN_QUEUE.name);
          assert.deepEqual(payload, { rootId: id });
          assert.equal(send.key, id);
          enqueued.push(id);
          return { status: "enqueued", id: randomUUID() };
        },
        async stop() {},
      }, config.rootIds);
      assert.deepEqual(enqueued, [id]);
    });

    await t.test("repeated in-flight shutdown preserves checkpoints and failure budget; genuine errors still count", async () => {
      const { id, location, config } = await root("shutdown");
      await writeFile(path.join(location, "one.wav"), original);
      await requestLibraryScan(pool, id, "start");
      await pool.query("UPDATE library.scan_jobs SET failures = 2, last_error = 'scan-failed' WHERE root_id = $1", [id]);
      await pool.query(`CREATE FUNCTION public.fixture_slow_admission() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN PERFORM pg_sleep(0.25); RETURN NEW; END; $$;
        CREATE TRIGGER fixture_slow_admission BEFORE INSERT ON library.media_files
        FOR EACH ROW EXECUTE FUNCTION public.fixture_slow_admission()`);
      const errors: LocalWorkerError[] = [];
      try {
        for (let restart = 0; restart < 6; restart++) {
          const worker = await startWorker(config, errors);
          await until(async () => (await pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = 'mint-local-worker' AND wait_event = 'PgSleep') AS waiting",
          )).rows[0].waiting);
          await worker.stop();
          const stored = await state(id);
          assert.equal(stored.status, "pending");
          assert.equal(stored.failures, 2);
          assert.equal(stored.last_error, "scan-failed");
          assert.equal(stored.last_result.status, "cancelled");
          assert.equal(stored.had_issues, false);
          assert.ok(stored.cursor);
        }
      } finally {
        await pool.query("DROP TRIGGER fixture_slow_admission ON library.media_files; DROP FUNCTION public.fixture_slow_admission()");
      }
      assert.deepEqual(errors, []);

      // Exercise cancellation inside the real media tool, not only while awaiting SQL.
      const marker = path.join(fixture, "decode-started");
      const tool = path.join(fixture, "slow-ffmpeg");
      await writeFile(tool, `#!/bin/sh\nprintf ready > ${JSON.stringify(marker)}\nexec /usr/bin/ffmpeg -re "$@"\n`, { mode: 0o700 });
      await exec("/usr/bin/ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=44100:duration=3", "-c:a", "pcm_s16le", "-y", path.join(location, "one.wav")]);
      const slowConfig = { ...config, options: { ...options, audio: { ...options.audio, ffmpegPath: tool } } };
      const worker = await startWorker(slowConfig, errors);
      await until(async () => existsSync(marker));
      await worker.stop();
      const interrupted = await state(id);
      assert.equal(interrupted.status, "pending");
      assert.equal(interrupted.failures, 2);
      assert.equal(interrupted.last_result.status, "cancelled");
      assert.equal(interrupted.had_issues, false, "A cancelled decode must not turn a successfully resumed scan into partial");
      assert.deepEqual(errors, []);

      // A real persistence error concurrent with cancellation is not an AbortError.
      await pool.query(`CREATE FUNCTION public.fixture_fail_after_delay() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN PERFORM pg_sleep(0.25); RAISE EXCEPTION 'fixture-real-failure'; END; $$;
        CREATE TRIGGER fixture_fail_after_delay BEFORE INSERT ON library.media_files
        FOR EACH ROW EXECUTE FUNCTION public.fixture_fail_after_delay()`);
      try {
        const abort = new AbortController();
        const rejected = assert.rejects(runLibraryScanBatch(pool, id, config, abort.signal), /scan batch failed/);
        await until(async () => (await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep') AS waiting",
        )).rows[0].waiting);
        abort.abort();
        await rejected;
        assert.equal((await state(id)).failures, 3);
        assert.equal((await state(id)).last_error, "scan-failed");
      } finally {
        await pool.query("DROP TRIGGER fixture_fail_after_delay ON library.media_files; DROP FUNCTION public.fixture_fail_after_delay()");
      }
      assert.equal((await finish(id, config)).status, "completed");
      assert.equal((await state(id)).failures, 0);
    });

    await t.test("real local runtime recovers exhausted jobs, resumes after restart and never scans unrelated roots", async () => {
      const { id, location, config } = await root("runtime");
      const unrelated = await root("not-configured");
      for (const name of ["one.wav", "two.wav", "three.wav", "four.wav", "five.wav"]) {
        await writeFile(path.join(location, name), original);
      }
      await writeFile(path.join(unrelated.location, "private.wav"), original);
      const errors: LocalWorkerError[] = [];
      const start = () => startWorker(config, errors);
      const first = await start();
      await until(async () => !!(await state(id))?.cursor);
      await first.stop();
      assert.equal((await state(id)).status, "pending");
      assert.ok((await state(id)).cursor);
      // This is a disposable DB: emulate exhausted queue jobs independently from durable domain intent.
      await pool.query("UPDATE mint_jobs.job SET state = 'failed' WHERE name = $1", [LIBRARY_SCAN_QUEUE.name]);
      const second = await start();
      await until(async () => (await state(id)).status === "completed");
      assert.ok(Number((await pool.query("SELECT count(*) FROM mint_jobs.job WHERE name = $1", [LIBRARY_SCAN_QUEUE.name])).rows[0].count) > 1);
      await assert.rejects(second.requestScan(unrelated.id, "restart"), /not enabled/);
      assert.equal(await state(unrelated.id), undefined);
      assert.equal((await pool.query("SELECT count(*) FROM library.media_files WHERE root_id = $1", [unrelated.id])).rows[0].count, "0");
      const completed = await state(id);
      await second.stop();
      const third = await start();
      await delay(650);
      assert.deepEqual(await state(id), completed);
      await third.stop();
      assert.deepEqual(errors, []);
      assert.equal((await pool.query("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'mint-local-worker'")).rows[0].count, "0");
    });

    await t.test("standalone entrypoint accepts explicit Library configuration and exits cleanly after real scanning", async () => {
      const { id, location, config } = await root("standalone");
      await writeFile(path.join(location, "one.wav"), original);
      const workerRoot = fileURLToPath(new URL("../", import.meta.url));
      const main = process.env.MINT_TEST_LOCAL_WORKER_MAIN
        ? path.resolve(workerRoot, process.env.MINT_TEST_LOCAL_WORKER_MAIN)
        : fileURLToPath(new URL("./local-job-main.ts", import.meta.url));
      const child = spawn(process.execPath, ["--import", path.join(workerRoot, "node_modules/tsx/dist/loader.mjs"), main], {
        cwd: fixture, stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...env, MINT_LOCAL_WORKER_ENABLED_SOURCES: '["library"]',
          MINT_LOCAL_WORKER_LIBRARY_SCAN: JSON.stringify(config),
          MINT_LOCAL_WORKER_DB_HOST: socket, MINT_LOCAL_WORKER_DB_PORT: "5432",
          MINT_LOCAL_WORKER_DB_NAME: "postgres", MINT_LOCAL_WORKER_DB_USER: "fixture",
          MINT_LOCAL_WORKER_DB_PASSWORD: "", MINT_LOCAL_WORKER_DB_TLS: "disabled",
          MINT_LOCAL_WORKER_DB_POOL_MAX: "2", MINT_LOCAL_WORKER_DB_CONNECT_TIMEOUT_MS: "2000",
          MINT_LOCAL_WORKER_MIGRATIONS_PACKAGES_ROOT: packagesRoot, MINT_LOCAL_WORKER_MIGRATIONS_LOCK_TIMEOUT_MS: "2000",
          MINT_LOCAL_WORKER_POLLING_INTERVAL_SECONDS: "0.5", MINT_LOCAL_WORKER_SUPERVISE_INTERVAL_SECONDS: "1",
          MINT_LOCAL_WORKER_MAINTENANCE_INTERVAL_SECONDS: "60", MINT_LOCAL_WORKER_SHUTDOWN_TIMEOUT_MS: "1000",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      try {
        await until(async () => (await state(id))?.status === "completed");
        assert.match(stdout, /local-worker-running/);
        assert.equal((await pool.query("SELECT count(*) FROM catalog.startup_seed_receipts")).rows[0].count, "0");
        child.kill("SIGTERM");
        await until(async () => child.exitCode !== null);
        assert.equal(child.exitCode, 0);
        assert.match(stdout, /local-worker-stopped/);
        assert.equal(stderr, "");
        assert.deepEqual(await readFile(path.join(location, "one.wav")), original);
        assert.equal((await pool.query("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'mint-local-worker'")).rows[0].count, "0");
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await until(async () => child.exitCode !== null || child.signalCode !== null);
        }
      }
    });
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.stop()));
    await pool.end();
    if (started) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { env });
    await rm(fixture, { recursive: true, force: true });
  }
});
