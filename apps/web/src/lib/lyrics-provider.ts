import { z } from "zod";
import { lyricsSchema, rankLyrics, type Lyrics } from "./lyrics";
import { canonicalPublicUrl, getPublicReadCache, PublicProviderBusyError, publicCacheKey, publicRetryAfter,
  type PublicReadCache } from "@mint/core/public-cache";

export class LyricsBusyError extends PublicProviderBusyError {
  constructor(retryAfter: number, provider = "LRCLIB") {
    super(provider, retryAfter);
    this.message = `${provider} is temporarily busy. Try again later.`;
  }
}
export function retryAfterSeconds(header: string | null, now = Date.now()) {
  return publicRetryAfter(header, now);
}
const matchSchema = lyricsSchema.extend({ id: z.number().int().positive(), source: z.literal("LRCLIB").default("LRCLIB") });
const searchSchema = z.array(matchSchema.extend({ trackName: z.string().max(1000), artistName: z.string().max(1000),
  albumName: z.string().max(1000), duration: z.number().finite().nonnegative() })).max(100);
async function cachedRead<T>(provider: string, url: string, request: typeof fetch, cache: PublicReadCache | null | undefined,
  validate: (value: unknown) => T, load: (signal?: AbortSignal) => Promise<T>, maxBytes: number, search = false,
  stale?: (age: number) => void): Promise<T> {
  const store = cache === undefined ? request === fetch ? getPublicReadCache() : null : cache;
  if (!store) return load();
  try {
    const result = await store.read({ provider, key: publicCacheKey(provider, "lyrics-v1", canonicalPublicUrl(url)),
      freshSeconds: search ? 3600 : 86400, keepSeconds: search ? 86400 : 7 * 86400, negativeSeconds: 300,
      maxBytes, validate, negative: (value) => value === null || (Array.isArray(value) && !value.length),
      timeoutMs: 10_000, load });
    if (result.stale) {
      if (stale) stale(result.ageSeconds);
      else console.error("Serving cached public lyrics while refresh is unavailable", { provider, ageSeconds: result.ageSeconds });
    }
    return result.value;
  } catch (error) {
    if (error instanceof PublicProviderBusyError) throw new LyricsBusyError(error.retryAfter, provider);
    throw error;
  }
}
export async function fetchLyrics(track: { artist: string; title: string; album: string | null; duration: number | null }, request = fetch,
  cache?: PublicReadCache | null, stale?: (age: number) => void): Promise<Lyrics | null> {
  const params = new URLSearchParams({ artist_name: track.artist, track_name: track.title });
  if (track.album) params.set("album_name", track.album);
  if (track.duration && track.duration >= 1 && track.duration <= 3600) params.set("duration", String(Math.round(track.duration)));
  const url = `https://lrclib.net/api/get?${params}`;
  return cachedRead("LRCLIB", url, request, cache, (value) => matchSchema.nullable().parse(value),
    async (signal) => readLyricsResponse(await request(url, providerOptions(signal))), 300_000, false, stale);
}
export async function fetchOvhLyrics(track: { artist: string; title: string }, request = fetch, cache?: PublicReadCache | null,
  stale?: (age: number) => void): Promise<Lyrics | null> {
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(track.artist)}/${encodeURIComponent(track.title)}`;
  return cachedRead("Lyrics.ovh", url, request, cache, (value) => lyricsSchema.extend({ source: z.literal("Lyrics.ovh") }).nullable().parse(value), async (signal) => {
    const body = await providerJson(await request(url, providerOptions(signal)), 300_000, "Lyrics.ovh");
    if (body === null) return null;
    const { lyrics } = z.object({ lyrics: z.string().max(100_000) }).parse(body);
    return lyrics.trim() ? { source: "Lyrics.ovh", instrumental: false, plainLyrics: lyrics.trim(), syncedLyrics: null } : null;
  }, 300_000, false, stale);
}

export async function fetchBestLyrics(track: Parameters<typeof fetchLyrics>[0], request = fetch, cooldown = 0, cache?: PublicReadCache | null) {
  const providers = ["LRCLIB", "Lyrics.ovh"] as const;
  const warnings: string[] = [];
  const stale = (provider: string) => (age: number) => warnings.push(`${provider} is serving cached lyrics (${age} seconds old) while upstream refresh is unavailable.`);
  const results = await Promise.allSettled([
    cooldown > 0 ? Promise.reject(new LyricsBusyError(cooldown)) : fetchLyrics(track, request, cache, stale("LRCLIB")),
    fetchOvhLyrics(track, request, cache, stale("Lyrics.ovh")),
  ]);
  const candidates: Lyrics[] = [];
  let failure: unknown, retryAfter = 0;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") { if (result.value) candidates.push(result.value); }
    else {
      failure ??= result.reason;
      warnings.push(`${providers[index]} is unavailable. Some lyric versions could not be checked.`);
      console.error(`${providers[index]} lyrics lookup failed`, result.reason instanceof Error ? result.reason.name : "Unknown failure");
      if (result.reason instanceof LyricsBusyError) retryAfter = Math.max(retryAfter, result.reason.retryAfter);
    }
  });
  const alternatives = rankLyrics(candidates);
  if (!alternatives.length && failure) throw failure;
  return { lyrics: alternatives[0] ?? null, alternatives, warnings, retryAfter };
}
const providerOptions = (signal?: AbortSignal) => ({
    headers: { "user-agent": "Mint/3.5 (https://github.com/ChickenBone/mint)" },
    signal: signal ?? AbortSignal.timeout(10_000), redirect: "error" as const, cache: "no-store" as const,
});
async function providerJson(response: Response, maxBytes = 300_000, provider = "LRCLIB"): Promise<unknown> {
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (response.status === 429 || response.status === 503 || (!response.ok && response.headers.has("retry-after"))) {
    await response.body?.cancel();
    throw new LyricsBusyError(retryAfterSeconds(response.headers.get("retry-after")), provider);
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Lyrics provider returned ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Lyrics provider response was empty");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error("Lyrics provider response was too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (body === null) throw new Error("Lyrics provider response was invalid");
  return body;
}
async function readLyricsResponse(response: Response) {
  const body = await providerJson(response);
  if (body === null) return null;
  const lyrics = { ...matchSchema.parse(body), source: "LRCLIB" as const };
  return rankLyrics([lyrics]).length ? lyrics : null;
}
export async function fetchLyricsById(id: number, request = fetch, cache?: PublicReadCache | null) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid lyric match");
  const url = `https://lrclib.net/api/get/${id}`;
  return cachedRead("LRCLIB", url, request, cache, (value) => matchSchema.nullable().parse(value),
    async (signal) => readLyricsResponse(await request(url, providerOptions(signal))), 300_000);
}
export async function searchLyrics(query: string, request = fetch, cache?: PublicReadCache | null) {
  query = z.string().trim().min(2).max(150).parse(query);
  const url = `https://lrclib.net/api/search?${new URLSearchParams({ q: query })}`;
  const results = await cachedRead("LRCLIB", url, request, cache, (value) => searchSchema.parse(value), async (signal) => {
    const body = await providerJson(await request(url, providerOptions(signal)), 2_000_000);
    return searchSchema.parse(body ?? []);
  }, 2_000_000, true);
  return results.slice(0, 20)
    .map(({ id, trackName, artistName, albumName, duration, instrumental }) => ({ id, trackName, artistName, albumName, duration, instrumental }));
}
