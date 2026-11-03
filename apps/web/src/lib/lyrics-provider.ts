import { lyricsSchema, type Lyrics } from "./lyrics";

export class LyricsBusyError extends Error {
  constructor(public retryAfter: number) { super("LRCLIB is temporarily busy. Try again later."); }
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
  const init = {
    headers: { "user-agent": "Mint/2.6 (https://github.com/ChickenBone/mint)" },
    signal: AbortSignal.timeout(10_000), redirect: "error" as const, cache: "no-store" as const,
  };
  const response = await request(`https://lrclib.net/api/get?${params}`, init);
  if (response.status === 404) return null;
  if (response.status === 429 || response.status === 503) throw new LyricsBusyError(retryAfterSeconds(response.headers.get("retry-after")));
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
      if (total > 300_000) { await reader.cancel(); throw new Error("Lyrics provider response was too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return lyricsSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}
