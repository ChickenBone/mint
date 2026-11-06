import { musicBrainzJson } from "./musicbrainz";

const MB = "https://musicbrainz.org/ws/2";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const WIKIPEDIA = "https://en.wikipedia.org/api/rest_v1/page/summary";
const LISTENBRAINZ = "https://api.listenbrainz.org/1";
const LABS = "https://labs.api.listenbrainz.org/similar-artists";
const USER_AGENT = "Mint/3.5 (https://github.com/ChickenBone/mint)";
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

export interface RelatedArtist {
  name: string;
  musicBrainzArtistId: string;
  source: "listenbrainz" | "musicbrainz";
}

export interface ArtistProfile {
  artistType: string | null;
  area: string | null;
  biography: string | null;
  biographyUrl: string | null;
  relatedArtists: RelatedArtist[];
  listenCount: number | null;
  listenerCount: number | null;
  unavailableSources: string[];
}

export type ArtistMetadataResult =
  | { status: "ready"; musicBrainzArtistId: string; profile: ArtistProfile }
  | { status: "not_found" | "ambiguous"; musicBrainzArtistId: null; profile: null };

interface MusicBrainzArtist {
  id: string;
  name: string;
  type?: string | null;
  area?: { name?: string | null } | null;
  country?: string | null;
  relations?: Array<{
    type?: string;
    artist?: { id?: string; name?: string };
    url?: { resource?: string };
  }>;
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
}

function escapeQuery(value: string) {
  return value.replace(/(["\\+\-!(){}[\]^~*?:/]|&&|\|\|)/g, "\\$1");
}

function cleanText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

async function providerJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("user-agent", USER_AGENT);
  const response = await fetch(url, {
    ...init,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Metadata provider returned HTTP ${response.status}`);
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 512_000) {
    await response.body.cancel();
    throw new Error("Metadata provider response exceeded its size limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 512_000) {
        await reader.cancel();
        throw new Error("Metadata provider response exceeded its size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

async function findArtistId(name: string, knownIds: string[]): Promise<string | null | "ambiguous"> {
  const ids = [...new Set(knownIds.filter((id) => UUID.test(id)))];
  if (ids.length > 1) return "ambiguous";
  if (ids.length === 1) return ids[0]!;
  const query = `artist:"${escapeQuery(name)}"`;
  const found = await musicBrainzJson<{ artists?: Array<{ id: string; name: string; score?: number }> }>(
    `${MB}/artist`,
    { query, fmt: "json", limit: 25 },
    { retries: 0 },
  );
  const matches = [...new Set((found.artists ?? [])
    .filter((artist) => UUID.test(artist.id) && normalize(artist.name) === normalize(name))
    .map((artist) => artist.id))];
  return matches.length === 1 ? matches[0]! : matches.length ? "ambiguous" : null;
}

async function wikipediaSummary(qid: string) {
  const entity = await providerJson<{ entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } }> }>(
    `${WIKIDATA}?${new URLSearchParams({ action: "wbgetentities", ids: qid, props: "sitelinks", sitefilter: "enwiki", format: "json" })}`,
  );
  const title = entity.entities?.[qid]?.sitelinks?.enwiki?.title;
  if (!title) return null;
  const summary = await providerJson<{
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
  }>(`${WIKIPEDIA}/${encodeURIComponent(title)}`);
  const url = summary.content_urls?.desktop?.page;
  if (!url || new URL(url).protocol !== "https:" || new URL(url).hostname !== "en.wikipedia.org") return null;
  const biography = cleanText(summary.extract, 2000);
  return biography ? { biography, biographyUrl: url } : null;
}

function wikidataId(artist: MusicBrainzArtist) {
  for (const relation of artist.relations ?? []) {
    if (relation.type !== "wikidata" || !relation.url?.resource) continue;
    const match = /^https:\/\/www\.wikidata\.org\/wiki\/(Q\d+)$/.exec(relation.url.resource);
    if (match) return match[1]!;
  }
  return null;
}

function musicBrainzRelated(artist: MusicBrainzArtist): RelatedArtist[] {
  const related: RelatedArtist[] = [];
  const seen = new Set<string>();
  for (const relation of artist.relations ?? []) {
    const id = relation.artist?.id;
    const name = cleanText(relation.artist?.name, 200);
    if (!id || !UUID.test(id) || !name || id === artist.id || seen.has(id)) continue;
    seen.add(id);
    related.push({ name, musicBrainzArtistId: id, source: "musicbrainz" });
    if (related.length === 12) break;
  }
  return related;
}

async function listenBrainzPopularity(mbid: string) {
  const rows = await providerJson<Array<{ artist_mbid?: string; total_listen_count?: number | null; total_user_count?: number | null }>>(
    `${LISTENBRAINZ}/popularity/artist`,
    { method: "POST", body: JSON.stringify({ artist_mbids: [mbid] }), headers: { "content-type": "application/json" } },
  );
  const row = rows.find((item) => item.artist_mbid === mbid);
  return {
    listenCount: typeof row?.total_listen_count === "number" && Number.isSafeInteger(row.total_listen_count) && row.total_listen_count >= 0
      ? row.total_listen_count : null,
    listenerCount: typeof row?.total_user_count === "number" && Number.isSafeInteger(row.total_user_count) && row.total_user_count >= 0
      ? row.total_user_count : null,
  };
}

async function listenBrainzRelated(mbid: string): Promise<RelatedArtist[]> {
  const url = new URL(LABS);
  url.searchParams.set("artist_mbid", mbid);
  url.searchParams.set("algorithm", "session_based_days_9000_session_300_contribution_5_threshold_15_limit_50");
  const payload = await providerJson<unknown>(url.href);
  const rows = Array.isArray(payload) ? payload : [];
  const related: RelatedArtist[] = [];
  const seen = new Set<string>();
  for (const value of rows) {
    if (!value || typeof value !== "object") continue;
    const row = value as { artist_mbid?: unknown; artist_name?: unknown; name?: unknown };
    const id = typeof row.artist_mbid === "string" ? row.artist_mbid : "";
    const name = cleanText(row.artist_name ?? row.name, 200);
    if (!UUID.test(id) || id === mbid || !name || seen.has(id)) continue;
    seen.add(id);
    related.push({ name, musicBrainzArtistId: id, source: "listenbrainz" });
    if (related.length === 12) break;
  }
  return related;
}

export async function fetchArtistMetadata(name: string, knownIds: string[] = []): Promise<ArtistMetadataResult> {
  const normalizedName = cleanText(name, 1000);
  if (!normalizedName) return { status: "not_found", musicBrainzArtistId: null, profile: null };
  const id = await findArtistId(normalizedName, knownIds);
  if (id === "ambiguous") return { status: "ambiguous", musicBrainzArtistId: null, profile: null };
  if (!id) return { status: "not_found", musicBrainzArtistId: null, profile: null };

  const artist = await musicBrainzJson<MusicBrainzArtist>(
    `${MB}/artist/${id}`,
    { inc: "artist-rels+url-rels", fmt: "json" },
    { retries: 0 },
  );
  if (normalize(artist.name) !== normalize(normalizedName)) {
    return { status: "ambiguous", musicBrainzArtistId: null, profile: null };
  }

  const unavailableSources: string[] = [];
  const qid = wikidataId(artist);
  const [wikiResult, popularityResult, relatedResult] = await Promise.allSettled([
    qid ? wikipediaSummary(qid) : Promise.resolve(null),
    listenBrainzPopularity(id),
    listenBrainzRelated(id),
  ]);
  if (wikiResult.status === "rejected") unavailableSources.push("wikipedia");
  if (popularityResult.status === "rejected") unavailableSources.push("listenbrainz-popularity");
  if (relatedResult.status === "rejected") unavailableSources.push("listenbrainz-related");
  const relatedArtists = relatedResult.status === "fulfilled" ? relatedResult.value : [];
  const seen = new Set(relatedArtists.map((related) => related.musicBrainzArtistId));
  for (const related of musicBrainzRelated(artist)) {
    if (seen.has(related.musicBrainzArtistId)) continue;
    relatedArtists.push(related);
    if (relatedArtists.length >= 12) break;
  }
  const popularity = popularityResult.status === "fulfilled" ? popularityResult.value : { listenCount: null, listenerCount: null };
  const wiki = wikiResult.status === "fulfilled" ? wikiResult.value : null;

  return {
    status: "ready",
    musicBrainzArtistId: id,
    profile: {
      artistType: cleanText(artist.type, 100),
      area: cleanText(artist.area?.name ?? artist.country, 200),
      biography: wiki?.biography ?? null,
      biographyUrl: wiki?.biographyUrl ?? null,
      relatedArtists: relatedArtists.slice(0, 12),
      listenCount: popularity.listenCount,
      listenerCount: popularity.listenerCount,
      unavailableSources,
    },
  };
}
