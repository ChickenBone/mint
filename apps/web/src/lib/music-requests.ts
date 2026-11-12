import { z } from "zod";
import { signToken, verifyToken } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { MusicError } from "@mint/core/music";
import { PLAYABLE, UUID as MBID } from "@mint/core/playback";
import type { Stage } from "@mint/core/stages";
import { audioSourceRejection, sameRecordingVersion, sourceSelectionMessage } from "@mint/core/matching";
import { youtubeScrapingAuthorized } from "@mint/core/youtube-scrape";
import { lookupCatalogEntity, searchCatalog, type CatalogEntity, type CatalogItem, type CatalogRequestOptions, type CatalogSearch } from "@mint/core/catalog-client";
import { albumPlayerId, artistPlayerId } from "./player-protocol";
import type { CatalogVideo } from "./request-match";
import { canonicalPublicUrl, getPublicReadCache, PublicProviderBusyError, publicCacheKey, publicRetryAfter,
  type PublicReadCache } from "@mint/core/public-cache";

const recording = z.object({
  id: z.uuid(), title: z.string().trim().min(1).max(1000), artist: z.string().trim().min(1).max(1000),
  album: z.string().max(1000).nullable(), durationSec: z.number().int().positive().nullable(),
  isrcs: z.array(z.string().max(100)).max(100).optional(),
});
export type RequestRecording = z.infer<typeof recording>;
/** External metadata and request authorization, not a player item or library ownership. */
export type RecordingSearchItem = RequestRecording & {
  token: string;
  existing: {
    id: string; recordingId: string | null; stage: Stage;
    error: string | null; detail: string | null; playable: boolean;
  } | null;
};
export interface CatalogArtist { id: string; name: string }
export interface CatalogCoverage {
  status: "ok" | "lexical-only" | "unavailable" | "not_configured"; mode: "hybrid" | "lexical" | null;
  relevance: "matched" | "related-only" | "empty"; hasMore: boolean; retryAfterSeconds: number | null;
}
export interface CatalogResultRow {
  key: string; source: string; kind: "song"; title: string; artist: string; album: string | null; genres: string[];
  popularity: { score: number; basis: "catalog-derived"; observedAt: string | null } | null;
  updatedAt: string | null; matched: boolean; recording: RecordingSearchItem;
}
/** `items` stays for older clients; `results` adds catalog provenance and `artists` are openable artist pages. */
export interface RecordingSearchResponse {
  items: RecordingSearchItem[]; results: CatalogResultRow[]; catalog: CatalogCoverage; artists: CatalogArtist[];
}
export interface CatalogCollectionAlbum {
  id: string; title: string; artist: string;
  /** Canonical MusicBrainz release-group ID, never inferred from the album name. */
  verifiedReleaseGroupId?: string;
}
/** `albums` are catalog albums without an explicitly identified playable library copy. */
export interface CatalogCollectionResponse { items: RecordingSearchItem[]; albums: CatalogCollectionAlbum[]; catalog: CatalogCoverage }
interface RecordingSearchOptions { signal?: AbortSignal; mirrorUrl?: string; cache?: boolean; cacheStore?: PublicReadCache }
const catalogResponse = z.object({
  error: z.never().optional(),
  recordings: z.array(z.object({
    id: z.uuid(), title: z.string().trim().min(1).max(1000),
    length: z.number().finite().nonnegative().nullish(),
    video: z.boolean().optional(), disambiguation: z.string().optional(),
    score: z.union([z.number().finite(), z.string().min(1).refine((value) => Number.isFinite(Number(value)))]).optional(),
    "artist-credit": z.array(z.object({ name: z.string().trim().min(1).max(1000) })).min(1).max(100),
    releases: z.array(z.object({ title: z.string().max(1000) })).max(100).optional(),
    isrcs: z.array(z.string().max(100)).max(100).optional(),
  })).max(10),
});
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const sameRecordingMetadata = (track: { title: string; artist: string; durationSec: number | null }, item: RequestRecording) =>
  normalize(track.title) === normalize(item.title) && normalize(track.artist) === normalize(item.artist) &&
  (!track.durationSec || !item.durationSec || Math.abs(track.durationSec - item.durationSec) <= 2.5);
export function youtubeSource(value?: string) {
  if (!value?.trim()) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new MusicError("Use a full YouTube video URL."); }
  if (url.protocol !== "https:" || url.port || url.username || url.password) throw new MusicError("Use a normal HTTPS YouTube video URL.");
  const id = url.hostname === "youtu.be" ? url.pathname.slice(1) : ["youtube.com", "www.youtube.com", "music.youtube.com"].includes(url.hostname) && url.pathname === "/watch" ? url.searchParams.get("v") : null;
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new MusicError("Use a YouTube video link, not a playlist or channel.");
  return id;
}
async function fetchRecordingMetadata(url: URL, fetcher: typeof fetch, signal: AbortSignal): Promise<RequestRecording[]> {
  signal.throwIfAborted();
  const response = await fetcher(url, {
    headers: { "user-agent": process.env.MUSICBRAINZ_USER_AGENT ?? "Mint/3.5 ( https://github.com/ChickenBone/mint )", accept: "application/json" },
    signal, redirect: "error",
  });
  if (signal.aborted) {
    await response.body?.cancel();
    signal.throwIfAborted();
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429 || response.status === 503 || response.headers.has("retry-after"))
      throw new PublicProviderBusyError("MusicBrainz", publicRetryAfter(response.headers.get("retry-after")));
    throw new MusicError(response.status === 429 || response.status === 503 ? "MusicBrainz is busy. Wait a few seconds and search again." : "The recording catalog could not be reached. Try again.", 503);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new MusicError("The recording catalog returned an empty response.", 503);
  const chunks: Uint8Array[] = []; let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) {
        await reader.cancel();
        throw new MusicError("The recording catalog response was too large.", 503);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const raw = catalogResponse.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  return raw.recordings.filter((item) => item.video !== true &&
    sameRecordingVersion(item.title, `${item.title} ${item.disambiguation ?? ""}`)).map((item) => recording.parse({
    id: item.id, title: item.title, artist: item["artist-credit"].map((credit) => credit.name).join(" / "),
    album: item.releases?.[0]?.title ?? null, durationSec: item.length ? Math.round(item.length / 1000) : null,
    isrcs: item.isrcs?.map((isrc) => isrc.replaceAll("-", "").toUpperCase()),
  }));
}

function mirrorRecordingUrl(publicUrl: URL, mirror: string): URL | null {
  if (!mirror || publicUrl.origin !== "https://musicbrainz.org" || publicUrl.pathname !== "/ws/2/recording") return null;
  try {
    const base = new URL(mirror);
    if (!["http:", "https:"].includes(base.protocol) || base.origin === publicUrl.origin ||
      base.username || base.password || base.search || base.hash || base.pathname.replace(/\/+$/, "") !== "/ws/2") return null;
    base.pathname = "/ws/2/recording";
    base.search = publicUrl.search;
    return base;
  } catch { return null; }
}

/** Cache only bounded public metadata; local status and account-bound tokens are always fresh. */
export async function searchRecordingMetadata(query: string, fetcher: typeof fetch = fetch, isrc?: string | null, options: RecordingSearchOptions = {}): Promise<RequestRecording[]> {
  query = z.string().trim().min(2).max(100).parse(query);
  options.signal?.throwIfAborted();
  const escaped = query.replace(/(["\\+\-!(){}[\]^~*?:/]|&&|\|\|)/g, "\\$1");
  const url = new URL("https://musicbrainz.org/ws/2/recording");
  const identifier = isrc?.replaceAll("-", "").toUpperCase();
  url.search = new URLSearchParams({ query: identifier && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(identifier) ? `isrc:${identifier}` : escaped, fmt: "json", limit: "10" }).toString();
  const mirror = options.mirrorUrl ?? process.env.MUSICBRAINZ_MIRROR_URL?.trim() ?? "";
  const mirrorUrl = mirrorRecordingUrl(url, mirror);
  const load = async (signal: AbortSignal): Promise<RequestRecording[]> => {
    if (mirrorUrl) {
      try {
        return await fetchRecordingMetadata(mirrorUrl, fetcher, AbortSignal.any([signal, AbortSignal.timeout(3000)]));
      } catch {
        signal.throwIfAborted();
        console.error("Recording catalog mirror unavailable or invalid; trying the public catalog");
      }
    }
    return fetchRecordingMetadata(url, fetcher, signal);
  };
  try {
    if (options.cache ?? (fetcher === fetch || !!options.cacheStore)) {
      const cached = await (options.cacheStore ?? getPublicReadCache()).read({
        provider: "MusicBrainz", key: publicCacheKey("MusicBrainz", "recording-search-audio-v2",
          [canonicalPublicUrl(url), mirrorUrl ? canonicalPublicUrl(mirrorUrl) : null]),
        freshSeconds: 3600, keepSeconds: 86400, negativeSeconds: 300, spacingSeconds: 2,
        maxBytes: 1_000_000, validate: (value) => z.array(recording).max(10).parse(value),
        negative: (value) => !value.length, signal: options.signal, timeoutMs: 10_000, load,
      });
      if (cached.stale) console.error("Recording catalog refresh unavailable; using validated cached public metadata", { ageSeconds: cached.ageSeconds });
      return cached.value;
    }
    const deadline = AbortSignal.timeout(10_000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const items = await load(signal);
    signal.throwIfAborted();
    return items;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof PublicProviderBusyError) throw new MusicError("MusicBrainz is busy. Wait before searching again.", 503);
    if (error instanceof MusicError) throw error;
    throw new MusicError("The recording catalog could not be reached or returned an invalid response. Try again.", 503);
  }
}

export async function searchRecordings(userId: string, query: string, fetcher: typeof fetch = fetch, isrc?: string | null, options: RecordingSearchOptions = {}): Promise<RecordingSearchItem[]> {
  return withRequestState(userId, await searchRecordingMetadata(query, fetcher, isrc, options), options);
}
async function withRequestState(userId: string, items: RequestRecording[], options: RecordingSearchOptions): Promise<RecordingSearchItem[]> {
  options.signal?.throwIfAborted();
  const existing = items.length ? await getDb().select({
    id: schema.tracks.id, recordingId: schema.tracks.mbRecordingId, stage: schema.tracks.stage,
    error: schema.tracks.error, detail: schema.tracks.detail, playable: sql<boolean>`(${PLAYABLE}) is true`,
    title: schema.tracks.title, artist: schema.tracks.artist, durationSec: schema.tracks.durationSec,
  }).from(schema.tracks).where(inArray(schema.tracks.mbRecordingId, items.map((item) => item.id))).limit(210) : [];
  options.signal?.throwIfAborted();
  return items.map((item) => {
    const matches = existing.filter((track) => track.recordingId === item.id && sameRecordingMetadata(track, item));
    const track = matches.find((entry) => entry.playable) ?? matches.find((entry) => entry.stage !== "failed") ?? matches[0];
    return { ...item, existing: track ? { id: track.id, recordingId: track.recordingId, stage: track.stage,
      error: track.error, detail: track.detail, playable: track.playable } : null,
      token: signToken("music-request", { userId, recording: item }, 15 * 60_000) };
  });
}
export function readRequestRecording(userId: string, token: string) {
  const raw = verifyToken<{ userId: string; recording: unknown }>("music-request", token);
  if (!raw || raw.userId !== userId) throw new MusicError("This search result expired. Search for the song again.", 400);
  return recording.parse(raw.recording);
}
export async function requestRecording(userId: string, token: string, source?: string, existingTrackId?: string,
  sourceReaderOrSearchRequestId?: ((userId: string, videoId: string) => Promise<CatalogVideo | null>) | string,
  sourceReaderOverride?: (userId: string, videoId: string) => Promise<CatalogVideo | null>) {
  const sourceReader = typeof sourceReaderOrSearchRequestId === "function" ? sourceReaderOrSearchRequestId :
    typeof sourceReaderOverride === "function" ? sourceReaderOverride :
    async (userId: string, videoId: string) => (await import("./youtube-search")).linkedYouTubeVideo(userId, videoId);
  const item = readRequestRecording(userId, token), videoId = youtubeSource(source);
  if (videoId) {
    const video = await sourceReader(userId, videoId);
    if (!video) throw new MusicError(youtubeScrapingAuthorized()
      ? "Pinned source metadata is unavailable. Choose an available audio URL."
      : "Pinned source metadata is unavailable. Link YouTube and choose an available audio URL.", 409);
    if (audioSourceRejection(item, video, "member")) throw new MusicError(`Pinned source rejected. ${sourceSelectionMessage(item, [video], "member")} No substitute was selected.`, 409);
  }
  return getDb().transaction(async (tx) => {
    if (videoId) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`video:${videoId}`}, 783))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${item.id}, 783))`);
    const candidates = await tx.select().from(schema.tracks).where(eq(schema.tracks.mbRecordingId, item.id)).orderBy(sql`case when ${schema.tracks.stage} in ('ready','analyzing') then 0 else 1 end`).limit(21).for("update");
    if (candidates.length > 1) throw new MusicError("Multiple library editions share this recording. Open Library and choose the exact edition; no new acquisition was started.", 409);
    let track = candidates[0];
    if (track && !sameRecordingMetadata(track, item)) throw new MusicError("The indexed recording has conflicting version or duration metadata. Check this edition in Library before requesting it.", 409);
    if (videoId && !track?.youtubeVideoId) {
      const [existing] = await tx.select().from(schema.tracks).where(eq(schema.tracks.youtubeVideoId, videoId)).limit(1).for("update");
      if (existing && existing.id !== track?.id) {
        if (existing.mbRecordingId && existing.mbRecordingId !== item.id ||
            !sameRecordingMetadata(existing, item)) {
          throw new MusicError("That video belongs to a different recording in Mint. Choose another video or request without a video link.");
        }
        if (track) throw new MusicError("This video is already used by another library entry. Request without a video link.");
        track = existing;
      }
    }
    if (track && existingTrackId && track.id !== existingTrackId) {
      await tx.delete(schema.tracks).where(and(eq(schema.tracks.id, existingTrackId), sql`${schema.tracks.filePath} is null`));
    }
    if (!track && existingTrackId) {
      const [placeholder] = await tx.select().from(schema.tracks).where(eq(schema.tracks.id, existingTrackId)).limit(1).for("update");
      if (placeholder && !placeholder.filePath && !["ready", "analyzing"].includes(placeholder.stage)) track = placeholder;
    }
    if (!track) [track] = await tx.insert(schema.tracks).values({ title: item.title, artist: item.artist, album: item.album,
      durationSec: item.durationSec, mbRecordingId: item.id, youtubeVideoId: videoId, detail: "Requested from search" }).returning();
    else if (existingTrackId && track.id === existingTrackId) {
      [track] = await tx.update(schema.tracks).set({
        title: item.title, artist: item.artist, album: item.album, durationSec: item.durationSec,
        mbRecordingId: item.id, youtubeVideoId: videoId ?? track.youtubeVideoId, stage: "queued", progress: 0, error: null, detail: "Matched. Queued for download.",
      }).where(eq(schema.tracks.id, track.id)).returning();
    }
    else if (!track.youtubeVideoId && videoId && !["ready", "analyzing"].includes(track.stage)) {
      [track] = await tx.update(schema.tracks).set({ youtubeVideoId: videoId }).where(eq(schema.tracks.id, track.id)).returning();
    }
    if (!track) throw new Error("The requested song was not stored.");
    if (track.stage === "failed") {
      [track] = await tx.update(schema.tracks).set({ stage: "queued", progress: 0, error: null, detail: "Requested again from search" }).where(eq(schema.tracks.id, track.id)).returning();
    }
    if (!track) throw new Error("The requested song could not be updated.");
    await tx.insert(schema.userTracks).values({ userId, trackId: track.id, origin: "request" }).onConflictDoNothing();
    return { trackId: track.id, stage: track.stage, needsQueue: track.stage === "queued" };
  });
}

/** Requestable MusicBrainz recordings from the catalog graph, or null when the graph cannot answer. */
export async function catalogRecordingMetadata(query: string, options: RecordingSearchOptions & { catalog?: CatalogRequestOptions } = {}): Promise<RequestRecording[] | null> {
  return (await catalogRecordingGroups(query, options))?.map((group) => group[0]!) ?? null;
}

export interface RecordingVersionCandidate {
  item: RequestRecording;
  artistKeys: string[];
  albums: CatalogAlbumCandidate[];
}
interface CatalogAlbumCandidate { key: string; title: string; artist: string; verifiedReleaseGroupId?: string }
function catalogAlbum(entity: CatalogEntity): CatalogAlbumCandidate {
  const verifiedReleaseGroupId = entity.source === "musicbrainz" && entity.kind === "album" && MBID.test(entity.providerId)
    ? entity.providerId.toLowerCase() : undefined;
  return { key: entity.key, title: entity.title, artist: entity.artist, ...(verifiedReleaseGroupId ? { verifiedReleaseGroupId } : {}) };
}
const CREDIT = /\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/giu;
const baseTitle = (title: string) => normalize(title.replace(CREDIT, ""));
const contains = (outer: string, inner: string) => !!inner && ` ${outer} `.includes(` ${inner} `);
function ownAlbums(candidate: RecordingVersionCandidate) {
  const artist = normalize(candidate.item.artist);
  const primary = normalize(candidate.item.artist.split(/\s+(?:feat\.?|ft\.?|featuring|with|&|x)\s+|,/iu)[0] ?? "");
  return candidate.albums.filter((album) => {
    const owner = normalize(album.artist);
    return owner !== "various artists" && (contains(artist, owner) || contains(owner, primary));
  });
}

/**
 * Group compatible cuts only with release-graph evidence, or matching duration and an identified artist when
 * album evidence is incomplete. Distinct recording IDs need matching durations; conflicting versions, lengths
 * and album editions must never be joined, even through an incomplete row.
 */
export function groupRecordingVersions(candidates: RecordingVersionCandidate[]): RequestRecording[][] {
  const byKey = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const artist = candidate.artistKeys.length ? ["keys", [...new Set(candidate.artistKeys)].sort()] :
      ["name", normalize(candidate.item.artist)];
    const key = JSON.stringify([artist, baseTitle(candidate.item.title)]);
    byKey.set(key, [...byKey.get(key) ?? [], index]);
  });
  const own = candidates.map(ownAlbums);
  const lengthsAgree = (a: number, b: number) => {
    const x = candidates[a]!.item.durationSec, y = candidates[b]!.item.durationSec;
    return !!x && !!y && Math.abs(x - y) <= 2.5;
  };
  const compatible = (a: number, b: number) => {
    const x = candidates[a]!.item, y = candidates[b]!.item;
    if (normalize(x.title) !== normalize(y.title) || normalize(x.artist) !== normalize(y.artist) ||
      !sameRecordingVersion(x.title, y.title) || (x.durationSec && y.durationSec && !lengthsAgree(a, b))) return false;
    if (x.id === y.id) return true;
    return lengthsAgree(a, b) && (!x.album || !y.album || normalize(x.album) === normalize(y.album)) &&
      (!own[a]!.length || !own[b]!.length ||
        own[a]!.some((album) => own[b]!.some((other) => other.key === album.key)));
  };
  const sameSong = (a: number, b: number) => {
    const x = candidates[a]!, y = candidates[b]!;
    if (x.item.id === y.item.id) return true;
    const bothOwn = own[a]!.length > 0 && own[b]!.length > 0;
    const left = bothOwn ? own[a]! : x.albums, right = bothOwn ? own[b]! : y.albums;
    if (left.some((album) => right.some((other) => other.key === album.key))) return true;
    return !bothOwn && (!x.albums.length || !y.albums.length) && x.artistKeys.length > 0 && lengthsAgree(a, b);
  };
  const groups: number[][] = [];
  for (const members of byKey.values()) {
    const related: number[][] = [];
    for (const index of [...members.filter((member) => own[member]!.length), ...members.filter((member) => !own[member]!.length)]) {
      const target = related.find((group) => group.every((member) => compatible(member, index)) &&
        group.some((member) => sameSong(member, index)));
      if (target) target.push(index); else related.push([index]);
    }
    groups.push(...related);
  }
  const fullAlbums = (index: number) => own[index]!.filter((album) => normalize(album.title) !== baseTitle(candidates[index]!.item.title));
  const strength = (index: number) => [fullAlbums(index).length ? 2 : own[index]!.length ? 1 : 0, own[index]!.length,
    candidates[index]!.item.durationSec ? 1 : 0, -index];
  const better = (a: number, b: number) => {
    const x = strength(a), y = strength(b);
    const difference = x.findIndex((value, position) => value !== y[position]);
    return difference < 0 ? 0 : y[difference]! - x[difference]!;
  };
  return groups.sort((a, b) => Math.min(...a) - Math.min(...b)).map((group) => group.sort(better).map((index) => {
    const candidate = candidates[index]!;
    const album = fullAlbums(index)[0] ?? own[index]![0];
    return { ...candidate.item, album: candidate.item.album || album?.title || null };
  }));
}

/** Catalog recordings grouped into songs, each group ordered from the canonical version to its alternatives. */
export async function catalogRecordingGroups(query: string, options: CatalogGroupOptions = {}): Promise<RequestRecording[][] | null> {
  return (await catalogRecordingSearch(query, options)).groups;
}

interface CatalogGroupOptions extends RecordingSearchOptions {
  catalog?: CatalogRequestOptions;
  /** Catalog rows to request (the service caps this at 50) and identified songs to look up. */
  searchLimit?: number; songLimit?: number; groupLimit?: number;
  accept?: (item: CatalogItem) => boolean;
  keep?: (candidate: RecordingVersionCandidate) => boolean;
  /** Collects the artist's own full albums (not singles) linked to kept songs, keyed by catalog album key. */
  albums?: Map<string, CatalogAlbumCandidate>;
}

async function catalogRecordingSearch(query: string, options: CatalogGroupOptions = {}): Promise<{ found: CatalogSearch; groups: RequestRecording[][] | null }> {
  const catalog = { ...options.catalog, signal: options.signal };
  const found = await searchCatalog(query, { ...catalog, kind: "song", limit: options.searchLimit ?? 30, timeoutMs: catalog.timeoutMs ?? 5_000 });
  if (found.status !== "ok" && found.status !== "lexical-only") return { found, groups: null };
  return { found, groups: await catalogGroups(found.items, options) };
}

async function catalogGroups(items: CatalogItem[], options: CatalogGroupOptions): Promise<RequestRecording[][]> {
  const catalog = { ...options.catalog, signal: options.signal };
  const seen = new Set<string>();
  const songs = items.filter((item) => item.musicBrainzRecordingId && item.artist && (options.accept?.(item) ?? true) &&
    !seen.has(item.musicBrainzRecordingId) && seen.add(item.musicBrainzRecordingId)).slice(0, options.songLimit ?? 20);
  const details = await Promise.all(songs.map(async (item) => {
    const detail = await lookupCatalogEntity(item.key, catalog).catch(() => null);
    return detail?.status === "ok" ? detail : null;
  }));
  const albumKeys = [...new Set(details.flatMap((detail) => detail?.albumKeys.slice(0, 8) ?? []))].slice(0, 60);
  const albums = new Map((await Promise.all(albumKeys.map(async (key) => {
    const detail = await lookupCatalogEntity(key, catalog).catch(() => null);
    return detail?.status === "ok" && detail.entity.kind === "album" && detail.entity.key === key
      ? [[key, catalogAlbum(detail.entity)] as const] : [];
  }))).flat());
  options.signal?.throwIfAborted();
  const candidates = songs.flatMap((item, index) => {
    const detail = details[index];
    const parsed = recording.safeParse({ id: item.musicBrainzRecordingId, title: item.title, artist: item.artist,
      album: item.album, durationSec: detail?.durationSec ?? null });
    return parsed.success ? [{ item: parsed.data, artistKeys: detail?.artistKeys ?? [],
      albums: (detail?.albumKeys ?? []).flatMap((key) => albums.get(key) ?? []) }] : [];
  }).filter((candidate) => options.keep?.(candidate) ?? true);
  if (options.albums) for (const candidate of candidates) for (const album of ownAlbums(candidate)) {
    if (normalize(album.title) !== baseTitle(candidate.item.title)) options.albums.set(album.key, album);
  }
  return groupRecordingVersions(candidates).slice(0, options.groupLimit ?? 10);
}

/** A version already in (or arriving in) the library outranks the canonical choice; a failed copy never does. */
function preferredVersion(group: RecordingSearchItem[]) {
  return group.find((item) => item.existing?.playable) ??
    group.find((item) => item.existing && item.existing.stage !== "failed") ??
    group.find((item) => item.existing?.stage !== "failed") ?? group[0]!;
}

/** The catalog graph answers search; public MusicBrainz is only a fallback, so its cooldown never blocks catalog results. */
export async function searchCatalogRecordings(userId: string, query: string, options: RecordingSearchOptions & { catalog?: CatalogRequestOptions; fetcher?: typeof fetch } = {}): Promise<RecordingSearchResponse> {
  const [{ found, groups }, artists] = await Promise.all([catalogRecordingSearch(query, options), catalogArtists(query, options)]);
  const coverage = catalogCoverage(found);
  if (groups?.length) {
    const flat = await withRequestState(userId, groups.flat(), options);
    let offset = 0;
    const items = groups.map((group) => preferredVersion(flat.slice(offset, offset += group.length)));
    const sources = found.status === "ok" || found.status === "lexical-only" ? found.items : [];
    return { items, artists, catalog: coverage, results: items.map((item) => catalogResult(item, sources)) };
  }
  try {
    const items = await searchRecordings(userId, query, options.fetcher ?? fetch, undefined, options);
    return { items, artists, results: items.map((item) => catalogResult(item, [])),
      catalog: { status: "ok", mode: null, relevance: items.length ? "matched" : "empty", hasMore: false, retryAfterSeconds: null } };
  } catch (error) {
    if (groups && error instanceof MusicError) return { items: [], results: [], artists, catalog: coverage };
    throw error;
  }
}

function catalogCoverage(found: CatalogSearch): CatalogCoverage {
  if (found.status === "ok" || found.status === "lexical-only") {
    return { status: found.status, mode: found.mode, relevance: found.relevance, hasMore: found.hasMore, retryAfterSeconds: null };
  }
  const retry = found.status === "unavailable" && found.retryAfterSeconds ? Math.min(60, Math.max(1, Math.ceil(found.retryAfterSeconds))) : null;
  return { status: found.status, mode: null, relevance: "empty", hasMore: false, retryAfterSeconds: retry };
}

function catalogResult(item: RecordingSearchItem, sources: CatalogItem[]): CatalogResultRow {
  const source = sources.find((candidate) => candidate.musicBrainzRecordingId === item.id);
  return {
    key: (source?.key ?? `musicbrainz:global:song:${item.id}`).slice(0, 150), source: source?.source ?? "musicbrainz", kind: "song",
    title: item.title, artist: item.artist, album: item.album, genres: (source?.genres ?? []).slice(0, 50),
    popularity: source?.popularity && source.popularity > 0
      ? { score: source.popularity, basis: "catalog-derived", observedAt: source.observedAt } : null,
    updatedAt: source?.updatedAt ?? null, matched: source?.matched ?? true, recording: item,
  };
}

/** Catalog artists matching the typed words, so artists not yet in the library can still be opened. Never fails search. */
async function catalogArtists(query: string, options: CatalogGroupOptions): Promise<CatalogArtist[]> {
  try {
    const found = await searchCatalog(query, { ...options.catalog, signal: options.signal, kind: "artist", limit: 12,
      timeoutMs: options.catalog?.timeoutMs ?? 3_000 });
    if (found.status !== "ok" && found.status !== "lexical-only") return [];
    const seen = new Set<string>();
    return found.items.filter((item) => item.kind === "artist" && item.matched && item.title.trim() &&
      !seen.has(normalize(item.title)) && seen.add(normalize(item.title)))
      .slice(0, 8).map((item) => ({ id: artistPlayerId(item.title.trim()), name: item.title.trim() }));
  } catch (error) {
    options.signal?.throwIfAborted();
    void error;
    return [];
  }
}

function decodeCollection(id: string): { artist: string; album: string | null } {
  try {
    if (id.startsWith("ar_")) {
      const artist = Buffer.from(id.slice(3), "base64url").toString("utf8");
      if (artist.trim() && artistPlayerId(artist) === id) return { artist, album: null };
    } else if (id.startsWith("al_")) {
      const data: unknown = JSON.parse(Buffer.from(id.slice(3), "base64url").toString("utf8"));
      if (Array.isArray(data) && data.length === 2 && typeof data[0] === "string" && typeof data[1] === "string" &&
          data[0].trim() && data[1].trim() && albumPlayerId(data[0], data[1]) === id) return { artist: data[0], album: data[1] };
    }
  } catch { /* reported below */ }
  throw new MusicError("Choose a valid artist or album.", 400);
}

/** Edition labels are part of an album title, not presentation noise. */
const albumTitleKey = (title: string) => normalize(title);

/** Songs linked to the matching catalog album(s) through graph edges, which text search over song titles cannot find. */
async function catalogAlbumSongs(artist: string, album: string, byArtist: (value: string) => boolean, options: CatalogGroupOptions,
  localReleaseGroupId?: string | null):
  Promise<{ found: CatalogSearch; items: CatalogItem[]; albumKeys: string[]; ambiguous: boolean }> {
  const catalog = { ...options.catalog, signal: options.signal };
  const found = await searchCatalog(`${album} ${artist}`, { ...catalog, kind: "album", limit: 10, timeoutMs: catalog.timeoutMs ?? 5_000 });
  if (found.status !== "ok" && found.status !== "lexical-only") return { found, items: [], albumKeys: [], ambiguous: false };
  if (localReleaseGroupId === null) return { found, items: [], albumKeys: [], ambiguous: true };
  const albumKey = albumTitleKey(album);
  const matches = found.items.filter((item) => item.kind === "album" && albumTitleKey(item.title) === albumKey &&
    item.artist && byArtist(item.artist) &&
    (localReleaseGroupId === undefined || catalogAlbum(item).verifiedReleaseGroupId === localReleaseGroupId));
  const identities = new Set(matches.map((item) => {
    const entry = catalogAlbum(item);
    return entry.verifiedReleaseGroupId ? `mb:${entry.verifiedReleaseGroupId}` : `catalog:${entry.key}`;
  }));
  if (identities.size > 1) return { found, items: [], albumKeys: [], ambiguous: true };
  const albums = matches.slice(0, 4);
  const albumKeys = albums.map((item) => item.key);
  const linked = await Promise.all(albums.map((item) => lookupCatalogEntity(item.key, catalog).catch(() => null)));
  const songKeys = [...new Set(linked.flatMap((detail) => detail?.status === "ok" ? detail.songKeys : []))].slice(0, 60);
  const songs = await mapLimited(songKeys, 6, async (key) => {
    const detail = await lookupCatalogEntity(key, catalog).catch(() => null);
    return detail?.status === "ok" && detail.entity.kind === "song" && detail.entity.key === key ? detail : null;
  });
  // Graph-only songs need a shared album edge, not just a similarly named identified recording.
  const items = await mapLimited(songs.filter((song) => song !== null).slice(0, 40), 4, async (detail): Promise<CatalogItem | null> => {
    const song = detail.entity;
    if (song.musicBrainzRecordingId) return { ...song, album: song.album ?? album, matched: true };
    const title = normalize(song.title);
    if (!title || !song.artist || !detail.albumKeys.length) return null;
    const match = await searchCatalog(`${song.title} ${song.artist || artist}`, { ...catalog, kind: "song", limit: 8, timeoutMs: catalog.timeoutMs ?? 5_000 })
      .catch(() => null);
    const candidates = match?.status === "ok" || match?.status === "lexical-only" ? match.items.filter((item) =>
      item.musicBrainzRecordingId && normalize(item.title) === title &&
      normalize(item.artist) === normalize(song.artist) && sameRecordingVersion(song.title, item.title)) : [];
    const choices = new Map(candidates.map((item) => [item.musicBrainzRecordingId, item]));
    if (choices.size > 2 || (match && (match.status === "ok" || match.status === "lexical-only") && match.hasMore)) return null;
    const resolved = await mapLimited([...choices.values()], 2, async (item) => {
      const hit = await lookupCatalogEntity(item.key, catalog).catch(() => null);
      return hit?.status === "ok" && hit.entity.key === item.key && hit.entity.musicBrainzRecordingId === item.musicBrainzRecordingId &&
        normalize(hit.entity.title) === title && normalize(hit.entity.artist) === normalize(song.artist) &&
        sameRecordingVersion(song.title, hit.entity.title) &&
        hit.albumKeys.some((key) => albumKeys.includes(key) && detail.albumKeys.includes(key)) &&
        detail.durationSec !== null && hit.durationSec !== null &&
        Math.abs(detail.durationSec - hit.durationSec) <= 2.5 ? item : null;
    });
    const distinct = new Map(resolved.filter((item) => item !== null).map((item) => [item.musicBrainzRecordingId, item]));
    const hit = distinct.size === 1 ? [...distinct.values()][0] : null;
    return hit ? { ...hit, album: hit.album ?? album, matched: true } : null;
  });
  options.signal?.throwIfAborted();
  return { found, items: items.filter((item) => item !== null), albumKeys, ambiguous: false };
}

async function mapLimited<T, R>(values: T[], limit: number, map: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await map(values[index]!); }
  }));
  return results;
}

/**
 * Catalog songs for an artist or album page that the library cannot play yet. Only compatible exact recording
 * links suppress playable library copies; an unrelated recording with the same title stays requestable.
 */
export async function catalogCollectionRecordings(userId: string, id: string, options: CatalogGroupOptions = {}): Promise<CatalogCollectionResponse> {
  const { artist, album } = decodeCollection(id);
  const artistKey = normalize(artist);
  const lead = normalize(artist.split(/\s+(?:feat\.?|ft\.?|featuring|with|&|x)\s+|,/iu)[0] ?? artist);
  const byArtist = (value: string) => contains(normalize(value), lead) || contains(artistKey, normalize(value));
  const limits = { searchLimit: 50, songLimit: 50, groupLimit: 50 };
  const linkedAlbums = new Map<string, CatalogAlbumCandidate>();
  const db = getDb();
  const owned = await db.select({ album: schema.tracks.album, releaseGroupId: schema.tracks.mbReleaseGroupId }).from(schema.tracks)
    .where(and(PLAYABLE, eq(schema.tracks.artist, artist), album ? eq(sql`coalesce(${schema.tracks.album}, '')`, album) : undefined)).limit(1000);
  let localReleaseGroupId: string | null | undefined;
  if (album && owned.length) {
    const { rows } = await db.execute<{ id: string }>(sql`
      select distinct lower(${schema.tracks.mbReleaseGroupId}) as id from ${schema.tracks}
      where ${schema.tracks.artist} = ${artist} and coalesce(${schema.tracks.album}, '') = ${album}
        and ${PLAYABLE} and ${schema.tracks.mbReleaseGroupId} is not null order by id limit 2`);
    localReleaseGroupId = rows.length === 1 && MBID.test(rows[0]!.id) ? rows[0]!.id : null;
  }
  options.signal?.throwIfAborted();
  let found: CatalogSearch;
  let groups: RequestRecording[][] | null = null;
  let albumKeys = new Set<string>(), ambiguousAlbum = false;
  if (album) {
    const linked = await catalogAlbumSongs(artist, album, byArtist, options, localReleaseGroupId);
    found = linked.found;
    albumKeys = new Set(linked.albumKeys);
    ambiguousAlbum = linked.ambiguous;
    if (linked.items.length) groups = await catalogGroups(linked.items, { ...options, ...limits });
  } else found = { status: "not_configured" };
  const [searched, searchedAlbums] = await Promise.all([
    groups?.length || (album && (ambiguousAlbum || !albumKeys.size)) ? null : catalogRecordingSearch(artist, {
      ...options, ...limits, albums: album ? undefined : linkedAlbums,
      accept: (item) => album ? byArtist(item.artist) : contains(normalize(item.artist), artistKey),
      keep: album ? (candidate) => candidate.albums.some((entry) => albumKeys.has(entry.key)) : undefined,
    }),
    album ? [] : catalogArtistAlbums(artist, byArtist, options),
  ]);
  if (searched) { found = searched.found; groups = searched.groups; }
  const catalog = catalogCoverage(found);
  const ownedAlbums = new Set(owned.flatMap((track) => track.releaseGroupId && MBID.test(track.releaseGroupId)
    ? [track.releaseGroupId.toLowerCase()] : []));
  const ownedTitles = new Set(owned.flatMap((track) => track.album ? [albumTitleKey(track.album)] : []));
  const candidates: CatalogAlbumCandidate[] = [];
  const seenAlbums = new Set<string>();
  for (const entry of [...linkedAlbums.values(), ...searchedAlbums]) {
    const key = entry.verifiedReleaseGroupId ? `mb:${entry.verifiedReleaseGroupId}` : `catalog:${entry.key}`;
    if (!albumTitleKey(entry.title) || seenAlbums.has(key) ||
      (entry.verifiedReleaseGroupId && ownedAlbums.has(entry.verifiedReleaseGroupId))) continue;
    seenAlbums.add(key);
    candidates.push(entry);
  }
  const nameCounts = new Map<string, number>();
  for (const entry of candidates) {
    const key = albumTitleKey(entry.title);
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  // Legacy album IDs encode only artist/title; ambiguous names cannot safely produce distinct destinations.
  const albums = candidates.filter((entry) => {
    const key = albumTitleKey(entry.title);
    return !ownedTitles.has(key) && nameCounts.get(key) === 1;
  }).slice(0, 50).map((entry) => ({ id: albumPlayerId(artist, entry.title), title: entry.title, artist,
    ...(entry.verifiedReleaseGroupId ? { verifiedReleaseGroupId: entry.verifiedReleaseGroupId } : {}) }));
  if (!groups?.length) return { items: [], albums, catalog };
  const flat = await withRequestState(userId, groups.flat(), options);
  let offset = 0;
  const preferred = groups.flatMap((group) => {
    const available = flat.slice(offset, offset += group.length).filter((item) => !item.existing?.playable);
    return available.length ? [preferredVersion(available)] : [];
  });
  const started = (item: RecordingSearchItem) => item.existing && item.existing.stage !== "failed" ? 0 : 1;
  const items = preferred.map((item, index) => ({ item, index }))
    .sort((a, b) => started(a.item) - started(b.item) || a.index - b.index).map(({ item }) => item);
  return { catalog, albums, items };
}

/** The artist's albums known to the catalog, matched by credited artist. Never fails the page. */
async function catalogArtistAlbums(artist: string, byArtist: (value: string) => boolean, options: CatalogGroupOptions) {
  try {
    const found = await searchCatalog(artist, { ...options.catalog, signal: options.signal, kind: "album", limit: 30,
      timeoutMs: options.catalog?.timeoutMs ?? 5_000 });
    if (found.status !== "ok" && found.status !== "lexical-only") return [];
    return found.items.filter((item) => item.kind === "album" && item.title.trim() && item.artist && byArtist(item.artist))
      .map(catalogAlbum);
  } catch (error) {
    options.signal?.throwIfAborted();
    void error;
    return [];
  }
}

export async function createSearchRequest(userId: string, query: string) {
  const clean = z.string().trim().min(2).max(100).parse(query);
  const db = getDb();
  const normalizedQuery = clean.trim().replace(/\s+/g, " ");
  const existing = await db.query.searchRequests.findFirst({
    where: and(eq(schema.searchRequests.userId, userId), eq(schema.searchRequests.normalizedQuery, normalizedQuery), eq(schema.searchRequests.status, "active")),
  });
  if (existing) return { request: existing };
  const [request] = await db.insert(schema.searchRequests).values({
    userId,
    query: clean,
    normalizedQuery,
    enrichmentStatus: "queued",
    status: "active",
  }).returning();
  return { request: request! };
}

export async function listSearchRequests(userId: string) {
  const db = getDb();
  return db.select().from(schema.searchRequests).where(eq(schema.searchRequests.userId, userId)).orderBy(sql`${schema.searchRequests.createdAt} desc`).limit(50);
}

export async function getSearchRequest(userId: string, id: string) {
  const [request] = await getDb().select().from(schema.searchRequests).where(and(eq(schema.searchRequests.userId, userId), eq(schema.searchRequests.id, id))).limit(1);
  return request ?? null;
}

export async function cancelSearchRequest(userId: string, id: string) {
  const [request] = await getDb().update(schema.searchRequests).set({
    status: "cancelled",
    enrichmentStatus: "failed",
    closedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(schema.searchRequests.userId, userId), eq(schema.searchRequests.id, id))).returning();
  if (!request) throw new MusicError("Search request not found.", 404);
  return request;
}

export async function retrySearchRequest(userId: string, id: string) {
  const [request] = await getDb().update(schema.searchRequests).set({
    status: "active",
    enrichmentStatus: "queued",
    closedAt: null,
    updatedAt: new Date(),
  }).where(and(eq(schema.searchRequests.userId, userId), eq(schema.searchRequests.id, id), eq(schema.searchRequests.status, "closed"))).returning();
  if (!request) throw new MusicError("Search request is not eligible to retry.", 409);
  return request;
}

export async function failQueuedSearchRequest(userId: string, id: string) {
  const [request] = await getDb().update(schema.searchRequests).set({
    enrichmentStatus: "failed",
    updatedAt: new Date(),
  }).where(and(eq(schema.searchRequests.userId, userId), eq(schema.searchRequests.id, id))).returning();
  return request ?? null;
}
