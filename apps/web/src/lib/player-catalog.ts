import { getDb, schema } from "@mint/core/db";
import { PLAYABLE } from "@mint/core/playback";
import { toTrackView } from "@mint/core/views";
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { albumPlayerId, artistPlayerId, collectionSchema, trackPlayerItem, type CatalogPage, type PlayerCollection } from "./player-protocol";
import { albumArtwork } from "./artwork-query";
import { collectionDetail } from "./music-store";
import { MusicError } from "@mint/core/music";
import { catalogSearch } from "./catalog-search";
import { spotifyPlayablePage, spotifyQueueTrackSource } from "@mint/core/spotify-store";

const t = schema.tracks;
export class CatalogInputError extends Error {}

function collectionFilter(collection: PlayerCollection, userId: string): SQL | undefined {
  const db = getDb();
  switch (collection.kind) {
    case "spotify": throw new CatalogInputError("Use the Spotify playlist catalog.");
    case "library": return undefined;
    case "liked": return inArray(t.id, db.select({ id: schema.userTracks.trackId }).from(schema.userTracks).where(and(eq(schema.userTracks.userId, userId), eq(schema.userTracks.origin, "youtube"))));
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

function catalogWhere(collection: PlayerCollection, userId: string, q?: string) {
  const conditions = [PLAYABLE, collectionFilter(collection, userId)];
  if (collection.kind === "library" && collection.filters) {
    const { artist, album, codec, minYear, maxYear } = collection.filters;
    if (minYear !== undefined && maxYear !== undefined && minYear > maxYear) throw new CatalogInputError("The year range is reversed.");
    const contains = (value: string) => `%${value.trim().replace(/[%_\\]/g, "\\$&")}%`;
    if (artist?.trim()) conditions.push(ilike(t.artist, contains(artist)));
    if (album?.trim()) conditions.push(ilike(t.album, contains(album)));
    if (codec?.trim()) conditions.push(sql`lower(coalesce(${t.codec},${t.existingCodec},'')) = ${codec.trim().toLowerCase()}`);
    if (minYear !== undefined) conditions.push(sql`${t.year} >= ${minYear}`);
    if (maxYear !== undefined) conditions.push(sql`${t.year} <= ${maxYear}`);
  }
  conditions.push(catalogSearch(q ?? (collection.kind === "library" ? collection.query : undefined)).where);
  return and(...conditions);
}

function catalogOrder(collection: PlayerCollection, q?: string) {
  const rank = catalogSearch(q ?? (collection.kind === "library" ? collection.query : undefined)).rank;
  return collection.kind === "playlist"
    ? [asc(sql`(select position from ${schema.playlistTracks} where ${schema.playlistTracks.playlistId} = ${collection.id} and ${schema.playlistTracks.trackId} = ${t.id})`), asc(t.id)]
    : [...(rank ? [desc(rank)] : []), asc(t.artist), asc(t.album), asc(t.title), asc(t.id)];
}

export async function queueTrackSource(collection: PlayerCollection, userId: string): Promise<SQL> {
  if (collection.kind === "spotify") {
    const source = await spotifyQueueTrackSource(getDb(), userId, collection.id);
    if (!source) throw new MusicError("Spotify playlist not found or account disconnected.", 404);
    return source;
  }
  if (collection.kind === "playlist") {
    const [imported] = await getDb().select({ id: schema.playlists.id }).from(schema.playlists)
      .where(and(eq(schema.playlists.id, collection.id), eq(schema.playlists.userId, userId))).limit(1);
    if (!imported) {
      const detail = await collectionDetail(getDb(), userId, collection.id);
      const rows = detail.entries.filter(({ track }) => ["ready", "analyzing"].includes(track.stage) && (track.filePath || track.existingFilePath))
        .map(({ track, entryId }, position) => ({ track_id: track.id, source_occurrence_id: entryId, original_position: position }));
      return sql`select item.track_id::uuid as track_id, item.source_occurrence_id::uuid as source_occurrence_id, item.original_position
        from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as item(track_id text, source_occurrence_id text, original_position int)`;
    }
  }
  return sql`select ${t.id} as track_id, null::uuid as source_occurrence_id,
    (row_number() over(order by ${sql.join(catalogOrder(collection), sql`, `)}) - 1)::int as original_position
    from ${t} where ${catalogWhere(collection, userId)}`;
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
  if (collection.kind === "spotify") {
    const page = await spotifyPlayablePage(db, opts.userId, collection.id, { offset: start, limit: size });
    if (!page) throw new MusicError("Spotify playlist not found or account disconnected.", 404);
    const rows = page.items.length ? await db.select().from(t).where(and(PLAYABLE, inArray(t.id, page.items.map((item) => item.trackId)))) : [];
    const byId = new Map(rows.map((track) => [track.id, track]));
    return { title: page.title, start, total: page.total, items: page.items.flatMap((item) => {
      const track = byId.get(item.trackId);
      return track ? [{ ...trackPlayerItem(toTrackView(track)), occurrenceId: item.occurrenceId, duration: (track.durationSec ?? track.existingDurationSec ?? 0) * 1000 }] : [];
    }) };
  }
  if (collection.kind === "playlist") {
    const [playlist] = await db.select({ title: schema.playlists.title }).from(schema.playlists)
      .where(and(eq(schema.playlists.userId, opts.userId), eq(schema.playlists.id, collection.id))).limit(1);
    if (!playlist) {
      try {
        const native = await collectionDetail(db, opts.userId, collection.id);
        const query = opts.q?.trim().toLowerCase();
        const rows = native.entries.filter(({ track }) => ["ready", "analyzing"].includes(track.stage) && (track.filePath || track.existingFilePath)
          && (!query || `${track.title} ${track.artist} ${track.album ?? ""}`.toLowerCase().includes(query)));
        return { items: rows.slice(start, start + size).map(({ track, entryId }) => ({
          ...trackPlayerItem(toTrackView(track)), occurrenceId: entryId, duration: (track.durationSec ?? track.existingDurationSec ?? 0) * 1000,
        })),
          total: rows.length, start, title: native.title };
      } catch (error) {
        if (error instanceof MusicError && error.status === 404) return { items: [], total: 0, start };
        throw error;
      }
    }
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
  const q = opts.q ?? (collection.kind === "library" ? collection.query : undefined);
  const where = catalogWhere(collection, opts.userId, q);
  if (opts.type === "artist" || opts.type === "album") {
    const album = sql<string>`coalesce(${t.album}, '')`;
    const group = opts.type === "album" ? [t.artist, album] : [t.artist];
    const selection = db.select({ artist: t.artist, album: opts.type === "album" ? album : sql<string>`''`,
      thumb: albumArtwork }).from(t).where(where).groupBy(...group);
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
  const order = catalogOrder(collection, q);
  const [rows, count] = await Promise.all([
    db.select().from(t).where(where).orderBy(...order, asc(t.id)).limit(size).offset(start),
    db.select({ n: sql<number>`count(*)::int` }).from(t).where(where),
  ]);
  return { items: rows.map((track) => ({
    ...trackPlayerItem(toTrackView(track)), duration: (track.durationSec ?? track.existingDurationSec ?? 0) * 1000,
  })), total: count[0]?.n ?? 0, start };
}
