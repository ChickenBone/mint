import { createHash } from "node:crypto";
import { z } from "zod";
import { chartEntrySchema, type ChartDefinition, type ChartEntry, type ChartSnapshot } from "./charts";

export class ChartProviderError extends Error {
  constructor(message: string, public readonly retrySeconds = 300) { super(message); }
}
const text = z.string().min(1).max(1000);
const uuidOrNull = (value?: string | null) => z.uuid().safeParse(value).success ? value! : null;
const safeUrl = (value: string | null | undefined, hosts: string[]) => {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null; }
  catch { return null; }
};
const chartArtworkHosts = {
  apple: ["mzstatic.com"],
  listenbrainz: ["coverartarchive.org"],
  audius: ["audius.co"],
} as const;
export function validChartArtwork(provider: ChartDefinition["provider"], value: string | null) {
  return value === null || safeUrl(value, [...chartArtworkHosts[provider]]) === value;
}

export async function boundedProviderJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    const raw = response.headers.get("retry-after"), seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? (Date.parse(raw) - Date.now()) / 1000 : 300;
    throw new ChartProviderError(response.status === 429 ? "Provider rate limit reached. Mint will retry after the cooldown." :
      `Chart provider returned HTTP ${response.status}. Try again later.`, Math.max(60, Math.min(86400, Math.ceil(seconds) || 300)));
  }
  if (response.status === 204) return null;
  const reader = response.body?.getReader();
  if (!reader) throw new ChartProviderError("The chart provider returned no response body.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) { await reader.cancel(); throw new ChartProviderError("Chart response exceeded the safety limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new ChartProviderError("The chart provider returned invalid JSON."); }
}
export async function fetchChart(definition: ChartDefinition, transport: typeof fetch = fetch, now = new Date()): Promise<ChartSnapshot> {
  const get = async (url: string) => boundedProviderJson(await transport(url, {
    headers: { accept: "application/json", "user-agent": "Mint/3.5 ( https://github.com/ChickenBone/mint )" },
    redirect: "error", signal: AbortSignal.timeout(8000), cache: "no-store",
  }));
  let entries: ChartEntry[], period: string, providerUpdatedAt: string | null = null, notice: string | null = null;
  if (definition.provider === "apple") {
    const feed = z.object({ feed: z.object({ country: z.string(), updated: z.string(), results: z.array(z.object({
      id: z.string().regex(/^\d+$/), name: text, artistName: text, url: z.url(),
      artworkUrl100: z.string().max(2048).optional(), genres: z.array(z.object({ name: z.string().max(100) })).max(30).optional(),
    })).max(50) }) }).parse(await get(`https://rss.marketingtools.apple.com/api/v2/${definition.country}/music/most-played/50/songs.json`)).feed;
    if (feed.country.toLowerCase() !== definition.country) throw new ChartProviderError("Provider returned the wrong chart territory.");
    providerUpdatedAt = new Date(feed.updated).toISOString();
    const metadata = feed.results.length ? z.object({ results: z.array(z.object({
      trackId: z.number(), trackTimeMillis: z.number().positive().optional(), collectionName: z.string().optional(),
    })).max(100) }).parse(await get(`https://itunes.apple.com/lookup?${new URLSearchParams({ id: feed.results.map((entry) => entry.id).join(","), entity: "song", country: definition.country! })}`)).results : [];
    entries = feed.results.map((entry, index) => {
      const extra = metadata.find((item) => String(item.trackId) === entry.id);
      return { id: entry.id, rank: index + 1, title: entry.name, artist: entry.artistName,
        album: extra?.collectionName ?? null, durationSec: extra?.trackTimeMillis ? extra.trackTimeMillis / 1000 : null,
        recordingId: null, isrc: null, url: safeUrl(entry.url, ["music.apple.com", "itunes.apple.com"]) ?? definition.url,
        artwork: safeUrl(entry.artworkUrl100 ?? null, [...chartArtworkHosts.apple]),
        genres: entry.genres?.map((genre) => genre.name).filter((name) => name !== "Music") ?? [] };
    });
    period = "Current storefront ranking · window not published by Apple";
  } else if (definition.provider === "listenbrainz") {
    const body = await get("https://api.listenbrainz.org/1/stats/sitewide/recordings?range=week&count=50&offset=0");
    if (body === null) return snapshot([], "Weekly statistics not yet published", null, now);
    const payload = z.object({ payload: z.object({
      from_ts: z.number(), to_ts: z.number(), last_updated: z.number(),
      recordings: z.array(z.object({ track_name: text, artist_name: text, recording_mbid: z.string().nullish(),
        release_name: z.string().nullish(), caa_release_mbid: z.string().nullish() })).max(50),
    }) }).parse(body).payload;
    providerUpdatedAt = new Date(payload.last_updated * 1000).toISOString();
    period = `${new Date(payload.from_ts * 1000).toISOString().slice(0, 10)} – ${new Date(payload.to_ts * 1000).toISOString().slice(0, 10)} (UTC)`;
    entries = payload.recordings.map((entry, index) => {
      const releaseId = uuidOrNull(entry.caa_release_mbid);
      const recordingId = uuidOrNull(entry.recording_mbid);
      return {
        id: createHash("sha256").update(JSON.stringify([entry.recording_mbid, entry.caa_release_mbid, entry.artist_name, entry.track_name, entry.release_name])).digest("hex"),
        rank: index + 1, title: entry.track_name, artist: entry.artist_name, album: entry.release_name ?? null,
        durationSec: null, recordingId, isrc: null,
        artwork: releaseId ? `https://coverartarchive.org/release/${releaseId}/front-250` : null,
        genres: [], url: recordingId ? `https://musicbrainz.org/recording/${recordingId}` : definition.url,
      };
    });
    const identifiers = entries.flatMap((entry) => entry.recordingId ? [entry.recordingId] : []);
    if (new Set(identifiers).size !== identifiers.length) notice = "ListenBrainz lists some recordings separately by release variant. Its original ranks and order are retained.";
  } else {
    const query = new URLSearchParams({ app_name: "Mint", time: "week", limit: "50" });
    if (definition.genre) query.set("genre", definition.genre);
    const data = z.object({ data: z.array(z.object({
      id: z.string().max(200), title: text, duration: z.number().positive(), genre: z.string().max(100).nullish(),
      permalink: z.string().optional(), isrc: z.string().max(100).nullish(),
      artwork: z.object({ "150x150": z.string().max(2048).optional(), "480x480": z.string().max(2048).optional() }).nullish(),
      user: z.object({ name: text }), is_available: z.boolean().optional(),
    })).max(50) }).parse(await get(`https://api.audius.co/v1/tracks/trending?${query}`)).data;
    entries = data.map((entry, index) => ({ id: entry.id, rank: index + 1, title: entry.title, artist: entry.user.name,
      album: null, durationSec: entry.duration, recordingId: null, isrc: entry.isrc ?? null,
      artwork: safeUrl(entry.artwork?.["480x480"] ?? entry.artwork?.["150x150"] ?? null, [...chartArtworkHosts.audius]),
      genres: entry.genre ? [entry.genre] : [], url: safeUrl(entry.permalink, ["audius.co"]) ?? definition.url }));
    period = "This week · Audius trending algorithm";
  }
  return { ...snapshot(entries, period, providerUpdatedAt, now), notice };
}
function snapshot(entries: ChartEntry[], period: string, providerUpdatedAt: string | null, now: Date): ChartSnapshot {
  const validated = z.array(chartEntrySchema).max(50).parse(entries);
  if (new Set(validated.map((entry) => entry.id)).size !== validated.length) throw new ChartProviderError("The provider returned duplicate recording identities.");
  return { entries: validated, period, providerUpdatedAt, fetchedAt: now.toISOString(), notice: null,
    revision: createHash("sha256").update(JSON.stringify([validated, period, providerUpdatedAt])).digest("hex").slice(0, 20) };
}
