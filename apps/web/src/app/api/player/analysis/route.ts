import { getDb, schema } from "@mint/core/db";
import { ANALYSIS_VERSION, DEFAULT_ANALYSIS_CONTROLS, analysisControlsSchema } from "@mint/core/analysis";
import { analysisBackfills, analysisSettings, analysisWorkers, cancelAnalysis, enqueueAnalysis, startAnalysisBackfill, trackAnalysis } from "@mint/core/analysis-db";
import { PLAYABLE } from "@mint/core/playback";
import { count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { analysisAdmin, analysisBody, analysisJson as json } from "@/lib/analysis-api";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export async function GET() {
  const auth = await analysisAdmin();
  if (auth.error) return auth.error;
  try {
    const db = getDb();
    const [states, [total], [settings], workers, recent, [backfill]] = await Promise.all([
      db.select({ status: trackAnalysis.status, count: count() }).from(trackAnalysis).groupBy(trackAnalysis.status),
      db.select({ count: count() }).from(schema.tracks).where(PLAYABLE),
      db.select().from(analysisSettings).where(eq(analysisSettings.id, "global")),
      db.select().from(analysisWorkers).where(sql`${analysisWorkers.seenAt} > now() - interval '24 hours'`).orderBy(desc(analysisWorkers.seenAt)).limit(20),
      db.select({ trackId: trackAnalysis.trackId, title: schema.tracks.title, artist: schema.tracks.artist,
        status: trackAnalysis.status, attempts: trackAnalysis.attempts, error: trackAnalysis.error, updatedAt: trackAnalysis.updatedAt,
        version: trackAnalysis.version }).from(trackAnalysis).innerJoin(schema.tracks, eq(schema.tracks.id, trackAnalysis.trackId))
        .orderBy(desc(trackAnalysis.updatedAt)).limit(50),
      db.select().from(analysisBackfills).where(eq(analysisBackfills.id, "global")),
    ]);
    const rawControls = settings?.controls && typeof settings.controls === "object" ? (settings.controls as Record<string, unknown>) : null;
    const parsedControls = analysisControlsSchema.safeParse(rawControls);
    const envRemoteOnly = process.env.ANALYSIS_REMOTE_ONLY === "true";
    const resolvedControls = parsedControls.success
      ? (!rawControls || !("executionMode" in rawControls)) && envRemoteOnly
        ? { ...parsedControls.data, executionMode: "remote-only" as const }
        : parsedControls.data
      : { ...DEFAULT_ANALYSIS_CONTROLS, executionMode: envRemoteOnly ? "remote-only" as const : DEFAULT_ANALYSIS_CONTROLS.executionMode };
    const statuses = Object.fromEntries(states.map((row) => [row.status, row.count]));
    const [[currentV2], [legacyV1]] = await Promise.all([
      db.select({ count: count() }).from(trackAnalysis)
        .innerJoin(schema.tracks, eq(schema.tracks.id, trackAnalysis.trackId))
        .where(sql`${PLAYABLE} and ${trackAnalysis.status} = 'complete' and ${trackAnalysis.version} = ${ANALYSIS_VERSION}`),
      db.select({ count: count() }).from(trackAnalysis)
        .innerJoin(schema.tracks, eq(schema.tracks.id, trackAnalysis.trackId))
        .where(sql`${PLAYABLE} and (
          (${trackAnalysis.status} = 'complete' and ${trackAnalysis.version} = 1)
          or (${trackAnalysis.status} in ('pending', 'running') and ${trackAnalysis.result} is not null and (${trackAnalysis.result}->>'version')::int = 1)
        )`),
    ]);
    const v2Covered = currentV2?.count ?? 0;
    const v1Covered = legacyV1?.count ?? 0;
    return json({
      version: ANALYSIS_VERSION,
      total: total?.count ?? 0,
      covered: v2Covered + v1Covered,
      v2Covered,
      v1Covered,
      statuses,
      controls: resolvedControls,
      workers: workers.map((worker) => ({ ...worker, online: Date.now() - worker.seenAt.getTime() < 60_000 })),
      recent, backfill: backfill ?? null, notes: [
        "Original media is read-only. Multi-rate 16 kHz DSP extracts EBU R128 loudness, LRA, crest factor, 12-band Bark energy, 13 MFCCs, HPCP key/Camelot, BPM beatgrids, MixRamp contours, and genre/mood classifications.",
        "Existing v1 measurements remain playable and usable for waveforms, normalization, and Smart Fades until upgraded to v2.",
        "Execution mode (remote-only, prefer-remote, or hybrid) takes effect within two seconds without editing .env or restarting containers.",
        "Failed/cancelled jobs require explicit retry. Interrupted leases resume automatically; completed files are re-fingerprinted weekly.",
        "Similarity uses 64-d audio embeddings across a deterministic sample of up to 2,000 analyzed candidates per seed set.",
      ],
    });
  } catch (error) {
    console.error("Analysis diagnostics failed", error instanceof Error ? error.message : "Unknown failure");
    return json({ error: "Analysis diagnostics unavailable. Apply the analysis migration and check database connectivity." }, 503);
  }
}

const change = z.discriminatedUnion("action", [
  z.object({ action: z.literal("settings"), controls: analysisControlsSchema }).strict(),
  z.object({ action: z.enum(["backfill", "retry-failed", "refresh", "cancel-all"]) }).strict(),
  z.object({ action: z.enum(["process-all", "upgrade-v1", "reprocess-all"]) }).strict(),
]);
export async function POST(request: Request) {
  const auth = await analysisAdmin(request);
  if (auth.error) return auth.error;
  let input;
  try { input = change.safeParse(await analysisBody(request)); }
  catch { return json({ error: "Invalid JSON request" }, 400); }
  if (!input.success) return json({ error: "Invalid analysis controls" }, 400);
  try {
    if (!await rateLimit(`analysis-admin:${auth.user.id}`, 30, 60)) return json({ error: "Too many analysis changes; wait one minute" }, 429);
    const db = getDb(), data = input.data;
    if (data.action === "settings") {
      await db.insert(analysisSettings).values({ id: "global", controls: data.controls, updatedBy: auth.user.id })
        .onConflictDoUpdate({ target: analysisSettings.id, set: { controls: data.controls, updatedBy: auth.user.id, updatedAt: new Date() } });
      return json({ controls: data.controls });
    }
    if (data.action === "cancel-all") return json({ cancelled: (await cancelAnalysis(db)).length });
    if (data.action === "process-all" || data.action === "upgrade-v1" || data.action === "reprocess-all") {
      const mode = data.action === "reprocess-all" ? "all" : data.action === "upgrade-v1" ? "upgrade-v1" : "missing";
      const backfill = await startAnalysisBackfill(db, mode, auth.user.id);
      if (!backfill) return json({ error: "A library scan is already queuing files. Wait for it to finish or cancel it first." }, 409);
      return json({ backfill }, 202);
    }
    return json({ queued: await enqueueAnalysis(db, {
      requestedBy: auth.user.id, retryFailed: data.action === "retry-failed", refresh: data.action === "refresh",
    }), batchLimit: 500 });
  } catch (error) {
    console.error("Analysis administration failed", error instanceof Error ? error.message : "Unknown failure");
    return json({ error: "Analysis change failed. Check migrations and worker/database health." }, 503);
  }
}
