import { getDb, schema } from "@mint/core/db";
import { analysisSchema, ANALYSIS_VERSION } from "@mint/core/analysis";
import { cancelAnalysis, enqueueAnalysis, trackAnalysis } from "@mint/core/analysis-db";
import { PLAYABLE, UUID } from "@mint/core/playback";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getUser } from "@/lib/auth";
import { analysisAdmin, analysisBody, analysisJson as json } from "@/lib/analysis-api";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const user = await getUser();
  if (!user) return json({ error: "Approved membership required" }, 401);
  const { id } = await context.params;
  if (!UUID.test(id)) return json({ error: "Invalid track" }, 400);
  try {
    const db = getDb();
    const track = await db.query.tracks.findFirst({ where: and(eq(schema.tracks.id, id), PLAYABLE), columns: { id: true } });
    if (!track) return json({ error: "Track unavailable" }, 404);
    const [row] = await db.select().from(trackAnalysis).where(eq(trackAnalysis.trackId, id));
    const parsed = analysisSchema.safeParse(row?.result);
    const current = row?.version === ANALYSIS_VERSION;
    const result = current && row.status === "complete" && parsed.success ? parsed.data : null;
    return json({
      status: current ? row.status : "missing",
      result, analysis: result,
      attempts: row?.attempts ?? 0,
      ...(row?.error ? { error: user.role === "admin" ? row.error : "Audio analysis is unavailable. An administrator can inspect diagnostics and retry." } : {}),
    });
  } catch (error) {
    console.error("Track analysis lookup failed", error instanceof Error ? error.message : "Unknown failure");
    return json({ error: "Audio analysis is unavailable. Playback can use fixed fades without it." }, 503);
  }
}

export async function POST(request: Request, context: Context) {
  const auth = await analysisAdmin(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  if (!UUID.test(id)) return json({ error: "Invalid track" }, 400);
  let input;
  try { input = z.object({ action: z.enum(["retry", "refresh", "cancel"]) }).strict().safeParse(await analysisBody(request)); }
  catch { return json({ error: "Invalid JSON request" }, 400); }
  if (!input.success) return json({ error: "Invalid analysis action" }, 400);
  try {
    if (!await rateLimit(`analysis-change:${auth.user.id}`, 60, 60)) return json({ error: "Too many analysis changes; wait one minute" }, 429);
    if (input.data.action === "cancel") return json({ cancelled: (await cancelAnalysis(getDb(), id)).length });
    return json({ queued: await enqueueAnalysis(getDb(), {
      trackId: id, requestedBy: auth.user.id, retryFailed: true, refresh: true,
    }) });
  } catch (error) {
    console.error("Analysis change failed", error instanceof Error ? error.message : "Unknown failure");
    return json({ error: "Analysis could not be changed. Check database and worker health." }, 503);
  }
}
