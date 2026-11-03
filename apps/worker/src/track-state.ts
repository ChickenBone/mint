import { applyTrackUpdate, type Stage, type TrackPatch } from "@mint/core";
import { getDb } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { log } from "./log";

/** Updates a track, records stage transitions, and pushes a public-safe update to WebSocket clients. */
export async function updateTrack(trackId: string, patch: TrackPatch, message?: string) {
  const { row, stageChanged } = await applyTrackUpdate(getDb(), getRedis(), trackId, patch, message);
  if (row && stageChanged) log.info({ trackId, stage: patch.stage, title: row.title }, message ?? "stage");
  return row;
}

export function stage(trackId: string, s: Stage, detail: string | null = null, progress = 0) {
  return updateTrack(trackId, { stage: s, detail, progress, error: null }, detail ?? undefined);
}

export function progress(trackId: string, value: number, detail?: string) {
  return updateTrack(trackId, { progress: Math.max(0, Math.min(1, value)), ...(detail ? { detail } : {}) });
}
