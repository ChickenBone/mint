import { jobId, QUEUE, type AcquireJob } from "@mint/core";
import { createRedis } from "@mint/core/redis";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { removeJob } from "bullmq/dist/esm/scripts/removeJob-2.js";

// BullMQ's public remove API permits waiting jobs. Gate its own removal script atomically instead.
const removeFailed = `
  if not redis.call('ZSCORE', KEYS[3], ARGV[1]) then return -10 end
  if redis.call('HGET', KEYS[1], 'finishedOn') ~= ARGV[4]
    or (redis.call('HGET', KEYS[1], 'atm') or '0') ~= ARGV[5]
    or redis.call('HGET', KEYS[1], 'data') ~= ARGV[6] then return -11 end
  if redis.call('HGET', KEYS[1], 'parentKey')
    or redis.call('HGET', KEYS[1], 'rjk')
    or redis.call('EXISTS', KEYS[1] .. ':dependencies', KEYS[1] .. ':processed',
      KEYS[1] .. ':failed', KEYS[1] .. ':unsuccessful') > 0 then return -12 end
` + removeJob.content;

async function removeFailedRecord(queue: Queue<AcquireJob>, id: string, trackId: string) {
  const job = await queue.getJob(id);
  if (!job) return 0;
  if (job.data.trackId !== trackId) throw new Error("The worker job does not match this song. It was kept.");
  const state = await job.getState();
  if (state === "completed") return 0;
  if (state !== "failed" || job.finishedOn === undefined) {
    throw new Error("A matching worker job is no longer failed. It was kept; refresh and retry.");
  }
  const client = await queue.client;
  if (!(client instanceof Redis)) throw new Error("Failed-job cleanup requires Mint's configured ioredis connection.");
  const result = await client.eval(removeFailed, removeJob.keys + 1,
    queue.toKey(id), queue.toKey("repeat"), queue.toKey("failed"),
    id, "0", queue.toKey(""), String(job.finishedOn), String(job.attemptsMade), JSON.stringify(job.data));
  if (result !== 1) {
    throw new Error(result === -12 || result === -8
      ? "A matching worker job belongs to a parent/child flow or scheduler. It was kept."
      : "A matching worker job changed or is locked. It was kept; refresh and retry.");
  }
  return 1;
}

export async function removeFailedPipelineJobs(
  queues: { acquire: Queue<AcquireJob>; finalize: Queue<AcquireJob> }, trackId: string,
) {
  let removed = 0;
  removed += await removeFailedRecord(queues.acquire, jobId.acquire(trackId), trackId);
  removed += await removeFailedRecord(queues.finalize, jobId.finalize(trackId), trackId);
  return removed;
}

export async function withFailedPipelineCleanup<T>(action: (cleanup: (trackId: string) => Promise<number>) => Promise<T>) {
  const connection = createRedis({
    maxRetriesPerRequest: 1, commandTimeout: 5_000, connectTimeout: 5_000,
    enableOfflineQueue: false, retryStrategy: () => null,
  });
  const queues = {
    acquire: new Queue<AcquireJob>(QUEUE.acquire, { connection }),
    finalize: new Queue<AcquireJob>(QUEUE.finalize, { connection }),
  };
  const readinessTimeout = setTimeout(() => connection.disconnect(), 5_000);
  try {
    try {
      await Promise.all([queues.acquire.waitUntilReady(), queues.finalize.waitUntilReady()]);
    } catch (error) {
      throw new Error("Failed-job cleanup could not connect to Redis. No attempts were removed. Try again.", { cause: error });
    }
    clearTimeout(readinessTimeout);
    return await action((trackId) => removeFailedPipelineJobs(queues, trackId));
  } finally {
    clearTimeout(readinessTimeout);
    connection.disconnect();
    await Promise.all([queues.acquire.close(), queues.finalize.close()]);
  }
}
