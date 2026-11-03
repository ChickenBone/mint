import { createHash } from "node:crypto";
import { CHANNEL, publish, toTrackView } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { log } from "../log";
import { findAlbumArtwork } from "../services/artwork";

const CURSOR = "mint:artwork:cursor";
const missingArt = () => or(isNull(schema.tracks.artworkUrl), eq(schema.tracks.artworkUrl, ""));
let active = false;

/** Bounded, album-level enrichment. Never opens media files or calls Plex. */
export async function backfillArtwork() {
  if (active) return;
  active = true;
  try {
    const redis = getRedis();
    const db = getDb();
    const tracks = schema.tracks;
    const raw = await redis.get(CURSOR);
    const cursor: { artist: string; album: string } | null = raw ? JSON.parse(raw) : null;
    const albums = await db.select({
      artist: tracks.artist,
      album: tracks.album,
      releaseGroupId: sql<string | null>`min(${tracks.mbReleaseGroupId})`,
    }).from(tracks)
      .where(and(
        missingArt(), ne(tracks.artist, ""), ne(tracks.album, ""),
        cursor ? or(gt(tracks.artist, cursor.artist), and(eq(tracks.artist, cursor.artist), gt(tracks.album, cursor.album))) : undefined,
      ))
      .groupBy(tracks.artist, tracks.album)
      .orderBy(asc(tracks.artist), asc(tracks.album))
      .limit(10);
    if (!albums.length) {
      await redis.del(CURSOR);
      return;
    }
    let updated = 0;
    for (const { artist, album, releaseGroupId } of albums) {
      if (!album) continue;
      const digest = createHash("sha256").update(JSON.stringify([artist, album, releaseGroupId])).digest("hex");
      const cacheKey = `mint:artwork:album:${digest}`;
      let url: string | null;
      try {
        const cached = await redis.get(cacheKey);
        if (cached !== null) {
          url = cached || null;
        } else {
          url = await findAlbumArtwork(artist, album, releaseGroupId);
          await redis.set(cacheKey, url ?? "", "EX", url ? 30 * 24 * 3600 : 24 * 3600);
        }
      } catch (err) {
        log.warn({ err, artist, album }, "album artwork lookup failed; leaving files and metadata unchanged, will retry on a later pass");
        await redis.set(CURSOR, JSON.stringify({ artist, album }));
        continue;
      }
      if (url) {
        const rows = await db.update(tracks).set({ artworkUrl: url, updatedAt: new Date() })
          .where(and(eq(tracks.artist, artist), eq(tracks.album, album), missingArt())).returning();
        updated += rows.length;
        for (const row of rows) await publish(redis, CHANNEL.public, { type: "track", data: toTrackView(row) });
      }
      await redis.set(CURSOR, JSON.stringify({ artist, album }));
    }
    if (updated) log.info({ albums: albums.length, tracks: updated }, "filled missing album artwork from MusicBrainz / Cover Art Archive");
  } finally {
    active = false;
  }
}
