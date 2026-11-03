import { optionalEnv } from "@mint/core/env";
import { httpJson } from "../http";

const API = "https://musicbrainz.org/ws/2";
const UA = optionalEnv("MUSICBRAINZ_USER_AGENT", "Mint/0.1 ( https://mint.chickenbone.dev )");

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

interface MbRecording {
  id: string;
  score: number;
  title: string;
  length?: number;
  "artist-credit"?: Array<{ name: string; artist: { id: string; name: string } }>;
  releases?: Array<{
    id: string;
    title: string;
    status?: string;
    date?: string;
    "release-group"?: { id: string; "primary-type"?: string; "secondary-types"?: string[] };
  }>;
}

export interface MbMatch {
  recordingId: string;
  artistId: string;
  artist: string;
  title: string;
  releaseGroupId: string;
  album: string;
  year: number | null;
}

const esc = (s: string) => s.replace(/(["\\+\-!(){}[\]^~*?:/]|&&|\|\|)/g, "\\$1");
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

export async function matchRecording(q: {
  title: string;
  artist: string;
  album?: string | null;
  durationSec?: number | null;
}): Promise<MbMatch | null> {
  const primaryArtist = q.artist.split(/,|&| feat\.? | ft\.? /i)[0]!.trim();
  const query = `recording:"${esc(q.title)}" AND artist:"${esc(primaryArtist)}"`;
  const data = await throttled(() =>
    httpJson<{ recordings: MbRecording[] }>(`${API}/recording`, {
      headers: { "user-agent": UA },
      query: { query, fmt: "json", limit: 15 },
    }),
  );

  type Candidate = { rec: MbRecording; rel: NonNullable<MbRecording["releases"]>[number]; score: number };
  const candidates: Candidate[] = [];
  for (const rec of data.recordings ?? []) {
    if (rec.score < 80 || !rec["artist-credit"]?.length) continue;
    if (q.durationSec && rec.length && Math.abs(rec.length / 1000 - q.durationSec) > 12) continue;
    for (const rel of rec.releases ?? []) {
      const rg = rel["release-group"];
      if (!rg) continue;
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
  return {
    recordingId: best.rec.id,
    artistId: credit.artist.id,
    artist: credit.artist.name,
    title: best.rec.title,
    releaseGroupId: best.rel["release-group"]!.id,
    album: best.rel.title,
    year: best.rel.date ? Number(best.rel.date.slice(0, 4)) || null : null,
  };
}

export function coverArtUrl(releaseGroupId: string) {
  return `https://coverartarchive.org/release-group/${releaseGroupId}/front-500`;
}

/** Match both artist and album; never use the first fuzzy search hit as a cover. */
export async function albumReleaseGroups(artist: string, album: string): Promise<string[]> {
  const data = await throttled(() =>
    httpJson<{ "release-groups": Array<{
      id: string;
      title: string;
      score: number;
      "artist-credit"?: Array<{ name: string; artist?: { name: string } }>;
    }> }>(`${API}/release-group`, {
      headers: { "user-agent": UA },
      query: { query: `releasegroup:"${esc(album)}" AND artist:"${esc(artist)}"`, fmt: "json", limit: 10 },
      timeoutMs: 15_000,
      retries: 0,
    }),
  );
  return (data["release-groups"] ?? [])
    .filter((group) => group.score >= 90 && norm(group.title) === norm(album) &&
      group["artist-credit"]?.some((credit) => norm(credit.artist?.name ?? credit.name) === norm(artist)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((group) => group.id);
}
