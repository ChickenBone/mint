import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@mint/core/db";
import { schema } from "@mint/core/db";
import { PLAYABLE } from "@mint/core/playback";
import { musicExclusions, musicHistory, musicLikes } from "@mint/core/music-db";
import { similarAnalyzedTracks } from "@mint/core/analysis-db";
import { MusicError } from "@mint/core/music";

export type DiscoveryMode = "for-you" | "recent" | "rediscover" | "radio" | "sonic";
export async function discoverMusic(db: Db, userId: string, mode: DiscoveryMode, seeds: string[] = [], limit = 50) {
  const excluded = db.select({ id: musicExclusions.trackId }).from(musicExclusions).where(eq(musicExclusions.userId, userId));
  const t = schema.tracks;
  const conditions = and(PLAYABLE, notInArray(t.id, excluded));
  if (mode === "sonic") {
    if (!seeds.length) throw new MusicError("Choose one or more analyzed seed songs first.");
    const matches = await similarAnalyzedTracks(db, seeds, limit * 3);
    if (!matches.length) return { items: [], explanation: "Sonic matches appear after Mint has measured audio for your seeds and other library songs." };
    const rows = await db.select().from(t).where(and(conditions, inArray(t.id, matches.map((m) => m.trackId))));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return { items: matches.flatMap((m) => byId.has(m.trackId) ? [{ track: byId.get(m.trackId)!, reason: m.reason }] : []).slice(0, limit),
      explanation: "Measured audio similarity only. No metadata is presented as sonic analysis." };
  }
  if (mode === "recent") {
    const rows = await db.select().from(t).where(conditions).orderBy(desc(t.createdAt), asc(t.id)).limit(limit);
    return { items: rows.map((track) => ({ track, reason: "Recently added to your playable library" })), explanation: "The latest playable additions. Nothing here triggers a download." };
  }
  if (mode === "rediscover") {
    const old = await db.select({ id: musicHistory.trackId, last: sql<Date>`max(${musicHistory.createdAt})` })
      .from(musicHistory).innerJoin(t, eq(t.id, musicHistory.trackId))
      .where(and(eq(musicHistory.userId, userId), conditions))
      .groupBy(musicHistory.trackId).having(sql`max(${musicHistory.createdAt}) < now() - interval '7 days'`)
      .orderBy(asc(sql`max(${musicHistory.createdAt})`), asc(musicHistory.trackId)).limit(limit);
    if (!old.length) return { items: [], explanation: "Rediscovery starts when a song in your listening history has rested for at least seven days." };
    const rows = await db.select().from(t).where(and(conditions, inArray(t.id, old.map((p) => p.id))));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { items: old.flatMap((p) => byId.has(p.id) ? [{ track: byId.get(p.id)!, reason: `Last played ${new Date(p.last).toISOString().slice(0, 10)}` }] : []).slice(0, limit),
      explanation: "Music you played before, ordered by how long it has been away." };
  }
  const plays = await db.select({ id: musicHistory.trackId, count: sql<number>`count(*)::int`, last: sql<Date>`max(${musicHistory.createdAt})` })
    .from(musicHistory).where(and(eq(musicHistory.userId, userId), notInArray(musicHistory.trackId, excluded)))
    .groupBy(musicHistory.trackId).orderBy(desc(sql`max(${musicHistory.createdAt})`)).limit(2000);
  const liked = await db.select({ id: musicLikes.trackId }).from(musicLikes).where(and(eq(musicLikes.userId, userId), notInArray(musicLikes.trackId, excluded))).orderBy(desc(musicLikes.createdAt)).limit(100);
  const seedIds = seeds.length ? seeds : [...new Set([...liked.map((r) => r.id), ...plays.slice(0, 30).map((r) => r.id)])].slice(0, 100);
  if (mode === "radio" && !seedIds.length) throw new MusicError("Choose a song, artist or several seeds to start a radio.");
  const seedTracks = seedIds.length ? await db.select().from(t).where(and(conditions, inArray(t.id, seedIds))) : [];
  const artists = new Set(seedTracks.map((r) => r.artist)), albums = new Set(seedTracks.filter((r) => r.album).map((r) => `${r.artist}\0${r.album}`));
  // Query related metadata first rather than loading an arbitrary recent slice of a large library.
  const related = artists.size ? await db.select().from(t).where(and(conditions, inArray(t.artist, [...artists]), notInArray(t.id, seedIds))).orderBy(asc(t.id)).limit(2000) : [];
  const fallback = await db.select().from(t).where(and(conditions, ...(seedIds.length ? [notInArray(t.id, seedIds)] : [])))
    .orderBy(desc(t.createdAt), asc(t.id)).limit(500);
  const counts = new Map(plays.map((p) => [p.id, p.count]));
  const day = new Date().toISOString().slice(0, 10);
  const hash = (id: string) => { let n = 0; for (const c of `${day}${userId}${id}`) n = (Math.imul(n, 31) + c.charCodeAt(0)) | 0; return n >>> 0; };
  const rows = [...new Map([...related, ...fallback].map((r) => [r.id, r])).values()].map((track) => {
    const sameArtist = artists.has(track.artist), sameAlbum = albums.has(`${track.artist}\0${track.album}`);
    const unheard = !counts.has(track.id);
    return { track, score: (sameArtist ? 4 : 0) + (sameAlbum ? 2 : 0) + (unheard ? 1 : 0),
      reason: sameAlbum ? `From the same seed album by ${track.artist}` : sameArtist ? `More ${track.artist}, from your ${seeds.length ? "seed selection" : "likes and listening history"}`
        : unheard ? "Not yet played in Mint — explore your library" : "A different corner of your playable library" };
  }).sort((a, b) => b.score - a.score || hash(a.track.id) - hash(b.track.id));
  return { items: rows.slice(0, limit), explanation: seedTracks.length
    ? "A daily library mix based on real artist and album matches, with unplayed songs mixed in. Not sonic similarity."
    : "Start with your playable library. Native likes and listening will personalize this shelf; imported YouTube likes stay separate." };
}
