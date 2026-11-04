import { z } from "zod";

export const SPOTIFY_QUEUE = "mint-spotify";
export const SPOTIFY_SCOPES = ["playlist-read-private", "playlist-read-collaborative"] as const;
export const SPOTIFY_MAX_ITEMS = 10_000;
export const spotifyConfigured = () => Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET && process.env.ENCRYPTION_KEY);
export const spotifyExtended = () => process.env.SPOTIFY_API_MODE === "extended";
export type SpotifyFetch = typeof fetch;

export class SpotifyError extends Error {
  constructor(message: string, public readonly status = 0, public readonly retryAfterSeconds = 0) { super(message); }
}

export function parseSpotifyPlaylistId(value: string) {
  const raw = value.trim();
  if (/^[A-Za-z0-9]{22}$/.test(raw)) return raw;
  const uri = /^spotify:playlist:([A-Za-z0-9]{22})$/.exec(raw);
  if (uri) return uri[1]!;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && url.hostname === "open.spotify.com" && !url.username && !url.password) {
      const m = /^\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
      if (m) return m[1]!;
    }
  } catch { /* A bare identifier is handled above. */ }
  throw new SpotifyError("Use a Spotify playlist link, URI, or 22-character playlist ID.");
}

const artistSchema = z.object({ name: z.string().max(1000) });
const trackSchema = z.object({
  id: z.string().max(200).nullish(), uri: z.string().max(1000).nullish(), type: z.string(),
  name: z.string().max(1000).optional(), artists: z.array(artistSchema).max(100).optional(),
  album: z.object({ name: z.string().max(1000) }).optional(),
  duration_ms: z.number().int().nonnegative().max(86_400_000).optional(),
  external_ids: z.object({ isrc: z.string().max(100).optional() }).optional(),
  is_local: z.boolean().optional(), is_playable: z.boolean().optional(),
  restrictions: z.object({ reason: z.string().max(200) }).optional(),
});
const entrySchema = z.object({
  added_at: z.string().max(100).nullish(), added_by: z.object({ id: z.string().max(200).nullish() }).nullish(),
  is_local: z.boolean().optional(), item: trackSchema.nullish(), track: trackSchema.nullish(),
});
export const spotifyPlaylistSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9]{22}$/), name: z.string().max(1000),
  description: z.string().max(20_000).nullish(), snapshot_id: z.string().max(1000).optional(),
  collaborative: z.boolean().optional(),
  owner: z.object({ id: z.string().max(200).nullish(), display_name: z.string().max(1000).nullish() }),
});
export type SpotifyPlaylist = z.infer<typeof spotifyPlaylistSchema>;
export interface SpotifySourceItem {
  providerId: string | null; providerUri: string | null; title: string; artists: string[];
  album: string | null; durationMs: number | null; isrc: string | null;
  addedAt: string | null; addedBy: string | null; unavailable: string | null;
}

export function normalizeSpotifyItem(raw: unknown): SpotifySourceItem {
  const row = entrySchema.parse(raw);
  // An explicit null item means unavailable, even if a stale legacy track field is present.
  const track = Object.hasOwn(row, "item") ? row.item : row.track;
  const unavailable = !track ? "Spotify did not expose this item." :
    row.is_local || track.is_local ? "Spotify local-file item; no portable recording identity." :
      track.type !== "track" ? "Not a music track." :
        track.is_playable === false || track.restrictions ? "Spotify marks this item unavailable or restricted." :
          !track.name || !track.artists?.length || !track.album?.name || !track.duration_ms ? "Insufficient recording metadata for safe matching." : null;
  return {
    providerId: track?.id ?? null, providerUri: track?.uri ?? null,
    title: track?.name ?? "Unavailable item", artists: track?.artists?.map((a) => a.name) ?? [],
    album: track?.album?.name ?? null, durationMs: track?.duration_ms ?? null, isrc: track?.external_ids?.isrc ?? null,
    addedAt: row.added_at ?? null, addedBy: row.added_by?.id ?? null, unavailable,
  };
}

export const spotifyMetadataKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export interface SpotifyLocalCandidate { id: string; title: string; artist: string; album: string | null; durationSec: number | null }
export function matchSpotifyItem(item: SpotifySourceItem, candidates: SpotifyLocalCandidate[]) {
  if (item.unavailable) return { status: "unavailable" as const, trackId: null, reason: item.unavailable };
  const found = candidates.filter((local) => spotifyMetadataKey(local.title) === spotifyMetadataKey(item.title) &&
    spotifyMetadataKey(local.artist) === spotifyMetadataKey(item.artists.join(", ")) &&
    local.album && spotifyMetadataKey(local.album) === spotifyMetadataKey(item.album ?? "") &&
    local.durationSec && item.durationMs && Math.abs(local.durationSec * 1000 - item.durationMs) <= 2500);
  if (found.length === 1) return { status: "matched" as const, trackId: found[0]!.id, reason: "Exact title, artists and album; duration within 2.5 seconds." };
  if (found.length > 1) return { status: "ambiguous" as const, trackId: null, reason: "Multiple local recordings fit. No version was selected." };
  return { status: "missing" as const, trackId: null, reason: "No confident playable local recording. Nothing will be downloaded." };
}

function retryAfter(response: Response) {
  const value = response.headers.get("retry-after");
  if (!value) return 60;
  const seconds = Number(value);
  return Math.max(1, Math.min(7 * 86400, Number.isFinite(seconds) ? Math.ceil(seconds) : Math.ceil((Date.parse(value) - Date.now()) / 1000) || 60));
}
export async function spotifyJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    // Never propagate provider response bodies: they may contain credentials or personal data.
    if (response.status === 429) throw new SpotifyError("Spotify rate/quota limit reached. Retry after the displayed time.", 429, retryAfter(response));
    if ([400, 401].includes(response.status)) throw new SpotifyError("Spotify authorization expired or was revoked. Reconnect your account.", response.status);
    if (response.status === 403) throw new SpotifyError("Spotify denied access. Check app owner Premium, user allowlist, scopes and playlist ownership/collaboration.", 403);
    if (response.status === 404) throw new SpotifyError("Spotify playlist is unavailable or not accessible to this account.", 404);
    throw new SpotifyError(`Spotify service returned HTTP ${response.status}. Try again later.`, response.status);
  }
  const text = await response.text();
  if (text.length > 4_000_000) throw new SpotifyError("Spotify response exceeded the safety limit.");
  try { return JSON.parse(text) as unknown; } catch { throw new SpotifyError("Spotify returned invalid JSON."); }
}

export class SpotifyClient {
  private requests = 0;
  private readonly startedAt = Date.now();
  constructor(private token: () => Promise<string>, private transport: SpotifyFetch = fetch) {}
  async get(path: string): Promise<unknown> {
    if (++this.requests > 1_000 || Date.now() - this.startedAt > 10 * 60_000)
      throw new SpotifyError("Spotify sync request/time budget reached. The last successful snapshots were kept.");
    const url = new URL(path, "https://api.spotify.com/v1/");
    if (url.origin !== "https://api.spotify.com" || !url.pathname.startsWith("/v1/") || url.username || url.password)
      throw new SpotifyError("Invalid Spotify API URL.");
    return spotifyJson(await this.transport(url, { headers: { authorization: `Bearer ${await this.token()}`, "cache-control": "no-store" }, redirect: "error", signal: AbortSignal.timeout(20_000) }));
  }
  async *pages(path: string, maxItems = SPOTIFY_MAX_ITEMS): AsyncGenerator<unknown[]> {
    let next: string | null = path, count = 0, offset = -1, expectedOffset = 0, total: number | undefined;
    const seen = new Set<string>();
    const first = new URL(path, "https://api.spotify.com/v1/");
    for (let page = 0; next; page++) {
      const url = new URL(next, "https://api.spotify.com/v1/");
      const n = Number(url.searchParams.get("offset") ?? 0);
      if (url.origin !== first.origin || url.pathname !== first.pathname || url.username || url.password ||
        !Number.isSafeInteger(n) || n <= offset || n !== expectedOffset || page >= 250 || seen.has(url.href))
        throw new SpotifyError("Spotify pagination is cyclic or exceeds the supported bounds.");
      offset = n; seen.add(url.href);
      const body = z.object({ items: z.array(z.unknown()).max(100), next: z.string().max(2048).nullish(),
        total: z.number().int().nonnegative(), offset: z.number().int().nonnegative().optional() }).parse(await this.get(url.href));
      if ((total !== undefined && body.total !== total) || (body.offset !== undefined && body.offset !== n))
        throw new SpotifyError("Spotify collection changed while paging. The previous snapshot was kept.");
      total = body.total;
      count += body.items.length;
      expectedOffset = n + body.items.length;
      if (count > maxItems || (body.total ?? 0) > maxItems) throw new SpotifyError(`Spotify collection exceeds the ${maxItems}-item safety limit.`);
      if (body.next && !body.items.length) throw new SpotifyError("Spotify returned an empty page with a continuation.");
      yield body.items;
      next = body.next ?? null;
      if (!next && count !== total) throw new SpotifyError("Spotify returned an incomplete collection. The previous snapshot was kept.");
    }
  }
  async playlist(id: string) { return spotifyPlaylistSchema.parse(await this.get(`playlists/${parseSpotifyPlaylistId(id)}`)); }
}

export const spotifyTokenSchema = z.object({
  access_token: z.string().min(1).max(10_000), refresh_token: z.string().min(1).max(10_000).optional(),
  expires_in: z.number().positive().max(86400), scope: z.string().optional(), token_type: z.string().optional(),
});
export async function spotifyTokenRequest(body: URLSearchParams, transport: SpotifyFetch = fetch) {
  if (!spotifyConfigured()) throw new SpotifyError("Spotify setup required: configure client ID, secret and encryption key.");
  return spotifyTokenSchema.parse(await spotifyJson(await transport("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64")}` },
    body, redirect: "error", signal: AbortSignal.timeout(20_000),
  })));
}
