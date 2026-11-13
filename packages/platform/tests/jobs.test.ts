import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { startLocalJobRuntime, type LocalJobQueue, type LocalJobRuntime, type LocalJobRuntimeOptions } from "../src/index";

const exec = promisify(execFile);
const packagesRoot = fileURLToPath(new URL("../../", import.meta.url));
const queue: LocalJobQueue = {
  name: "fixture.jobs", retryLimit: 2, retryDelaySeconds: 1, retryBackoff: false,
  expireInSeconds: 3, retentionSeconds: 60,
  deleteAfterSeconds: 60, concurrency: 1,
};
const errors: Parameters<LocalJobRuntimeOptions["onError"]>[0][] = [];
const options: LocalJobRuntimeOptions = {
  migrations: { packagesRoot, lockTimeoutMs: 5_000 }, queues: [queue],
  pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 1, maintenanceIntervalSeconds: 60, shutdownTimeoutMs: 1_000,
  onError: (error) => { errors.push(error); },
};

async function until(check: () => Promise<boolean>, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail("Expected job state was not observed before the deadline.");
}

test("local runtime rejects invalid configuration without connecting", async () => {
  const pool = new pg.Pool({ host: "/nonexistent-mint-jobs-fixture", connectionTimeoutMillis: 100 });
  try {
    for (const patch of [
      { queues: [] }, { queues: [queue, queue] }, { pollingIntervalSeconds: 0 },
      { superviseIntervalSeconds: 0 }, { shutdownTimeoutMs: 999 },
      { queues: [{ ...queue, retryLimit: 21 }] }, { queues: [{ ...queue, concurrency: 0 }] },
      { queues: [{ ...queue, deleteAfterSeconds: 0 }] }, { queues: [{ ...queue, name: "not a queue" }] },
    ]) {
      await assert.rejects(startLocalJobRuntime(pool, { ...options, ...patch }), /configuration/);
    }
    assert.equal(pool.totalCount, 0);
  } finally {
    await pool.end();
  }
});

test("local jobs on disposable PostgreSQL", { timeout: 90_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL binaries for disposable DB proof");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-jobs-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "socket");
  const config = {
    host: socket, port: 5432, database: "postgres", user: "fixture",
    password: "", max: 4, connectionTimeoutMillis: 2_000,
  };
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture" };
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  const pool = new pg.Pool(config);
  const runtimes: LocalJobRuntime[] = [];
  let started = false;
  let child: ChildProcess | undefined;
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), ["-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"], { env });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`, "-w", "start",
    ], { env });
    started = true;
    assert.match((await pool.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.equal((await pool.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    const producer = await startLocalJobRuntime(pool, options);
    runtimes.push(producer);
    await pool.query("CREATE TABLE fixture_intent (id text PRIMARY KEY)");

    await t.test("domain writes and enqueue commit or roll back together", async () => {
      const transaction = await pool.connect();
      try {
        await transaction.query("BEGIN");
        await transaction.query("INSERT INTO fixture_intent VALUES ('rolled-back')");
        assert.equal((await producer.enqueue(queue.name, { intent: "rolled-back" }, {
          key: "rolled-back", transaction,
        })).status, "enqueued");
        assert.equal((await pool.query("SELECT count(*)::integer AS count FROM mint_jobs.job")).rows[0].count, 0);
        await transaction.query("ROLLBACK");
        assert.equal((await pool.query("SELECT count(*)::integer AS count FROM fixture_intent")).rows[0].count, 0);
        assert.equal((await pool.query("SELECT count(*)::integer AS count FROM mint_jobs.job")).rows[0].count, 0);
        await transaction.query("BEGIN");
        await transaction.query("INSERT INTO fixture_intent VALUES ('committed')");
        assert.equal((await producer.enqueue(queue.name, { intent: "committed" }, {
          key: "committed", transaction,
        })).status, "enqueued");
        await transaction.query("COMMIT");
        assert.equal((await pool.query("SELECT count(*)::integer AS count FROM fixture_intent")).rows[0].count, 1);
        assert.equal((await pool.query("SELECT count(*)::integer AS count FROM mint_jobs.job")).rows[0].count, 1);
      } finally {
        transaction.release();
      }
    });

    await t.test("pending singleton keys deduplicate concurrent producers", async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => producer.enqueue(queue.name, { value: 1 }, { key: "same" })));
      assert.equal(results.filter((result) => result.status === "enqueued").length, 1);
      assert.equal(results.filter((result) => result.status === "duplicate").length, 9);
    });

    await t.test("invalid input is rejected and payload byte budget is exact", async () => {
      await assert.rejects(producer.enqueue("unknown", {}, { key: "key" }), /Unknown/);
      await assert.rejects(producer.enqueue(queue.name, {}, { key: "" }), /Job key/);
      await assert.rejects(producer.enqueue(queue.name, { bad: Infinity }, { key: "bad" }), /JSON values/);
      const overhead = Buffer.byteLength(JSON.stringify({ version: 1, payload: { text: "" } }));
      const exact = { text: "x".repeat(16_384 - overhead) };
      assert.equal((await producer.enqueue(queue.name, exact, { key: "exact" })).status, "enqueued");
      await assert.rejects(producer.enqueue(queue.name, { text: `${exact.text}x` }, { key: "too-big" }), /16384/);
    });

    await t.test("queued jobs survive stop/restart; handler failures retry and terminate", async () => {
      await producer.stop();
      await producer.stop();
      await assert.rejects(producer.enqueue(queue.name, {}, { key: "stopped" }), /stopping/);
      const attempts: number[] = [];
      const worker = await startLocalJobRuntime(pool, {
        ...options,
        queues: [{ ...queue, handle: async (job) => {
          assert.ok(job.signal instanceof AbortSignal);
          if (job.payload.retry) {
            attempts.push(job.attempt);
            if (job.attempt === 1) throw new Error("sensitive-handler-marker");
          }
          if (job.payload.fail) throw new Error("sensitive-handler-marker");
        } }],
      });
      runtimes.push(worker);
      await until(async () => (await pool.query(
        "SELECT count(*)::integer AS count FROM mint_jobs.job WHERE state <> 'completed'",
      )).rows[0].count === 0);
      assert.equal((await worker.enqueue(queue.name, {}, { key: "same" })).status, "enqueued");
      const retry = await worker.enqueue(queue.name, { retry: true }, { key: "retry" });
      assert.equal(retry.status, "enqueued");
      const failed = await worker.enqueue(queue.name, { fail: true }, { key: "fail" });
      assert.equal(failed.status, "enqueued");
      await until(async () => (await pool.query(
        "SELECT state FROM mint_jobs.job WHERE singleton_key = 'retry'",
      )).rows[0]?.state === "completed");
      assert.deepEqual(attempts, [1, 2]);
      await until(async () => (await pool.query(
        "SELECT state FROM mint_jobs.job WHERE singleton_key = 'fail'",
      )).rows[0]?.state === "failed");
      const failure = (await pool.query(
        "SELECT retry_count, output FROM mint_jobs.job WHERE singleton_key = 'fail'",
      )).rows[0];
      assert.equal(failure.retry_count, 2);
      assert.doesNotMatch(JSON.stringify(failure.output), /sensitive-handler-marker/);
      assert.equal(errors.filter((error) => error.name === "LocalJobHandlerError").length, 4);
      await worker.stop();
    });

    await t.test("a killed local worker's expired claim is retried by a replacement", async () => {
      const producer2 = await startLocalJobRuntime(pool, options);
      runtimes.push(producer2);
      const result = await producer2.enqueue(queue.name, { crash: true }, { key: "crash" });
      assert.equal(result.status, "enqueued");
      const source = `
        import pg from 'pg';
        import { startLocalJobRuntime } from ${JSON.stringify(new URL("../src/jobs.ts", import.meta.url).href)};
        const { config, options } = JSON.parse(process.env.MINT_JOB_FIXTURE);
        const pool = new pg.Pool(config);
        await startLocalJobRuntime(pool, { ...options, onError() {},
          queues: [{ ...options.queues[0], handle: async () => {
            process.send({ claimed: true });
            await new Promise(() => {});
          }}]
        });
      `;
      child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
        env: { ...env, MINT_JOB_FIXTURE: JSON.stringify({ config, options }) },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      await until(async () => {
        assert.equal(child!.exitCode, null, stderr);
        return (await pool.query("SELECT state FROM mint_jobs.job WHERE singleton_key = 'crash'")).rows[0]?.state === "active";
      });
      assert.equal((await producer2.enqueue(queue.name, { crash: true }, { key: "crash" })).status, "duplicate");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      child = undefined;
      let recoveredAttempt = 0;
      const replacement = await startLocalJobRuntime(pool, {
        ...options, queues: [{ ...queue, handle: async (job) => { recoveredAttempt = job.attempt; } }],
      });
      runtimes.push(replacement);
      await until(async () => (await pool.query(
        "SELECT state FROM mint_jobs.job WHERE singleton_key = 'crash'",
      )).rows[0]?.state === "completed");
      assert.equal(recoveredAttempt, 2);
      await replacement.stop();
      await producer2.stop();
    });

    await t.test("persisted policy mismatch fails closed and leaves the pool usable", async () => {
      await assert.rejects(startLocalJobRuntime(pool, {
        ...options, queues: [{ ...queue, retryLimit: 3 }],
      }), /configuration differs/);
      assert.equal((await pool.query("SELECT 1 AS ready")).rows[0].ready, 1);
    });
  } finally {
    if (child) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    try {
      await Promise.all(runtimes.map((runtime) => runtime.stop()));
    } finally {
      await pool.end();
      if (started) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { env });
      await rm(cluster, { recursive: true, force: true });
    }
  }
});
