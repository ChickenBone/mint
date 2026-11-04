import "server-only";
import { QUEUE, jobId, type AcquireJob, type SyncJob } from "@mint/core";
import { createRedis } from "@mint/core/redis";
import { getDb, schema } from "@mint/core/db";
import { Queue } from "bullmq";
import { eq, sql } from "drizzle-orm";

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

export async function enqueueRequested(trackId: string, requestedBy: string) {
  const queue = queues().acquire, existing = await queue.getJob(jobId.acquire(trackId));
  if (existing) {
    const state = await existing.getState();
    if (state === "failed") {
      await existing.updateData({ trackId, requestedBy }); await existing.retry(); return;
    }
    if (state === "unknown") throw new Error("The acquisition job changed while queuing. Retry this request.");
    if (state !== "completed") return;
    await existing.remove();
  }
  await queue.add("acquire", { trackId, requestedBy }, { jobId: jobId.acquire(trackId), attempts: 3,
    backoff: { type: "exponential", delay: 30000 }, removeOnComplete: { age: 86400 }, removeOnFail: true });
}

export async function enqueueSync(userId: string, reason: SyncJob["reason"]) {
  await queues().sync.add(
    "sync",
    { userId, reason },
    { jobId: jobId.sync(userId), removeOnComplete: true, removeOnFail: true, attempts: 2, backoff: { type: "exponential", delay: 30_000 } },
  );
}

/** Clears any previous pipeline jobs for the track and starts acquisition again. */
export async function enqueueRetry(trackId: string, forceCobalt = false, requestedBy?: string) {
  const q = queues();
  requestedBy ??= (await q.acquire.getJob(jobId.acquire(trackId)))?.data.requestedBy;
  if (!requestedBy) {
    const [requester] = await getDb().select({ userId: schema.userTracks.userId }).from(schema.userTracks)
      .where(sql`${schema.userTracks.trackId} = ${trackId} and ${schema.userTracks.origin} = 'request'`).limit(1);
    requestedBy = requester?.userId;
  }
  // Drop any volunteer lease so a late upload for the old attempt is rejected by the hub.
  await getDb()
    .update(schema.tracks)
    .set({ remoteAt: null, leaseId: null, leaseWorkerId: null, leaseExpiresAt: null, remoteFailures: 0 })
    .where(eq(schema.tracks.id, trackId));
  await Promise.all([
    q.acquire.getJob(jobId.acquire(trackId)),
    q.finalize.getJob(jobId.finalize(trackId)),
    q.sonic.getJob(jobId.sonic(trackId)),
  ].map(async (pending) => { const job = await pending; if (job) await job.remove(); }));
  await q.acquire.add(
    "acquire",
    { trackId, forceCobalt, requestedBy },
    {
      jobId: jobId.acquire(trackId),
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 24 * 3600 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  );
}
