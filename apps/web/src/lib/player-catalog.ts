import { getDb, schema } from "@mint/core/db";
import { PLAYABLE } from "@mint/core/playback";
import { toTrackView } from "@mint/core/views";
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { albumPlayerId, artistPlayerId, collectionSchema, trackPlayerItem, type CatalogPage, type PlayerCollection } from "./player-protocol";
import { trackArtwork } from "./artwork-query";

const t = schema.tracks;
export class CatalogInputError extends Error {}

function collectionFilter(collection: PlayerCollection, userId: string): SQL | undefined {
  const db = getDb();
  switch (collection.kind) {
    case "library": return undefined;
    case "liked": return inArray(t.id, db.select({ id: schema.userTracks.trackId }).from(schema.userTracks).where(eq(schema.userTracks.userId, userId)));
    case "playlist": return inArray(t.id, db.select({ id: schema.playlistTracks.trackId }).from(schema.playlistTracks)
      .innerJoin(schema.playlists, eq(schema.playlistTracks.playlistId, schema.playlists.id))
      .where(and(eq(schema.playlists.userId, userId), eq(schema.playlists.id, collection.id))));
    case "artist": {
      const artist = Buffer.from(collection.id.slice(3), "base64url").toString("utf8");
      if (artistPlayerId(artist) !== collection.id) throw new CatalogInputError("Invalid artist");
      return eq(t.artist, artist);
    }
    case "album": {
      let data: unknown;
      try { data = JSON.parse(Buffer.from(collection.id.slice(3), "base64url").toString("utf8")); }
      catch { throw new CatalogInputError("Invalid album"); }
      if (!Array.isArray(data) || data.length !== 2 || typeof data[0] !== "string" || typeof data[1] !== "string" ||
          albumPlayerId(data[0], data[1]) !== collection.id) throw new CatalogInputError("Invalid album");
      return and(eq(t.artist, data[0]), eq(sql`coalesce(${t.album}, '')`, data[1]));
    }
  }
}

export async function catalogItems(opts: {
  type?: "track" | "album" | "artist" | "playlist"; collection?: PlayerCollection; q?: string;
  start?: number; size?: number; userId: string;
}): Promise<CatalogPage> {
  const db = getDb();
  const parsed = collectionSchema.safeParse(opts.collection ?? { kind: "library" });
  if (!parsed.success) throw new CatalogInputError("Invalid collection");
  const collection = parsed.data;
  let title: string | undefined;
  const start = opts.start ?? 0, size = opts.size ?? 100;
  if (!Number.isSafeInteger(start) || start < 0 || start > 1_000_000 ||
      !Number.isSafeInteger(size) || size < 1 || size > 500) throw new CatalogInputError("Invalid pagination");
  if (collection.kind === "playlist") {
    const [playlist] = await db.select({ title: schema.playlists.title }).from(schema.playlists)
      .where(and(eq(schema.playlists.userId, opts.userId), eq(schema.playlists.id, collection.id))).limit(1);
    if (!playlist) return { items: [], total: 0, start };
    title = playlist.title;
  }
  if (opts.type === "playlist") {
    const where = eq(schema.playlists.userId, opts.userId);
    const [rows, count] = await Promise.all([
      db.select().from(schema.playlists).where(where).orderBy(desc(schema.playlists.updatedAt), asc(schema.playlists.id)).limit(size).offset(start),
      db.select({ n: sql<number>`count(*)::int` }).from(schema.playlists).where(where),
    ]);
    return { items: rows.map((p) => ({ id: p.id, title: p.title, type: "playlist", thumb: p.artworkUrl ?? undefined })), total: count[0]?.n ?? 0, start };
  }
  const conditions = [PLAYABLE, collectionFilter(collection, opts.userId)];
  const q = opts.q ?? (collection.kind === "library" ? collection.query : undefined);
  if (q?.trim()) {
    const query = `%${q.trim().slice(0, 100).replace(/[%_\\]/g, "\\$&")}%`;
    conditions.push(or(ilike(t.title, query), ilike(t.artist, query), ilike(t.album, query)));
  }
  const where = and(...conditions);
  if (opts.type === "artist" || opts.type === "album") {
    const album = sql<string>`coalesce(${t.album}, '')`;
    const group = opts.type === "album" ? [t.artist, album] : [t.artist];
    const selection = db.select({ artist: t.artist, album: opts.type === "album" ? album : sql<string>`''`,
      thumb: sql<string | null>`min(${trackArtwork})` }).from(t).where(where).groupBy(...group);
    const [rows, count] = await Promise.all([
      selection.orderBy(asc(t.artist), ...(opts.type === "album" ? [asc(album)] : [])).limit(size).offset(start),
      db.select({ n: opts.type === "album" ? sql<number>`count(distinct (${t.artist}, coalesce(${t.album}, '')))::int`
        : sql<number>`count(distinct ${t.artist})::int` }).from(t).where(where),
    ]);
    return { items: rows.map((r) => ({
      id: opts.type === "album" ? albumPlayerId(r.artist, r.album) : artistPlayerId(r.artist),
      title: opts.type === "album" ? r.album || "Unknown album" : r.artist, type: opts.type === "album" ? "album" : "artist",
      artist: r.artist, artistId: artistPlayerId(r.artist), thumb: r.thumb ?? undefined,
    })), total: count[0]?.n ?? 0, start, title };
  }
  const order = collection.kind === "playlist"
    ? [asc(sql`(select position from ${schema.playlistTracks} where ${schema.playlistTracks.playlistId} = ${collection.id} and ${schema.playlistTracks.trackId} = ${t.id})`)]
    : [asc(t.artist), asc(t.album), asc(t.title)];
  const [rows, count] = await Promise.all([
    db.select().from(t).where(where).orderBy(...order, asc(t.id)).limit(size).offset(start),
    db.select({ n: sql<number>`count(*)::int` }).from(t).where(where),
  ]);
  return { items: rows.map((track) => ({
    ...trackPlayerItem(toTrackView(track)), duration: (track.durationSec ?? track.existingDurationSec ?? 0) * 1000,
  })), total: count[0]?.n ?? 0, start };
}
