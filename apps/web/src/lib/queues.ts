import "server-only";
import { QUEUE, jobId, type AcquireJob, type SyncJob } from "@mint/core";
import { createRedis } from "@mint/core/redis";
import { Queue } from "bullmq";

const g = globalThis as unknown as { __mintQueues?: ReturnType<typeof make> };

function make() {
  const connection = createRedis();
  return {
    sync: new Queue<SyncJob>(QUEUE.sync, { connection }),
    acquire: new Queue<AcquireJob>(QUEUE.acquire, { connection }),
    finalize: new Queue(QUEUE.finalize, { connection }),
    sonic: new Queue(QUEUE.sonic, { connection }),
  };
}

export function queues() {
  g.__mintQueues ??= make();
  return g.__mintQueues;
}

export async function enqueueSync(userId: string, reason: SyncJob["reason"]) {
  await queues().sync.add(
    "sync",
    { userId, reason },
    { jobId: jobId.sync(userId), removeOnComplete: true, removeOnFail: true, attempts: 2, backoff: { type: "exponential", delay: 30_000 } },
  );
}

/** Clears any previous pipeline jobs for the track and starts acquisition again. */
export async function enqueueRetry(trackId: string, forceCobalt = false) {
  const q = queues();
  await Promise.all([
    q.acquire.remove(jobId.acquire(trackId)),
    q.finalize.remove(jobId.finalize(trackId)),
    q.sonic.remove(jobId.sonic(trackId)),
  ]).catch(() => undefined);
  await q.acquire.add(
    "acquire",
    { trackId, forceCobalt },
    {
      jobId: jobId.acquire(trackId),
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 24 * 3600 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  );
}
