import { and, eq, inArray, sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { ANALYSIS_VERSION, analysisDistance, analysisSchema, type AnalysisControls, type TrackAnalysis } from "../analysis";
import type { Db } from "./index";
import { tracks, users } from "./schema";
import { PLAYABLE } from "../playback";

export const trackAnalysis = pgTable("track_analysis", {
  trackId: uuid("track_id").primaryKey().references(() => tracks.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(ANALYSIS_VERSION),
  status: text("status", { enum: ["pending", "running", "complete", "failed", "cancelled"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  result: jsonb("result").$type<TrackAnalysis>(),
  error: text("error"),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("track_analysis_status_idx").on(t.status, t.updatedAt)]);

export const analysisSettings = pgTable("analysis_settings", {
  id: text("id").primaryKey().default("global"),
  controls: jsonb("controls").$type<AnalysisControls>().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const analysisWorkers = pgTable("analysis_workers", {
  id: text("id").primaryKey(),
  mode: text("mode", { enum: ["local", "remote"] }).notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  error: text("error"),
});

export async function enqueueAnalysis(db: Db, options: { trackId?: string; requestedBy?: string; retryFailed?: boolean; refresh?: boolean } = {}) {
  const rows = await db.execute(sql`
    insert into track_analysis (track_id, version, status, requested_by, updated_at)
    select t.id, ${ANALYSIS_VERSION}, 'pending', ${options.requestedBy ?? null}::uuid, now()
    from tracks t left join track_analysis a on a.track_id = t.id
    where t.stage in ('ready','analyzing') and (t.file_path is not null or t.existing_file_path is not null)
      ${options.trackId ? sql`and t.id = ${options.trackId}::uuid` : sql``}
      and (a.track_id is null or a.version <> ${ANALYSIS_VERSION}
        ${options.retryFailed ? sql`or a.status = 'failed'` : sql``}
        ${options.refresh ? sql`or a.status in ('complete','cancelled')` : sql``})
    order by t.id limit 500
    on conflict (track_id) do update set version = excluded.version, status = 'pending', error = null,
      attempts = 0, lease_id = null, lease_expires_at = null, updated_at = now(), requested_by = excluded.requested_by
    where track_analysis.status <> 'running'
    returning track_id`);
  return rows.rowCount ?? 0;
}

export async function cancelAnalysis(db: Db, trackId?: string) {
  return db.update(trackAnalysis).set({ status: "cancelled", leaseId: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(inArray(trackAnalysis.status, ["pending", "running"]), ...(trackId ? [eq(trackAnalysis.trackId, trackId)] : [])))
    .returning({ trackId: trackAnalysis.trackId });
}

export async function similarAnalyzedTracks(db: Db, seedTrackIds: string[], limit = 30) {
  const ids = [...new Set(seedTrackIds)].slice(0, 20);
  if (!ids.length) return [];
  const seedRows = await db.select({ result: trackAnalysis.result }).from(trackAnalysis)
    .where(and(inArray(trackAnalysis.trackId, ids), eq(trackAnalysis.status, "complete"), eq(trackAnalysis.version, ANALYSIS_VERSION)));
  const seeds = seedRows.map((row) => analysisSchema.safeParse(row.result))
    .flatMap((parsed) => parsed.success && parsed.data.similarity.confidence >= 0.1 ? [parsed.data] : []);
  if (!seeds.length) return [];
  // Keep the memory/CPU budget bounded even for very large libraries. Deterministic rotation
  // through the catalog is preferable to silently loading every waveform into web memory.
  const rows = await db.select({ trackId: trackAnalysis.trackId, result: trackAnalysis.result }).from(trackAnalysis)
    .innerJoin(tracks, eq(tracks.id, trackAnalysis.trackId))
    .where(and(eq(trackAnalysis.status, "complete"), eq(trackAnalysis.version, ANALYSIS_VERSION), PLAYABLE))
    .orderBy(sql`md5(${trackAnalysis.trackId}::text || ${ids.join(",")})`).limit(2000);
  return rows.flatMap((row) => {
    if (ids.includes(row.trackId)) return [];
    const parsed = analysisSchema.safeParse(row.result);
    if (!parsed.success || parsed.data.similarity.confidence < 0.1) return [];
    const distances = seeds.map((seed) => analysisDistance(seed, parsed.data)).filter((v): v is number => v !== null);
    if (!distances.length) return [];
    return [{ trackId: row.trackId, distance: Math.min(...distances), reason: "Similar measured timbre and energy" }];
  }).sort((a, b) => a.distance - b.distance || a.trackId.localeCompare(b.trackId)).slice(0, Math.min(100, Math.max(1, limit)));
}
