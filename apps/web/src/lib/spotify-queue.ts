import "server-only";
import { createRedis } from "@mint/core/redis";
import { SPOTIFY_QUEUE } from "@mint/core/spotify";
import { Queue } from "bullmq";
import { getDb } from "@mint/core/db";
import { spotifyAccounts } from "@mint/core/spotify-db";
import { and, eq, ne } from "drizzle-orm";

const g = globalThis as unknown as { __mintSpotifyQueue?: Queue<{ userId: string }> };
export async function enqueueSpotifySync(userId: string) {
  g.__mintSpotifyQueue ??= new Queue<{ userId: string }>(SPOTIFY_QUEUE, { connection: createRedis() });
  const db = getDb();
  await db.update(spotifyAccounts).set({ status: "queued", error: null }).where(and(eq(spotifyAccounts.userId, userId),
    ne(spotifyAccounts.status, "reconnect"), ne(spotifyAccounts.status, "rate_limited")));
  try { await g.__mintSpotifyQueue.add("sync", { userId }, { jobId: `spotify-${userId}`, removeOnComplete: true, removeOnFail: true }); }
  catch (error) {
    await db.update(spotifyAccounts).set({ status: "error", error: "Sync queue unavailable. Try Sync now when the worker is running." })
      .where(and(eq(spotifyAccounts.userId, userId), eq(spotifyAccounts.status, "queued")));
    throw error;
  }
}
