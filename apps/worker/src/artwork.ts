import { createHash } from "node:crypto";
import type { Track } from "@mint/core/schema";
import { log } from "./log";
import { canonicalPublicUrl, getPublicReadCache, PublicProviderBusyError, publicCacheKey, publicRetryAfter,
  type PublicReadCache } from "@mint/core/public-cache";

type ArtworkTrack = Pick<Track, "id" | "plexRatingKey" | "artworkUrl" | "youtubeVideoId" | "mbReleaseGroupId">;
export interface ArtworkImage { bytes: Buffer; type: string; etag: string; source: "plex" | "public"; maxAge: number;
  ageSeconds?: number; cacheStale?: boolean; fetchedAt?: number }
const MAX_IMAGE = 4 * 1024 ** 2, MAX_CACHE = 32 * 1024 ** 2;
const images = new Map<string, { image: ArtworkImage; expires: number; staleUntil: number }>();
const pending = new Map<string, Promise<ArtworkImage>>();
const thumbs = new Map<string, { path: string | null; expires: number }>();
const metadataPending = new Map<string, Promise<string | null>>();
const failures = new Map<string, number>();
let cacheBytes = 0;

export function publicArtworkUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    !["coverartarchive.org", "archive.org", "i.ytimg.com"].includes(url.hostname) && !url.hostname.endsWith(".archive.org")) {
    throw new Error("Unsupported public artwork source");
  }
  return url.href;
}

async function responseBytes(response: Response, maxBytes: number) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Artwork HTTP ${response.status}`); }
  if (Number(response.headers.get("content-length")) > maxBytes) { await response.body.cancel(); throw new Error("Artwork exceeds response budget"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new Error("Artwork exceeds response budget"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function rasterType(bytes: Buffer) {
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : /GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii")) ? "image/gif"
    : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null;
}
async function imageBytes(response: Response) {
  const bytes = await responseBytes(response, MAX_IMAGE), type = rasterType(bytes);
  if (!type) throw new Error("Artwork response is not a supported raster image");
  return { bytes, type };
}

async function cachedImage(key: string, source: ArtworkImage["source"], load: () => Promise<{
  bytes: Buffer; type: string; maxAge?: number; ageSeconds?: number; cacheStale?: boolean; staleUntil?: number; fetchedAt?: number;
}>) {
  const cached = images.get(key);
  if (cached) {
    images.delete(key); images.set(key, cached);
    if (cached.expires > Date.now() && cached.staleUntil > Date.now()) return cached.image;
  }
  const running = pending.get(key);
  if (running) return running;
  if ((failures.get(key) ?? 0) > Date.now()) throw new Error("Artwork source is temporarily unavailable");
  if (pending.size >= 64) throw new Error("Artwork service busy");
  const task = (async () => {
    try {
      const result = await load();
      const image: ArtworkImage = { ...result, source, maxAge: result.maxAge ?? (source === "plex" ? 3600 : 300),
        etag: `"${createHash("sha256").update(result.bytes).digest("hex")}"` };
      const previous = images.get(key);
      if (previous) { images.delete(key); cacheBytes -= previous.image.bytes.length; }
      while (images.size >= 256 || cacheBytes + image.bytes.length > MAX_CACHE) {
        const oldest = images.keys().next().value;
        if (oldest === undefined) break;
        cacheBytes -= images.get(oldest)!.image.bytes.length; images.delete(oldest);
      }
      const expires = Math.min(Date.now() + image.maxAge * 1000, result.staleUntil ?? Infinity);
      images.set(key, { image, expires, staleUntil: result.staleUntil ?? expires + 7 * 86400_000 });
      cacheBytes += image.bytes.length;
      return image;
    } catch (error) {
      if (cached && Date.now() < cached.staleUntil) {
        log.warn({ source }, "Artwork refresh failed; serving a cached cover and retrying shortly");
        const image = { ...cached.image, maxAge: 60, ...(source === "public" ? { cacheStale: true } : {}) };
        if (images.has(key)) images.set(key, { image, expires: Date.now() + 60_000, staleUntil: cached.staleUntil });
        return image;
      }
      if (failures.size >= 2000) failures.delete(failures.keys().next().value!);
      failures.set(key, Date.now() + 30_000);
      throw error;
    }
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

async function plexThumb(ratingKey: string, base: string, token: string, variant: "album" | "artist") {
  const key = `${variant}:${base}:${ratingKey}`, cached = thumbs.get(key);
  if (cached && cached.expires > Date.now()) return cached.path;
  const running = metadataPending.get(key);
  if (running) return running;
  if (metadataPending.size >= 64) throw new Error("Artwork metadata service busy");
  const task = (async () => {
    const response = await fetch(`${base}/library/metadata/${ratingKey}`, {
      headers: { "x-plex-token": token, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Plex artwork metadata HTTP ${response.status}`); }
    const text = (await responseBytes(response, 256_000)).toString("utf8");
    const data = JSON.parse(text) as { MediaContainer?: { Metadata?: { parentThumb?: unknown; grandparentThumb?: unknown; thumb?: unknown }[] } };
    const item = data.MediaContainer?.Metadata?.[0];
    const candidates = variant === "artist"
      ? [item?.grandparentThumb]
      : [item?.parentThumb, item?.thumb];
    const path = candidates.find((value): value is string => typeof value === "string" && /^\/library\/metadata\/\d+\/thumb(?:\/\d+)?$/.test(value)) ?? null;
    if (thumbs.size >= 2000) thumbs.delete(thumbs.keys().next().value!);
    thumbs.set(key, { path, expires: Date.now() + (path ? 15 * 60_000 : 60_000) });
    return path;
  })().catch((error: unknown) => {
    if (thumbs.size >= 2000) thumbs.delete(thumbs.keys().next().value!);
    thumbs.set(key, { path: cached?.path ?? null, expires: Date.now() + 30_000 });
    if (cached?.path) {
      log.warn({ variant }, "Plex artwork metadata refresh failed; retaining the last known artwork");
      return cached.path;
    }
    throw error;
  }).finally(() => metadataPending.delete(key));
  metadataPending.set(key, task);
  return task;
}

async function publicImage(value: string, signal: AbortSignal, request: typeof fetch) {
  let url = publicArtworkUrl(value);
  for (let hop = 0; hop < 5; hop++) {
    const response = await request(url, { redirect: "manual", signal, headers: { accept: "image/*", "user-agent": "Mint/3.5 (https://github.com/ChickenBone/mint)" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Artwork redirect has no destination");
      url = publicArtworkUrl(new URL(location, url).href);
      continue;
    }
    if (response.status === 429 || response.status === 503 || (!response.ok && response.headers.has("retry-after"))) {
      await response.body?.cancel();
      throw new PublicProviderBusyError(new URL(value).hostname === "i.ytimg.com" ? "YouTube-artwork" : "CoverArtArchive",
        publicRetryAfter(response.headers.get("retry-after")));
    }
    if (response.status === 404) { await response.body?.cancel(); return null; }
    return imageBytes(response);
  }
  throw new Error("Artwork redirect limit exceeded");
}

export async function readPublicArtwork(value: string, cache?: PublicReadCache | null, request: typeof fetch = fetch) {
  const url = publicArtworkUrl(value);
  if (cache === null) {
    const image = await publicImage(url, AbortSignal.timeout(5000), request);
    if (!image) throw new Error("Artwork HTTP 404");
    return image;
  }
  const provider = new URL(url).hostname === "i.ytimg.com" ? "YouTube-artwork" : "CoverArtArchive";
  const validate = (value: unknown): { data: string; type: string } | null => {
    if (value === null) return null;
    if (!value || typeof value !== "object" || !("data" in value) || !("type" in value) ||
      typeof value.data !== "string" || typeof value.type !== "string") throw new Error("Invalid cached public artwork");
    const bytes = Buffer.from(value.data, "base64");
    if (bytes.length > MAX_IMAGE || bytes.toString("base64") !== value.data || rasterType(bytes) !== value.type)
      throw new Error("Invalid cached public raster artwork");
    return { data: value.data, type: value.type };
  };
  const result = await (cache ?? getPublicReadCache()).read({
    provider, key: publicCacheKey(provider, "image-v1", canonicalPublicUrl(url)),
    freshSeconds: 86400, keepSeconds: 7 * 86400, negativeSeconds: 300, maxBytes: 6 * 1024 ** 2,
    timeoutMs: 5000, validate, negative: (image) => image === null,
    load: async (signal) => {
      const image = await publicImage(url, signal, request);
      return image ? { data: image.bytes.toString("base64"), type: image.type } : null;
    },
  });
  if (!result.value) throw new Error("Artwork HTTP 404");
  if (result.stale) log.warn({ provider, ageSeconds: result.ageSeconds }, "Serving a cached public cover while refresh is unavailable");
  return { bytes: Buffer.from(result.value.data, "base64"), type: result.value.type,
    maxAge: result.stale ? 60 : 300, ageSeconds: result.ageSeconds, cacheStale: result.stale, fetchedAt: result.fetchedAt,
    staleUntil: result.fetchedAt + 7 * 86400_000 };
}

async function plexImage(track: ArtworkTrack, variant: "album" | "artist") {
  const base = process.env.PLEX_URL?.replace(/\/$/, ""), token = process.env.PLEX_TOKEN;
  if (base && token && track.plexRatingKey && /^\d+$/.test(track.plexRatingKey)) {
    try {
      const thumb = await plexThumb(track.plexRatingKey, base, token, variant);
      if (thumb) return await cachedImage(`plex:${base}:${thumb}`, "plex", async () => {
        const url = new URL(`${base}/photo/:/transcode`);
        url.search = new URLSearchParams({ url: thumb, width: "512", height: "512", minSize: "1", upscale: "0" }).toString();
        return imageBytes(await fetch(url, {
          headers: { "x-plex-token": token, accept: "image/*" }, redirect: "error", signal: AbortSignal.timeout(2500),
        }));
      });
    } catch {
      log.warn({ trackId: track.id, variant }, "Plex artwork unavailable");
    }
  }
  return null;
}

export async function loadArtistArtwork(track: ArtworkTrack): Promise<ArtworkImage | null> {
  return plexImage(track, "artist");
}

export async function loadTrackArtwork(track: ArtworkTrack, cache?: PublicReadCache | null): Promise<ArtworkImage | null> {
  const plex = await plexImage(track, "album");
  if (plex) return plex;
  const urls: string[] = [];
  if (track.artworkUrl) urls.push(track.artworkUrl);
  if (track.mbReleaseGroupId && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(track.mbReleaseGroupId)) {
    urls.push(`https://coverartarchive.org/release-group/${track.mbReleaseGroupId}/front-500`);
  }
  if (track.youtubeVideoId && /^[\w-]{1,64}$/.test(track.youtubeVideoId)) urls.push(`https://i.ytimg.com/vi/${track.youtubeVideoId}/mqdefault.jpg`);
  for (const url of new Set(urls)) {
    try { return await cachedImage(`public:${publicArtworkUrl(url)}`, "public", () => readPublicArtwork(url, cache)); }
    catch { log.warn({ trackId: track.id }, "Public artwork source unavailable; trying the next cover source"); }
  }
  return null;
}
