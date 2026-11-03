import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Db } from "./db";
import { tracks, trackEvents } from "./db/schema";
import { CHANNEL, publish } from "./events";
import type { Stage } from "./stages";
import { toTrackView } from "./views";

export type TrackPatch = Partial<typeof tracks.$inferInsert> & { stage?: Stage };

const lastPublish = new Map<string, number>();

/**
 * Updates a track, appends a track_event on stage transitions, and publishes a public-safe
 * update (throttled to ~1/s per track unless the stage changed).
 */
export async function applyTrackUpdate(db: Db, redis: Redis, trackId: string, patch: TrackPatch, message?: string) {
  const prev = patch.stage ? await db.query.tracks.findFirst({ where: eq(tracks.id, trackId), columns: { stage: true } }) : null;
  const [row] = await db.update(tracks).set(patch).where(eq(tracks.id, trackId)).returning();
  if (!row) return { row: null, stageChanged: false };

  const stageChanged = Boolean(patch.stage && prev && prev.stage !== patch.stage);
  if (stageChanged) {
    await db.insert(trackEvents).values({ trackId, stage: patch.stage!, message: message ?? patch.detail ?? null });
  }

  const now = Date.now();
  if (stageChanged || now - (lastPublish.get(trackId) ?? 0) > 1000) {
    lastPublish.set(trackId, now);
    if (row.stage === "ready" || row.stage === "failed") lastPublish.delete(trackId);
    await publish(redis, CHANNEL.public, { type: "track", data: toTrackView(row) });
  }
  return { row, stageChanged };
}
