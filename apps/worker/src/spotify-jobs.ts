import { getDb, schema } from "@mint/core/db";
import { spotifyAccounts, spotifyOauthStates } from "@mint/core/spotify-db";
import { SPOTIFY_QUEUE, spotifyConfigured } from "@mint/core/spotify";
import { syncSpotifyAccount } from "@mint/core/spotify-store";
import { Queue, Worker } from "bullmq";
import { and, eq, lte, ne } from "drizzle-orm";
import { connection } from "./queues";
import { log } from "./log";

export async function startSpotifyScheduler() {
  const queue = new Queue<{ userId?: string; scheduled?: boolean }>(SPOTIFY_QUEUE, { connection });
  const worker = new Worker<{ userId?: string; scheduled?: boolean }>(SPOTIFY_QUEUE, async (job) => {
    if (!spotifyConfigured()) return;
    const db = getDb();
    if (job.data.userId) {
      await syncSpotifyAccount(db, job.data.userId, { scheduled: job.data.scheduled });
      return;
    }
    await db.delete(spotifyOauthStates).where(lte(spotifyOauthStates.expiresAt, new Date()));
    const due = await db.select({ userId: spotifyAccounts.userId }).from(spotifyAccounts)
      .innerJoin(schema.users, eq(schema.users.id, spotifyAccounts.userId))
      .where(and(eq(schema.users.status, "active"), eq(spotifyAccounts.autoSync, true),
        ne(spotifyAccounts.status, "reconnect"), lte(spotifyAccounts.nextSyncAt, new Date()))).limit(100);
    for (const { userId } of due) {
      await queue.add("sync", { userId, scheduled: true }, { jobId: `spotify-${userId}`, removeOnComplete: true, removeOnFail: true });
    }
  }, { connection, concurrency: 1 });
  worker.on("error", (error) => log.error({ err: error }, "Spotify worker error"));
  worker.on("failed", (job) => log.warn({ jobId: job?.id }, "Spotify sync failed; see account/playlist status"));
  await queue.upsertJobScheduler("spotify-tick", { every: 60_000 }, { name: "tick", data: {} });
  return { close: async () => { await worker.close(); await queue.close(); } };
}
