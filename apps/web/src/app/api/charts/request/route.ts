import { NextResponse } from "next/server";
import { z } from "zod";
import { MusicError } from "@mint/core/music";
import { getDb, schema } from "@mint/core/db";
import { and, eq } from "drizzle-orm";
import { getUser } from "@/lib/auth";
import { chartAcquisition } from "@/lib/chart-service";
import { enqueueRequested } from "@/lib/queues";
import { rateLimit } from "@/lib/rate-limit";
import { boundedJson, publicUrl, RequestInputError } from "@/lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return json({ error: "Approved membership required. Public charts are browse-only." }, 401);
  if (request.headers.get("origin") !== new URL(publicUrl()).origin) return json({ error: "Request origin not allowed." }, 403);
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "Send a JSON request." }, 400);
    if (!await rateLimit(`music-request:${user.id}`, 30, 600) || !await rateLimit("recording-catalog", 1, 1))
      return json({ error: "Song requests are rate limited. Wait before trying again." }, 429);
    const input = z.object({ chart: z.string().max(100), entry: z.string().max(200),
      token: z.string().max(10000).optional(), youtubeUrl: z.string().max(2048).optional() }).parse(await boundedJson(request, 15000));
    const result = await chartAcquisition(user.id, input);
    if (result.status === "requested" && result.needsQueue) {
      try { await enqueueRequested(result.trackId, user.id); }
      catch (error) {
        await getDb().update(schema.tracks).set({ stage: "failed", detail: "Could not enqueue acquisition. Retry from Charts or Jobs." })
          .where(and(eq(schema.tracks.id, result.trackId), eq(schema.tracks.stage, "queued")));
        throw error;
      }
    }
    return json(result);
  } catch (error) {
    if (error instanceof MusicError || error instanceof RequestInputError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Invalid chart request or recording catalog response." }, 400);
    console.error("Chart acquisition failed", error);
    return json({ error: "Acquisition could not start. Check Jobs, then retry. Existing files are unchanged." }, 503);
  }
}
