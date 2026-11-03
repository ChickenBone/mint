import { getDb, schema } from "@mint/core/db";
import { PLAYABLE, UUID } from "@mint/core/playback";
import { toTrackView } from "@mint/core/views";
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import path from "node:path";
import { albumPlayerId as albumId, artistPlayerId as artistId } from "./player-protocol";

const t = schema.tracks;
export type PlayerItem = Record<string, unknown> & { ratingKey: string; key: string; title: string; type: string };
export class CatalogInputError extends Error {}

export function playerArtworkUrl(target: string, origin: string) {
  for (let depth = 0; depth < 3 && /^\/(?:listen\/api\/server\/)?photo\/:\/transcode\?/.test(target); depth++) {
    target = new URL(target, origin).searchParams.get("url") ?? "";
  }
  const image = new URL(target);
  const allowed = image.protocol === "https:" && (
    image.hostname === "coverartarchive.org" || image.hostname === "archive.org" || image.hostname.endsWith(".archive.org") ||
    image.hostname === "i.ytimg.com" || image.hostname.endsWith(".ggpht.com") || image.hostname.endsWith(".googleusercontent.com"));
  if ((!allowed && image.href !== `${origin}/listen/assets/cover.svg`) || image.username || image.password) throw new CatalogInputError("Unsupported artwork source");
  return image.href;
}

function trackItem(track: typeof t.$inferSelect, index: number): PlayerItem {
  const thumb = toTrackView(track).artworkUrl || undefined;
  return {
    ratingKey: track.id, key: `/library/metadata/${track.id}`, type: "track", title: track.title,
    grandparentTitle: track.artist, parentTitle: track.album ?? "Unknown album",
    grandparentRatingKey: artistId(track.artist), parentRatingKey: albumId(track.artist, track.album ?? ""),
    grandparentKey: `/library/metadata/${artistId(track.artist)}`,
    parentKey: `/library/metadata/${albumId(track.artist, track.album ?? "")}`,
    duration: (track.durationSec ?? track.existingDurationSec ?? 0) * 1000, index: index + 1,
    thumb, parentThumb: thumb,
    librarySectionID: 1, librarySectionTitle: "Mint music",
    guid: `mint://${track.id}`, addedAt: Math.floor((track.readyAt ?? track.createdAt).getTime() / 1000),
    Media: [{ id: track.id, audioCodec: track.codec ?? track.existingCodec, audioChannels: 2,
      Part: [{ id: track.id, key: `/listen/api/audio/${track.id}`, container: path.extname(track.filePath ?? track.existingFilePath ?? "").slice(1).toLowerCase() }] }],
  };
}

function identityFilter(id: string): SQL | undefined {
  if (id.length > 20_000) throw new CatalogInputError("Library selection is too large");
  if (UUID.test(id)) return eq(t.id, id);
  if (id.includes(",")) {
    const ids = id.split(",");
    if (ids.length > 500 || !ids.every((key) => UUID.test(key))) return undefined;
    return inArray(t.id, ids);
  }
  if (/^ar_[A-Za-z0-9_-]+$/.test(id)) return eq(t.artist, Buffer.from(id.slice(3), "base64url").toString("utf8"));
  if (id.startsWith("al_")) {
    let data: unknown;
    try { data = JSON.parse(Buffer.from(id.slice(3), "base64url").toString("utf8")); }
    catch { throw new CatalogInputError("Invalid album"); }
    if (!Array.isArray(data) || data.length !== 2 || data.some((v) => typeof v !== "string")) throw new CatalogInputError("Invalid album");
    const [artist, album] = data as [string, string];
    return and(eq(t.artist, artist), eq(sql`coalesce(${t.album}, '')`, album));
  }
  return undefined;
}

export async function catalogItems(opts: { type?: string; id?: string; q?: string; exactTitle?: string; artist?: string; start?: number; size?: number; userId: string; playlist?: string }) {
  const db = getDb();
  const conditions = [PLAYABLE];
  if (opts.id) {
    const condition = identityFilter(opts.id);
    if (!condition) throw new CatalogInputError("Invalid library item");
    conditions.push(condition);
  }
  if (opts.q) {
    const query = `%${opts.q.trim().slice(0, 100).replace(/[%_\\]/g, "\\$&")}%`;
    conditions.push(or(ilike(t.title, query), ilike(t.artist, query), ilike(t.album, query)));
  }
  if (opts.exactTitle) conditions.push(eq(opts.type === "8" ? t.artist : opts.type === "9" ? t.album : t.title, opts.exactTitle));
  if (opts.artist) {
    if (!opts.artist.startsWith("ar_")) throw new CatalogInputError("Invalid artist");
    const filter = identityFilter(opts.artist);
    if (!filter) throw new CatalogInputError("Invalid artist");
    conditions.push(filter);
  }
  if (opts.playlist === "liked") {
    conditions.push(inArray(t.id, db.select({ id: schema.userTracks.trackId }).from(schema.userTracks).where(eq(schema.userTracks.userId, opts.userId))));
  } else if (opts.playlist) {
    if (!UUID.test(opts.playlist)) throw new CatalogInputError("Invalid playlist");
    conditions.push(inArray(t.id, db.select({ id: schema.playlistTracks.trackId }).from(schema.playlistTracks)
      .innerJoin(schema.playlists, eq(schema.playlistTracks.playlistId, schema.playlists.id))
      .where(and(eq(schema.playlists.userId, opts.userId), eq(schema.playlists.id, opts.playlist)))));
  }
  const where = and(...conditions);
  if ((opts.start !== undefined && !Number.isSafeInteger(opts.start)) || (opts.size !== undefined && !Number.isSafeInteger(opts.size))) throw new CatalogInputError("Invalid pagination");
  const start = Math.max(0, Math.min(1_000_000, opts.start ?? 0));
  const size = Math.max(1, Math.min(500, opts.size ?? 100));
  if (opts.type === "8" || opts.type === "9") {
    const album = sql<string>`coalesce(${t.album}, '')`;
    const group = opts.type === "9" ? [t.artist, album] : [t.artist];
    const rows = await db.select({ artist: t.artist, album: opts.type === "9" ? album : sql<string>`''`,
      thumb: sql<string | null>`min(${t.artworkUrl})`, count: sql<number>`count(*)::int`,
      total: sql<number>`count(*) over()::int` }).from(t).where(where).groupBy(...group)
      .orderBy(asc(t.artist), ...(opts.type === "9" ? [asc(album)] : [])).limit(size).offset(start);
    const items: PlayerItem[] = rows.map((r) => {
      const id = opts.type === "9" ? albumId(r.artist, r.album) : artistId(r.artist);
      return { ratingKey: id, key: `/library/metadata/${id}/children`, title: opts.type === "9" ? r.album || "Unknown album" : r.artist,
        type: opts.type === "9" ? "album" : "artist", parentTitle: r.artist, thumb: r.thumb ?? undefined,
        librarySectionID: 1, leafCount: r.count };
    });
    return { items, total: rows[0]?.total ?? 0, start };
  }
  const ids = opts.id?.includes(",") ? opts.id.split(",") : null;
  const order = ids
    ? [asc(sql`array_position(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}], ${t.id})`)]
    : opts.playlist && opts.playlist !== "liked"
    ? [asc(sql`(select position from ${schema.playlistTracks} where ${schema.playlistTracks.playlistId} = ${opts.playlist} and ${schema.playlistTracks.trackId} = ${t.id})`)]
    : [asc(t.artist), asc(t.album), asc(t.title)];
  const [rows, count] = await Promise.all([
    db.select().from(t).where(where).orderBy(...order, asc(t.id)).limit(size).offset(start),
    db.select({ n: sql<number>`count(*)::int` }).from(t).where(where),
  ]);
  return { items: rows.map(trackItem), total: count[0]?.n ?? 0, start };
}

export function container(items: unknown[], extra: Record<string, unknown> = {}) {
  return { MediaContainer: { size: items.length, totalSize: items.length, identifier: "com.plexapp.plugins.library", Metadata: items, ...extra } };
}

export async function catalogResponse(path: string, params: URLSearchParams, userId: string) {
  if (/^\/library\/sections\/1\/(genre|style|mood|studio|folder)$/.test(path)) {
    return { MediaContainer: { size: 0, totalSize: 0, Directory: [] } };
  }
  const metadata = /^\/library\/metadata\/([^/]+)(?:\/(children|allLeaves))?$/.exec(path);
  const playlist = /^\/playlists\/(liked|[0-9a-f-]{36})(?:\/items)?$/.exec(path);
  if (metadata || path === "/library/sections/1/all" || path === "/search" || path === "/library/sections/1/search" || playlist) {
    if (params.get("type") === "18" || params.has("viewCount>")) return container([]);
    const id = metadata?.[1];
    const type = id?.startsWith("ar_") && metadata?.[2] !== "allLeaves" ? (metadata?.[2] ? "9" : "8")
      : id?.startsWith("al_") && !metadata?.[2] ? "9" : params.get("type") ?? "10";
    const result = await catalogItems({ id, type, q: params.get("query") ?? params.get("title") ?? undefined,
      exactTitle: params.get("title=") ?? undefined, artist: params.get("artist.id") ?? undefined,
      start: Number(params.get("X-Plex-Container-Start") ?? 0),
      size: Number(params.get("X-Plex-Container-Size") ?? 100), userId, playlist: playlist?.[1] });
    return container(result.items, { totalSize: result.total, offset: result.start,
      title1: "Mint music", title2: type === "8" ? "Artists" : type === "9" ? "Albums" : "Tracks",
      librarySectionID: 1, librarySectionTitle: "Mint music", viewGroup: type === "8" ? "artist" : type === "9" ? "album" : "track" });
  }
  if (path === "/playlists" || path === "/playlists/all") {
    const lists = await getDb().select().from(schema.playlists).where(eq(schema.playlists.userId, userId)).orderBy(desc(schema.playlists.updatedAt));
    return container([{ ratingKey: "liked", key: "/playlists/liked/items", title: "Liked songs", type: "playlist", playlistType: "audio", smart: false },
      ...lists.map((p) => ({ ratingKey: p.id, key: `/playlists/${p.id}/items`, title: p.title, type: "playlist", playlistType: "audio", smart: false }))]);
  }
  if (path === "/hubs" || /^\/hubs\/sections\/(?:library\/sections\/)?1$/.test(path) || path === "/hubs/search") {
    const q = path.startsWith("/hubs/search") ? params.get("query") ?? undefined : undefined;
    const [tracks, albums] = await Promise.all([
      catalogItems({ userId, q, size: 20 }), catalogItems({ userId, q, type: "9", size: 20 }),
    ]);
    return { MediaContainer: { size: 2, Hub: [
      { key: "/library/sections/1/all?type=10", title: "Your music", type: "track", hubIdentifier: "mint.tracks", size: tracks.items.length, more: tracks.total > 20, Metadata: tracks.items },
      { key: "/library/sections/1/all?type=9", title: "Albums", type: "album", hubIdentifier: "mint.albums", size: albums.items.length, more: albums.total > 20, Metadata: albums.items },
    ] } };
  }
  return null;
}
