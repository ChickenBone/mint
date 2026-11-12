import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/auth";
import { MusicError } from "@mint/core/music";
import { catalogCollectionRecordings } from "@/lib/music-requests";
import { rateLimit } from "@/lib/rate-limit";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/** Catalog songs for an artist or album page that are not playable from the library yet. */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return json({ error: "Approved membership required." }, 401);
  try {
    const id = z.string().trim().min(4).max(4000).parse(new URL(request.url).searchParams.get("id"));
    if (!(await rateLimit(`catalog-collection:${user.id}`, 20, 60))) return json({ error: "Wait a moment before browsing the music catalog again." }, 429);
    return json(await catalogCollectionRecordings(user.id, id, { signal: request.signal }));
  } catch (error) {
    if (request.signal.aborted) return json({ error: "Request cancelled." }, 499);
    if (error instanceof MusicError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: "Choose a valid artist or album." }, 400);
    console.error("Catalog collection lookup failed", error instanceof Error ? error.name : "Unknown failure");
    return json({ error: "The music catalog could not be reached. Try again." }, 503);
  }
}
