import { optionalEnv } from "@mint/core/env";
import { catalogIdentityMatches, sameRecordingVersion } from "@mint/core/matching";
import { HttpError, type RequestOpts } from "../http";
import { log } from "../log";
import { canonicalPublicUrl, getPublicReadCache, PublicProviderBusyError, publicCacheKey, publicRetryAfter,
  type PublicReadCache } from "@mint/core/public-cache";
import { boundedMetadataJson } from "./public-metadata";

const API = "https://musicbrainz.org/ws/2";
const UA = optionalEnv("MUSICBRAINZ_USER_AGENT", "Mint/3.5 ( https://github.com/ChickenBone/mint )");

// MusicBrainz allows ~1 request/second per client.
let chain: Promise<unknown> = Promise.resolve();
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => new Promise((r) => setTimeout(r, 1100)),
    () => new Promise((r) => setTimeout(r, 1100)),
  );
  return next;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function validMirrorResult(value: unknown, pathname: string): boolean {
  if (!object(value) || "error" in value) return false;
  const parts = pathname.slice("/ws/2/".length).split("/").filter(Boolean);
  const entity = parts[0];
  if (parts.length > 2 || !["recording", "artist", "release-group"].includes(entity ?? "")) return false;
  const validEntity = (row: unknown): boolean => {
    if (!object(row) || !text(row.id) || !text(entity === "artist" ? row.name : row.title)) return false;
    if (row.score !== undefined && ((typeof row.score !== "number" && typeof row.score !== "string") ||
      !text(String(row.score)) || !Number.isFinite(Number(row.score)))) return false;
    if (parts.length === 1 && entity !== "artist" && row.score === undefined) return false;
    if (row.length !== undefined && row.length !== null &&
      (typeof row.length !== "number" || !Number.isFinite(row.length) || row.length < 0)) return false;
    if (row["artist-credit"] !== undefined && (!Array.isArray(row["artist-credit"]) ||
      !row["artist-credit"].every((credit) => object(credit) && text(credit.name) &&
        object(credit.artist) && text(credit.artist.id) && text(credit.artist.name)))) return false;
    if (row.releases !== undefined && (!Array.isArray(row.releases) ||
      !row.releases.every((release) => object(release) && text(release.id) && text(release.title) &&
        (release["release-group"] === undefined || (object(release["release-group"]) &&
          text(release["release-group"].id) &&
          (release["release-group"]["secondary-types"] === undefined ||
            Array.isArray(release["release-group"]["secondary-types"]))))))) return false;
    if (row.relations !== undefined && (!Array.isArray(row.relations) || !row.relations.every(object))) return false;
    return true;
  };
  if (parts.length === 2) return validEntity(value);
  const results = value[entity === "release-group" ? "release-groups" : `${entity}s`];
  return Array.isArray(results) && results.every(validEntity);
}

export function musicBrainzJson<T>(
  url: string,
  query?: Record<string, string | number | boolean | undefined>,
  options: Pick<RequestOpts, "timeoutMs" | "retries"> & { cache?: PublicReadCache | null } = {},
) {
  const request = { ...options, headers: { "user-agent": UA }, query };
  const load = async (signal: AbortSignal) => {
    const mirror = optionalEnv("MUSICBRAINZ_MIRROR_URL", "").trim();
    const publicUrl = new URL(url);
    // Route canonical URLs here so all existing worker consumers share the same fallback.
    if (mirror && publicUrl.origin === "https://musicbrainz.org" &&
      publicUrl.pathname.startsWith("/ws/2/")) {
      try {
        const base = new URL(mirror);
        if (!["http:", "https:"].includes(base.protocol) || base.origin === publicUrl.origin || base.username || base.password ||
          base.search || base.hash || !base.pathname.replace(/\/+$/, "").endsWith("/ws/2")) {
          throw new Error("Invalid MusicBrainz mirror API base");
        }
        base.pathname = base.pathname.replace(/\/+$/, "") + publicUrl.pathname.slice("/ws/2".length);
        base.search = publicUrl.search;
        if (query) for (const [key, value] of Object.entries(query)) if (value !== undefined) base.searchParams.set(key, String(value));
        const response = await fetch(base, { headers: request.headers, redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(options.timeoutMs ?? 3000, 3000))]) });
        const result = await boundedMetadataJson(response, 1_000_000) as T;
        if (!validMirrorResult(result, publicUrl.pathname)) {
          throw new Error("Invalid MusicBrainz mirror JSON");
        }
        return result;
      } catch (err) {
        log.warn({ status: err instanceof HttpError ? err.status : undefined },
          "MusicBrainz mirror unavailable or invalid; falling back to public service");
      }
    }
    if (query) for (const [key, value] of Object.entries(query)) if (value !== undefined) publicUrl.searchParams.set(key, String(value));
    const response = await fetch(publicUrl, { headers: request.headers, redirect: "error", signal });
    if (response.status === 429 || response.status === 503 || (!response.ok && response.headers.has("retry-after"))) {
      await response.body?.cancel();
      const error = new PublicProviderBusyError("MusicBrainz", publicRetryAfter(response.headers.get("retry-after")));
      error.message = `MusicBrainz returned HTTP ${response.status}`;
      throw error;
    }
    return await boundedMetadataJson(response, 1_000_000) as T;
  };
  if (options.cache === null) return throttled(() => load(AbortSignal.timeout(options.timeoutMs ?? 15000)));
  const canonical = new URL(url);
  if (canonical.origin !== "https://musicbrainz.org" ||
    !/^\/ws\/2\/(?:artist|recording|release-group)(?:\/[\da-f-]{36})?$/.test(canonical.pathname) ||
    canonical.username || canonical.password || canonical.port) throw new Error("Unsupported MusicBrainz public read");
  if (query) for (const [key, value] of Object.entries(query)) if (value !== undefined) canonical.searchParams.set(key, String(value));
  const byId = /^\/ws\/2\/(?:artist|recording|release-group)\/[^/]+$/.test(canonical.pathname);
  return (options.cache ?? getPublicReadCache()).read({
    provider: "MusicBrainz", key: publicCacheKey("MusicBrainz", "entity-v1",
      [canonicalPublicUrl(canonical), optionalEnv("MUSICBRAINZ_MIRROR_URL", "").trim()]),
    freshSeconds: byId ? 86400 : 3600, keepSeconds: byId ? 7 * 86400 : 86400,
    negativeSeconds: 300, spacingSeconds: 2, maxBytes: 1_000_000,
    validate: (value) => {
      if (!validMirrorResult(value, canonical.pathname)) throw new Error("Invalid MusicBrainz metadata");
      return value as T;
    },
    negative: (value) => object(value) && ["recordings", "artists", "release-groups"].some((key) => Array.isArray(value[key]) && !value[key].length),
    timeoutMs: Math.min(options.timeoutMs ?? 15000, 15000), load,
  }).then((result) => {
    if (result.stale) log.warn({ provider: "MusicBrainz", ageSeconds: result.ageSeconds }, "Using cached public metadata while refresh is unavailable");
    return result.value;
  });
}

interface MbRecording {
  id: string;
  score: number;
  title: string;
  length?: number;
  video?: boolean;
  disambiguation?: string;
  "artist-credit"?: Array<{ name: string; artist: { id: string; name: string; aliases?: Array<{ name: string }> } }>;
  releases?: Array<{
    id: string;
    title: string;
    status?: string;
    date?: string;
    "release-group"?: { id: string; "primary-type"?: string; "secondary-types"?: string[] };
    media?: Array<{ track?: Array<{ length?: number | null }>; tracks?: Array<{ length?: number | null }> }>;
  }>;
}

/** The recording length, or else the length its release tracks agree on (within 3s); never a guess. */
function recordingLengthMs(rec: MbRecording): number | null {
  if (rec.length && Number.isFinite(rec.length) && rec.length > 0) return rec.length;
  const lengths = (rec.releases ?? []).flatMap((release) => (release.media ?? []).flatMap((medium) =>
    [...(medium.track ?? []), ...(medium.tracks ?? [])].flatMap((track) =>
      typeof track.length === "number" && Number.isFinite(track.length) && track.length > 0 ? [track.length] : []))).sort((a, b) => a - b);
  if (!lengths.length || lengths[lengths.length - 1]! - lengths[0]! > 3000) return null;
  return lengths[Math.floor(lengths.length / 2)]!;
}

export interface MbMatch {
  recordingId: string;
  artistId: string;
  artist: string;
  title: string;
  releaseGroupId: string;
  album: string;
  year: number | null;
  durationSec: number | null;
  officialDurationsSec: number[];
  ambiguous: boolean;
}

const esc = (s: string) => s.replace(/(["\\+\-!(){}[\]^~*?:/]|&&|\|\|)/g, "\\$1");
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

export async function matchRecording(q: {
  title: string;
  artist: string;
  album?: string | null;
  durationSec?: number | null;
  mbRecordingId?: string | null;
}, cache?: PublicReadCache | null): Promise<MbMatch | null> {
  const primaryArtist = q.artist.split(/,|&| feat\.? | ft\.? | with /i)[0]!.trim();
  const query = `recording:"${esc(q.title)}" AND artist:"${esc(primaryArtist)}"`;
  const data = q.mbRecordingId ? { recordings: [{ ...await musicBrainzJson<MbRecording>(
    `${API}/recording/${encodeURIComponent(q.mbRecordingId)}`,
    { inc: "artists+releases+release-groups+media", fmt: "json" },
    { cache },
  ), score: 100 }] } : await musicBrainzJson<{ recordings: MbRecording[] }>(
    `${API}/recording`,
    { query, fmt: "json", limit: 15 },
    { cache },
  );

  type Candidate = { rec: MbRecording; rel: NonNullable<MbRecording["releases"]>[number]; score: number };
  const candidates: Candidate[] = [];
  for (const found of data.recordings ?? []) {
    const length = recordingLengthMs(found);
    const rec = length ? { ...found, length } : found;
    if (rec.score < 80 || !rec["artist-credit"]?.length) continue;
    if (rec.video === true || !sameRecordingVersion(q.title, `${rec.title} ${rec.disambiguation ?? ""}`) ||
      !catalogIdentityMatches(q, { title: rec.title, artists: rec["artist-credit"].map((credit) => ({
      name: credit.name, aliases: [credit.artist?.name, ...(credit.artist?.aliases?.map((alias) => alias.name) ?? [])].filter((name): name is string => Boolean(name)),
    })) })) continue;
    if (q.mbRecordingId && rec.id !== q.mbRecordingId) continue;
    if (q.mbRecordingId && q.durationSec && (!rec.length || Math.abs(rec.length / 1000 - q.durationSec) > 2.5)) continue;
    if (q.durationSec && rec.length && Math.abs(rec.length / 1000 - q.durationSec) > 12) continue;
    for (const rel of rec.releases ?? []) {
      const rg = rel["release-group"];
      if (!rg) continue;
      if (q.mbRecordingId && q.album && norm(rel.title) !== norm(q.album)) continue;
      let score = rec.score;
      if (rel.status === "Official") score += 10;
      if (rg["primary-type"] === "Album") score += 8;
      else if (rg["primary-type"] === "EP") score += 4;
      if (rg["secondary-types"]?.length) score -= 25; // compilations, live, remixes
      if (q.album && norm(rel.title) === norm(q.album)) score += 30;
      candidates.push({ rec, rel, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return null;
  const credit = best.rec["artist-credit"]![0]!;
  const ambiguous = new Set(candidates.map((candidate) => candidate.rec.id)).size > 1;
  return {
    recordingId: best.rec.id,
    artistId: credit.artist.id,
    artist: credit.artist.name,
    title: best.rec.title,
    releaseGroupId: best.rel["release-group"]!.id,
    album: best.rel.title,
    year: best.rel.date ? Number(best.rel.date.slice(0, 4)) || null : null,
    ambiguous,
    durationSec: !ambiguous &&
      best.rec.length && Number.isFinite(best.rec.length) && best.rec.length > 0 ? Math.round(best.rec.length / 1000) : null,
    officialDurationsSec: [...new Set(candidates.filter(({ rec, rel }) =>
      rel.status === "Official" && (rel["release-group"]?.["secondary-types"] ?? []).every((type) => type === "Compilation") &&
      rec.length && Number.isFinite(rec.length) && rec.length > 0)
      .map(({ rec }) => Math.round(rec.length! / 1000)).filter((length) => length > 0))],
  };
}

export function coverArtUrl(releaseGroupId: string) {
  return `https://coverartarchive.org/release-group/${releaseGroupId}/front-500`;
}

/** Match both artist and album; never use the first fuzzy search hit as a cover. */
export async function albumReleaseGroups(artist: string, album: string, cache?: PublicReadCache | null): Promise<string[]> {
  const data = await musicBrainzJson<{ "release-groups": Array<{
      id: string;
      title: string;
      score: number;
      "artist-credit"?: Array<{ name: string; artist?: { name: string } }>;
    }> }>(`${API}/release-group`, {
    query: `releasegroup:"${esc(album)}" AND artist:"${esc(artist)}"`, fmt: "json", limit: 10,
    }, { timeoutMs: 15_000, retries: 0, cache });
  return (data["release-groups"] ?? [])
    .filter((group) => group.score >= 90 && norm(group.title) === norm(album) &&
      group["artist-credit"]?.some((credit) => norm(credit.artist?.name ?? credit.name) === norm(artist)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((group) => group.id);
}
