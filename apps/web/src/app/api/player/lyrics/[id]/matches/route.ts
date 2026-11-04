import { getDb, schema } from "@mint/core/db";
import { lyricMatches } from "@mint/core/listening-db";
import { PLAYABLE } from "@mint/core/playback";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getUser } from "@/lib/auth";
import { boundedJson, publicUrl } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { fetchLyricsById, searchLyrics } from "@/lib/lyrics-provider";

type Context = { params: Promise<{ id: string }> };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
async function access(context: Context) {
  const user = await getUser(), { id } = await context.params;
  if (!user) return { error: json({ error: "Approved membership required" }, 401) };
  if (!z.uuid().safeParse(id).success) return { error: json({ error: "Invalid track" }, 400) };
  const [track] = await getDb().select({ id: schema.tracks.id }).from(schema.tracks).where(and(eq(schema.tracks.id, id), PLAYABLE)).limit(1);
  if (!track) return { error: json({ error: "Track unavailable" }, 404) };
  return { user, id };
}
export async function GET(request: Request, context: Context) {
  const actor = await access(context);
  if (actor.error) return actor.error;
  const query = z.string().trim().min(2).max(150).safeParse(new URL(request.url).searchParams.get("q"));
  if (!query.success) return json({ error: "Enter a title and artist (2–150 characters)" }, 400);
  if (!await rateLimit(`lyrics-match:${actor.user.id}`, 10, 60) || !await rateLimit("lyrics:provider", 60, 60)) return json({ error: "Too many searches. Wait one minute." }, 429);
  try { return json({ matches: await searchLyrics(query.data) }); }
  catch (error) { console.error("Lyric match search failed", error); return json({ error: "LRCLIB search is unavailable. Try again later." }, 503); }
}
export async function POST(request: Request, context: Context) {
  const actor = await access(context);
  if (actor.error) return actor.error;
  if (request.headers.get("origin") !== new URL(publicUrl()).origin) return json({ error: "Invalid request origin" }, 403);
  let body: unknown;
  try { body = await boundedJson(request, 4096); } catch { return json({ error: "Invalid JSON or correction exceeds its 4 KB limit" }, 400); }
  const input = z.object({ lyricsId: z.number().int().positive().optional(), offsetMs: z.number().int().min(-30_000).max(30_000).default(0), reset: z.boolean().default(false) }).safeParse(body);
  if (!input.success) return json({ error: "Invalid lyrics correction" }, 400);
  const where = and(eq(lyricMatches.userId, actor.user.id), eq(lyricMatches.trackId, actor.id));
  if (input.data.reset) { await getDb().delete(lyricMatches).where(where); return json({ saved: true }); }
  if (!await rateLimit(`lyrics-match:${actor.user.id}`, 10, 60)) return json({ error: "Too many corrections. Wait one minute." }, 429);
  try {
    const lyrics = input.data.lyricsId ? await fetchLyricsById(input.data.lyricsId) : undefined;
    if (input.data.lyricsId && !lyrics) return json({ error: "Those lyrics no longer exist. Search again." }, 404);
    await getDb().insert(lyricMatches).values({ userId: actor.user.id, trackId: actor.id, lyrics, offsetMs: input.data.offsetMs })
      .onConflictDoUpdate({ target: [lyricMatches.userId, lyricMatches.trackId], set: { ...(lyrics ? { lyrics } : {}), offsetMs: input.data.offsetMs, updatedAt: new Date() } });
    return json({ saved: true });
  } catch (error) { console.error("Lyric correction failed", error); return json({ error: "Lyrics could not be saved. Check the connection and retry." }, 503); }
}
