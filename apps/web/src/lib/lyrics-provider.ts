import { z } from "zod";
import { lyricsSchema, rankLyrics, type Lyrics } from "./lyrics";

export class LyricsBusyError extends Error {
  constructor(public retryAfter: number, public provider = "LRCLIB") { super(`${provider} is temporarily busy. Try again later.`); }
}
export function retryAfterSeconds(header: string | null, now = Date.now()) {
  if (!header) return 60;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds : (Date.parse(header) - now) / 1000;
  return Number.isFinite(delay) ? Math.min(2147483647, Math.max(1, Math.ceil(delay))) : 60;
}
export async function fetchLyrics(track: { artist: string; title: string; album: string | null; duration: number | null }, request = fetch): Promise<Lyrics | null> {
  const params = new URLSearchParams({ artist_name: track.artist, track_name: track.title });
  if (track.album) params.set("album_name", track.album);
  if (track.duration && track.duration >= 1 && track.duration <= 3600) params.set("duration", String(Math.round(track.duration)));
  return readLyricsResponse(await request(`https://lrclib.net/api/get?${params}`, providerOptions()));
}
export async function fetchOvhLyrics(track: { artist: string; title: string }, request = fetch): Promise<Lyrics | null> {
  const response = await request(`https://api.lyrics.ovh/v1/${encodeURIComponent(track.artist)}/${encodeURIComponent(track.title)}`, providerOptions());
  const body = await providerJson(response, 300_000, "Lyrics.ovh");
  if (body === null) return null;
  const { lyrics } = z.object({ lyrics: z.string().max(100_000) }).parse(body);
  return lyrics.trim() ? { source: "Lyrics.ovh", instrumental: false, plainLyrics: lyrics.trim(), syncedLyrics: null } : null;
}

export async function fetchBestLyrics(track: Parameters<typeof fetchLyrics>[0], request = fetch, cooldown = 0) {
  const providers = ["LRCLIB", "Lyrics.ovh"] as const;
  const results = await Promise.allSettled([
    cooldown > 0 ? Promise.reject(new LyricsBusyError(cooldown)) : fetchLyrics(track, request),
    fetchOvhLyrics(track, request),
  ]);
  const candidates: Lyrics[] = [], warnings: string[] = [];
  let failure: unknown, retryAfter = 0;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") { if (result.value) candidates.push(result.value); }
    else {
      failure ??= result.reason;
      warnings.push(`${providers[index]} is unavailable. Some lyric versions could not be checked.`);
      console.error(`${providers[index]} lyrics lookup failed`, result.reason instanceof Error ? result.reason.message : "Unknown failure");
      if (index === 0 && result.reason instanceof LyricsBusyError) retryAfter = result.reason.retryAfter;
    }
  });
  const alternatives = rankLyrics(candidates);
  if (!alternatives.length && failure) throw failure;
  return { lyrics: alternatives[0] ?? null, alternatives, warnings, retryAfter };
}
const providerOptions = () => ({
    headers: { "user-agent": "Mint/3.5 (https://github.com/ChickenBone/mint)" },
    signal: AbortSignal.timeout(10_000), redirect: "error" as const, cache: "no-store" as const,
});
async function providerJson(response: Response, maxBytes = 300_000, provider = "LRCLIB"): Promise<unknown> {
  if (response.status === 404) return null;
  if (response.status === 429 || response.status === 503) throw new LyricsBusyError(retryAfterSeconds(response.headers.get("retry-after")), provider);
  if (!response.ok) throw new Error(`Lyrics provider returned ${response.status}`);
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
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function readLyricsResponse(response: Response) {
  const body = await providerJson(response);
  return body === null ? null : { ...lyricsSchema.extend({ id: z.number().int().positive() }).parse(body), source: "LRCLIB" as const };
}
export async function fetchLyricsById(id: number, request = fetch) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid lyric match");
  return readLyricsResponse(await request(`https://lrclib.net/api/get/${id}`, providerOptions()));
}
export async function searchLyrics(query: string, request = fetch) {
  const body = await providerJson(await request(`https://lrclib.net/api/search?${new URLSearchParams({ q: query })}`, providerOptions()), 2_000_000);
  return z.array(lyricsSchema.extend({ id: z.number().int().positive(), trackName: z.string().max(1000), artistName: z.string().max(1000),
    albumName: z.string().max(1000), duration: z.number().finite().nonnegative() })).max(100).parse(body ?? []).slice(0, 20)
    .map(({ id, trackName, artistName, albumName, duration, instrumental }) => ({ id, trackName, artistName, albumName, duration, instrumental }));
}
