import { CHANNEL, publish, toTrackView, type Stage } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { eq } from "drizzle-orm";
import { log } from "./log";

type TrackPatch = Partial<typeof schema.tracks.$inferInsert>;

const lastPublish = new Map<string, number>();

/** Updates a track, records stage transitions, and pushes a public-safe update to WebSocket clients. */
export async function updateTrack(trackId: string, patch: TrackPatch & { stage?: Stage }, message?: string) {
  const db = getDb();
  const prev = patch.stage
    ? await db.query.tracks.findFirst({ where: eq(schema.tracks.id, trackId), columns: { stage: true } })
    : null;
  const [row] = await db.update(schema.tracks).set(patch).where(eq(schema.tracks.id, trackId)).returning();
  if (!row) return null;

  const stageChanged = Boolean(patch.stage && prev && prev.stage !== patch.stage);
  if (stageChanged) {
    await db.insert(schema.trackEvents).values({ trackId, stage: patch.stage!, message: message ?? patch.detail ?? null });
    log.info({ trackId, stage: patch.stage, title: row.title }, message ?? "stage");
  }

  const now = Date.now();
  if (stageChanged || now - (lastPublish.get(trackId) ?? 0) > 1000) {
    lastPublish.set(trackId, now);
    if (row.stage === "ready" || row.stage === "failed") lastPublish.delete(trackId);
    await publish(getRedis(), CHANNEL.public, { type: "track", data: toTrackView(row) });
  }
  return row;
}

export function stage(trackId: string, s: Stage, detail: string | null = null, progress = 0) {
  return updateTrack(trackId, { stage: s, detail, progress, error: null }, detail ?? undefined);
}

export function progress(trackId: string, value: number, detail?: string) {
  return updateTrack(trackId, { progress: Math.max(0, Math.min(1, value)), ...(detail ? { detail } : {}) });
}
