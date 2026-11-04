import { getDb, schema } from "@mint/core/db";
import { PLAYABLE, UUID } from "@mint/core/playback";
import { getRedis } from "@mint/core/redis";
import { and, eq } from "drizzle-orm";
import { getUser } from "@/lib/auth";
import { fetchLyrics, LyricsBusyError } from "@/lib/lyrics-provider";
import { rateLimit } from "@/lib/rate-limit";
import { lyricMatches } from "@mint/core/listening-db";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200, retry?: number) => Response.json(body, { status, headers: {
  "cache-control": "private, no-store", ...(retry ? { "retry-after": String(retry) } : {}),
} });
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return json({ error: "Approved membership required" }, 401);
  const { id } = await context.params;
  if (!UUID.test(id)) return json({ error: "Invalid track" }, 400);
  try {
    if (!await rateLimit(`lyrics:${user.id}`, 30, 60)) return json({ error: "Too many lyrics requests. Try again in a minute." }, 429, 60);
    const track = await getDb().query.tracks.findFirst({ where: and(eq(schema.tracks.id, id), PLAYABLE) });
    if (!track) return json({ error: "This track is not available for playback." }, 404);
    const [match] = await getDb().select().from(lyricMatches).where(and(eq(lyricMatches.userId, user.id), eq(lyricMatches.trackId, id))).limit(1);
    if (match?.lyrics) return json({ lyrics: match.lyrics, offsetMs: match.offsetMs, source: "LRCLIB", corrected: true });
    const redis = getRedis(), cacheKey = `mint:lyrics:v1:${id}:${track.updatedAt.getTime()}`;
    const cached = await redis.get(cacheKey);
    if (cached) return json({ ...JSON.parse(cached), offsetMs: match?.offsetMs ?? 0 });
    const cooldown = await redis.ttl("mint:lyrics:cooldown");
    if (cooldown > 0) return json({ error: "LRCLIB is busy. Please wait before retrying." }, 429, cooldown);
    if (!await rateLimit("lyrics:provider", 60, 60)) return json({ error: "Lyrics lookups are busy. Try again in a minute." }, 429, 60);
    const lockKey = `${cacheKey}:lookup`, lock = crypto.randomUUID();
    if (!await redis.set(lockKey, lock, "EX", 15, "NX")) return json({ error: "This song's lyrics are already loading. Try again in a few seconds." }, 429, 3);
    try {
      const lyrics = await fetchLyrics({ artist: track.artist, title: track.title, album: track.album, duration: track.durationSec ?? track.existingDurationSec });
      const body = { lyrics, source: "LRCLIB" };
      await redis.set(cacheKey, JSON.stringify(body), "EX", lyrics ? 86400 : 3600);
      return json({ ...body, offsetMs: match?.offsetMs ?? 0 });
    } catch (error) {
      if (!(error instanceof LyricsBusyError)) throw error;
      await redis.set("mint:lyrics:cooldown", "1", "EX", error.retryAfter);
      return json({ error: error.message }, 429, error.retryAfter);
    } finally {
      await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, lock);
    }
  } catch (error) {
    console.error("Lyrics lookup failed", error instanceof Error ? error.message : "Unknown failure");
    return json({ error: "Lyrics are unavailable right now. Check your connection and try again." }, 503);
  }
}
