import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { jobId, type AcquireJob } from "@mint/core";
import { removeFailedPipelineJobs, withFailedPipelineCleanup } from "../src/lib/failed-pipeline-jobs";

test("unresponsive Redis fails within the command budget before starting database cleanup", async () => {
  const sockets = new Set<Socket>();
  const silent = createServer((socket) => sockets.add(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.REDIS_URL;
  process.env.REDIS_URL = `redis://127.0.0.1:${address.port}`;
  const started = Date.now();
  try {
    await assert.rejects(withFailedPipelineCleanup(async () => {
      assert.fail("Database cleanup must not start on an unresponsive connection");
    }), /could not connect to Redis/);
    assert.ok(Date.now() - started < 10_000);
  } finally {
    if (previous === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previous;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

const redis = process.env.MUSIC_TEST_REDIS_URL;
test("failed pipeline cleanup is atomic and confined to matching failed acquisition/finalization jobs", {
  skip: !redis && "Set MUSIC_TEST_REDIS_URL to a disposable Redis server",
}, async (suite) => {
  const url = new URL(redis!);
  const connection = new Redis({ host: url.hostname, port: Number(url.port), maxRetriesPerRequest: null });
  const prefix = `mint_failed_cleanup_${randomUUID()}`;
  const queues = {
    acquire: new Queue<AcquireJob>("acquire", { connection, prefix }),
    finalize: new Queue<AcquireJob>("finalize", { connection, prefix }),
  };
  const unrelated = new Queue<AcquireJob>("sonic", { connection, prefix });
  async function fail(queue: Queue<AcquireJob>, id: string, trackId: string) {
    await queue.add("fixture", { trackId }, { jobId: id, removeOnFail: false });
    const worker = new Worker<AcquireJob>(queue.name, undefined, { connection, prefix, autorun: false });
    try {
      const job = await worker.getNextJob("fixture-token", { block: false });
      assert.ok(job);
      await job.moveToFailed(new Error("Fixture failure"), "fixture-token", false);
      return job;
    } finally {
      await worker.close();
    }
  }
  try {
    await suite.test("the bounded production cleanup connection loads the packaged removal script", async () => {
      const previous = process.env.REDIS_URL;
      process.env.REDIS_URL = redis!;
      try {
        assert.equal(await withFailedPipelineCleanup((cleanup) => cleanup(randomUUID())), 0);
      } finally {
        if (previous === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previous;
      }
    });

    await suite.test("removes failed records, including logs, without touching analysis", async () => {
      const trackId = randomUUID();
      const failed = await fail(queues.acquire, jobId.acquire(trackId), trackId);
      await failed.log("Fixture log");
      await fail(queues.finalize, jobId.finalize(trackId), trackId);
      await fail(unrelated, jobId.sonic(trackId), trackId);
      assert.equal(await removeFailedPipelineJobs(queues, trackId), 2);
      assert.equal(await queues.acquire.getJob(jobId.acquire(trackId)), undefined);
      assert.equal(await queues.finalize.getJob(jobId.finalize(trackId)), undefined);
      const client = await queues.acquire.client;
      assert.ok(client instanceof Redis);
      assert.equal(await client.exists(queues.acquire.toKey(jobId.acquire(trackId)) + ":logs"), 0);
      assert.equal(await unrelated.getJobCountByTypes("failed"), 1);
    });

    await suite.test("waiting jobs and partial cleanup are retained for recovery", async () => {
      const trackId = randomUUID();
      await fail(queues.acquire, jobId.acquire(trackId), trackId);
      await queues.finalize.add("fixture", { trackId }, { jobId: jobId.finalize(trackId) });
      await assert.rejects(removeFailedPipelineJobs(queues, trackId), /no longer failed/);
      assert.equal(await queues.acquire.getJob(jobId.acquire(trackId)), undefined);
      assert.equal(await queues.finalize.getJobState(jobId.finalize(trackId)), "waiting");
      await queues.finalize.remove(jobId.finalize(trackId));
    });

    await suite.test("active jobs keep their locks and completed records are preserved", async () => {
      const trackId = randomUUID();
      await queues.acquire.add("fixture", { trackId }, { jobId: jobId.acquire(trackId) });
      const worker = new Worker<AcquireJob>(queues.acquire.name, undefined, { connection, prefix, autorun: false });
      try {
        const job = await worker.getNextJob("active-fixture-token", { block: false });
        assert.ok(job);
        await assert.rejects(removeFailedPipelineJobs(queues, trackId), /no longer failed/);
        assert.equal(await job.getState(), "active");
        await job.moveToCompleted("Fixture result", "active-fixture-token", false);
        assert.equal(await removeFailedPipelineJobs(queues, trackId), 0);
        assert.equal(await job.getState(), "completed");
      } finally {
        await worker.close();
      }
    });

    await suite.test("a retry between state inspection and Lua execution cannot be deleted", async () => {
      const trackId = randomUUID();
      const job = await fail(queues.acquire, jobId.acquire(trackId), trackId);
      const client = await queues.acquire.client;
      assert.ok(client instanceof Redis);
      const original = client.eval;
      Object.defineProperty(client, "eval", { configurable: true, writable: true,
        value: async (...args: Parameters<typeof client.eval>) => {
          await job.retry();
          return Reflect.apply(original, client, args);
        },
      });
      try {
        await assert.rejects(removeFailedPipelineJobs(queues, trackId), /changed or is locked/);
      } finally {
        client.eval = original;
      }
      assert.equal(await queues.acquire.getJobState(jobId.acquire(trackId)), "waiting");
      await queues.acquire.remove(jobId.acquire(trackId));
    });

    await suite.test("a replacement failure or changed track reference is fenced", async () => {
      const trackId = randomUUID();
      await fail(queues.acquire, jobId.acquire(trackId), trackId);
      const client = await queues.acquire.client;
      assert.ok(client instanceof Redis);
      const original = client.eval;
      Object.defineProperty(client, "eval", { configurable: true, writable: true,
        value: async (...args: Parameters<typeof client.eval>) => {
          await client.hincrby(queues.acquire.toKey(jobId.acquire(trackId)), "atm", 1);
          return Reflect.apply(original, client, args);
        },
      });
      try {
        await assert.rejects(removeFailedPipelineJobs(queues, trackId), /changed or is locked/);
      } finally {
        client.eval = original;
      }
      assert.equal(await queues.acquire.getJobState(jobId.acquire(trackId)), "failed");
      await client.hset(queues.acquire.toKey(jobId.acquire(trackId)), "data", JSON.stringify({ trackId: randomUUID() }));
      await assert.rejects(removeFailedPipelineJobs(queues, trackId), /does not match/);
      assert.equal(await queues.acquire.getJobState(jobId.acquire(trackId)), "failed");
    });

    await suite.test("parent/child jobs and Redis failures cannot delete source-managed records", async () => {
      const trackId = randomUUID();
      await fail(queues.acquire, jobId.acquire(trackId), trackId);
      const client = await queues.acquire.client, key = queues.acquire.toKey(jobId.acquire(trackId));
      assert.ok(client instanceof Redis);
      await client.hset(key, "parentKey", unrelated.toKey("parent-fixture"));
      await assert.rejects(removeFailedPipelineJobs(queues, trackId), /parent\/child/);
      assert.equal(await queues.acquire.getJobState(jobId.acquire(trackId)), "failed");
      await client.hdel(key, "parentKey");
      await client.sadd(key + ":dependencies", unrelated.toKey("child-fixture"));
      await assert.rejects(removeFailedPipelineJobs(queues, trackId), /parent\/child/);
      await client.del(key + ":dependencies");
      const original = client.eval;
      Object.defineProperty(client, "eval", { configurable: true, writable: true,
        value: async () => { throw new Error("Redis fixture unavailable"); },
      });
      try {
        await assert.rejects(removeFailedPipelineJobs(queues, trackId), /Redis fixture unavailable/);
      } finally {
        client.eval = original;
      }
      assert.equal(await queues.acquire.getJobState(jobId.acquire(trackId)), "failed");
      assert.equal(await removeFailedPipelineJobs(queues, trackId), 1);
    });
  } finally {
    await Promise.all([queues.acquire.obliterate({ force: true }), queues.finalize.obliterate({ force: true }),
      unrelated.obliterate({ force: true })]);
    await Promise.all([queues.acquire.close(), queues.finalize.close(), unrelated.close()]);
    await connection.quit();
  }
});
