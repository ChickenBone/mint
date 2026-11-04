import { getDb, schema } from "@mint/core/db";
import { ANALYSIS_VERSION, DEFAULT_ANALYSIS_CONTROLS, analysisControlsSchema } from "@mint/core/analysis";
import { analysisSettings, analysisWorkers, cancelAnalysis, enqueueAnalysis, trackAnalysis } from "@mint/core/analysis-db";
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
    const [states, [total], [settings], workers, recent] = await Promise.all([
      db.select({ status: trackAnalysis.status, count: count() }).from(trackAnalysis).groupBy(trackAnalysis.status),
      db.select({ count: count() }).from(schema.tracks).where(PLAYABLE),
      db.select().from(analysisSettings).where(eq(analysisSettings.id, "global")),
      db.select().from(analysisWorkers).where(sql`${analysisWorkers.seenAt} > now() - interval '24 hours'`).orderBy(desc(analysisWorkers.seenAt)).limit(20),
      db.select({ trackId: trackAnalysis.trackId, title: schema.tracks.title, artist: schema.tracks.artist,
        status: trackAnalysis.status, attempts: trackAnalysis.attempts, error: trackAnalysis.error, updatedAt: trackAnalysis.updatedAt,
        version: trackAnalysis.version }).from(trackAnalysis).innerJoin(schema.tracks, eq(schema.tracks.id, trackAnalysis.trackId))
        .orderBy(desc(trackAnalysis.updatedAt)).limit(50),
    ]);
    const controls = analysisControlsSchema.safeParse(settings?.controls);
    const statuses = Object.fromEntries(states.map((row) => [row.status, row.count]));
    const [current] = await db.select({ count: count() }).from(trackAnalysis)
      .innerJoin(schema.tracks, eq(schema.tracks.id, trackAnalysis.trackId))
      .where(sql`${PLAYABLE} and ${trackAnalysis.status} = 'complete' and ${trackAnalysis.version} = ${ANALYSIS_VERSION}`);
    return json({
      version: ANALYSIS_VERSION, total: total?.count ?? 0, covered: current?.count ?? 0, statuses,
      controls: controls.success ? controls.data : DEFAULT_ANALYSIS_CONTROLS,
      workers: workers.map((worker) => ({ ...worker, online: Date.now() - worker.seenAt.getTime() < 60_000 })),
      recent, notes: [
        "Original media is read-only. CPU-only measured audio descriptors are not neural embeddings.",
        "Failed/cancelled jobs require explicit retry. Interrupted leases resume automatically; completed files are re-fingerprinted weekly.",
        "Scheduling uses UTC. Pause stops active local analysis within two seconds; limits apply globally across workers.",
        "Plex sonic data is supplemental only when the existing Plex capability endpoint succeeds.",
        "Similarity uses a deterministic sample of up to 2,000 analyzed candidates per seed set to bound web memory and CPU.",
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
    return json({ queued: await enqueueAnalysis(db, {
      requestedBy: auth.user.id, retryFailed: data.action === "retry-failed", refresh: data.action === "refresh",
    }), batchLimit: 500 });
  } catch (error) {
    console.error("Analysis administration failed", error instanceof Error ? error.message : "Unknown failure");
    return json({ error: "Analysis change failed. Check migrations and worker/database health." }, 503);
  }
}
