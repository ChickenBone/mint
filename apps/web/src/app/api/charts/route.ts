import { NextResponse } from "next/server";
import { z } from "zod";
import { MusicError } from "@mint/core/music";
import { getUser } from "@/lib/auth";
import { chartPage } from "@/lib/chart-service";
import { CHARTS } from "@/lib/charts";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(request: Request) {
  try {
    const user = await getUser();
    if (!await rateLimit(`charts:${user?.id ?? await clientIp()}`, 120, 60)) return json({ error: "Too many chart requests. Wait a minute before retrying." }, 429);
    const params = new URL(request.url).searchParams;
    if (!params.has("chart")) return json({ charts: CHARTS });
    const input = z.object({
      chart: z.string().min(1).max(100), offset: z.coerce.number().int().min(0).max(50).default(0),
      limit: z.coerce.number().int().min(1).max(25).default(25), revision: z.string().max(100).optional(),
    }).parse(Object.fromEntries(params));
    return json(await chartPage(input.chart, user?.id ?? null, input.offset, input.limit, input.revision));
  } catch (error) {
    if (error instanceof MusicError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: "Invalid chart or pagination parameters." }, 400);
    console.error("Chart API failed", error);
    return json({ error: "Charts could not load. Check the service connection and retry." }, 503);
  }
}
