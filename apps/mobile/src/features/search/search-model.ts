import type { CatalogCoverage, CatalogResult, PlayerItem, RecordingSearchItem, SearchRequestView } from "@mint/client";

type Recording = { title: string; artist: string; album: string | null; durationSec: number | null };
export const normalizeSearchQuery = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function uniqueRecordings<T extends Recording>(local: PlayerItem[], external: T[]): T[] {
  return external.filter((recording) => !local.some((item) => item.type === "track" &&
    normalizeSearchQuery(item.title) === normalizeSearchQuery(recording.title) && normalizeSearchQuery(item.artist ?? "") === normalizeSearchQuery(recording.artist) &&
    item.duration && recording.durationSec && Math.abs(item.duration / 1000 - recording.durationSec) <= 2.5 &&
    (!item.album || !recording.album || normalizeSearchQuery(item.album) === normalizeSearchQuery(recording.album))));
}

export function isCurrentSearch(request: string, active: string, aborted = false) {
  return !aborted && request === active;
}

export function activeSearchRequest(requests: SearchRequestView[], query: string) {
  const normalized = normalizeSearchQuery(query);
  return requests.find((request) => request.status === "active" && normalizeSearchQuery(request.query) === normalized) ?? null;
}

export function recordingRequestInput(token: string, requests: SearchRequestView[], query: string) {
  const request = activeSearchRequest(requests, query);
  return request ? { token, searchRequestId: request.id } : { token };
}

export function canRetrySearchRequest(request: SearchRequestView) {
  return request.status === "active" && request.trackId === null && request.track === null &&
    (request.enrichmentStatus === "not_found" || request.enrichmentStatus === "ambiguous" || request.enrichmentStatus === "failed");
}

export function canCancelSearchRequest(request: SearchRequestView) {
  return request.status === "active" && request.trackId === null && request.track === null;
}

export function searchRequestStatusLabel(request: SearchRequestView) {
  if (request.status === "cancelled") return "Cancelled";
  if (request.track?.playable) return "Playable · in your library";
  if (request.track) {
    if (request.track.stage === "failed") return "Requested · processing failed";
    if (request.track.stage === "ready") return "Requested · not playable yet";
    const stages: Record<string, string> = {
      queued: "queued", matching: "matching", searching: "searching", downloading: "downloading",
      importing: "importing", tagging: "preparing", scanning: "adding to your library", analyzing: "processing",
    };
    return `Requested · ${stages[request.track.stage] ?? "processing"}`;
  }
  switch (request.enrichmentStatus) {
    case "queued":
    case "running":
      return "Checking metadata";
    case "complete":
      return "Metadata match found · not playable";
    case "not_found":
      return "Not found in the catalog";
    case "ambiguous":
      return "Ambiguous · needs a choice";
    case "failed":
      return "Catalog check failed · try again";
  }
}

export const searchRequestCopy = {
  offer: "Ask Mint to check its metadata catalog for this song and keep your request. Checking does not download or play audio. To request audio, choose an identified song and press Add to library.",
  panel: "Saved requests are checked against Mint's metadata catalog. Checks never download or play audio. A song must be identified before you can add it to your library.",
};

/**
 * A miss is only a miss when the catalog actually answered. An unavailable or unconfigured catalog says nothing
 * about the song, so it never offers a saved request.
 */
export function shouldOfferSearchRequest(input: {
  query: string;
  current: boolean;
  localReady: boolean;
  localError: boolean;
  localRecordingCount: number;
  recordingsReady: boolean;
  recordingsError: boolean;
  /** Matched, requestable catalog recordings left after hiding confirmed library duplicates. */
  recordingCount: number;
  catalogStatus: CatalogCoverage["status"] | null;
  hasActiveRequest: boolean;
}) {
  return Array.from(input.query.trim()).length >= 2 && input.current && input.localReady && !input.localError &&
    input.localRecordingCount === 0 && input.recordingsReady && !input.recordingsError &&
    (input.catalogStatus === "ok" || input.catalogStatus === "lexical-only") &&
    input.recordingCount === 0 && !input.hasActiveRequest;
}

export type CatalogState = "not-configured" | "unavailable" | "empty" | "in-library" | "matched" | "related-only";

/**
 * `relevance` only means something once the catalog answered. Hybrid search always returns neighbours, so
 * "related-only" is the honest name for rows that matched none of the typed words.
 */
export function catalogState(catalog: CatalogCoverage, rows: readonly CatalogResult[], hiddenCount = 0): CatalogState {
  if (catalog.status === "not_configured") return "not-configured";
  if (catalog.status === "unavailable") return "unavailable";
  if (!rows.length) return hiddenCount > 0 ? "in-library" : "empty";
  if (rows.some((row) => row.matched)) return "matched";
  // Matched rows hidden as library duplicates must not turn into a claim that nothing matched.
  return catalog.relevance === "matched" ? "matched" : "related-only";
}

/** Hides only rows confirmed to be a library song already listed above; the server's relevance order is kept. */
export function visibleCatalogResults(local: PlayerItem[], results: readonly CatalogResult[]) {
  const rows = results.filter((row) => !row.recording || uniqueRecordings(local, [row.recording]).length > 0);
  return { rows, hiddenCount: results.length - rows.length };
}

/** A stable split of the server order; it never sorts by popularity or score. */
export function splitCatalogResults(rows: readonly CatalogResult[]) {
  return { matched: rows.filter((row) => row.matched), related: rows.filter((row) => !row.matched) };
}

const unconfirmed = "Identity unconfirmed";
export const catalogText = {
  shortQuery: "Type at least two characters to search Mint's music catalog.",
  notConfiguredTitle: "No music catalog on this server",
  notConfigured: "This Mint server has no music catalog configured, so only your library can be searched.",
  unavailableTitle: "The music catalog is unavailable right now",
  coverage: "Results come from Mint's metadata catalog. It may not include every song and entries can be out of date. Add only music you are authorized to acquire.",
  lexical: "Spelling and alias matching is reduced right now. Try the exact title or artist if you don't see your song.",
  hasMore: "There are more results than shown. Try a more specific search.",
  audio: `Metadata never downloads or plays audio. Only Add to library on an identified song requests audio; rows marked “${unconfirmed}” can't be added.`,
  closestTitle: "Closest in the catalog",
  closest: "Nothing matched exactly. These are the nearest results, which is how other spellings and aliases show up.",
  relatedTitle: "Related in the catalog",
  related: "These didn't match everything you typed.",
  unconfirmed,
} as const;

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

export function catalogUnavailableMessage(retryAfterSeconds: number | null) {
  const wait = retryAfterSeconds === null ? "Try again in a moment." : `Try again in about ${plural(retryAfterSeconds, "second")}.`;
  return `Searching your library still works. ${wait}`;
}

export function catalogEmptyMessage(state: CatalogState, query: string) {
  if (state === "empty") return `No songs in the catalog matched “${query}”.`;
  if (state === "in-library") return "Everything the catalog returned is already in your library above.";
  return null;
}

/** Fine print around the rows: coverage and degraded search first, list limits and audio rules after. */
export function catalogNotes(catalog: CatalogCoverage, state: CatalogState) {
  const answered = state !== "not-configured" && state !== "unavailable";
  const listed = state === "matched" || state === "related-only";
  return {
    intro: answered ? [catalogText.coverage, ...(catalog.status === "lexical-only" ? [catalogText.lexical] : [])] : [],
    footer: listed ? [...(catalog.hasMore ? [catalogText.hasMore] : []), catalogText.audio] : [],
  };
}

const sourceLabels = new Map([
  ["musicbrainz", "MusicBrainz"], ["listenbrainz", "ListenBrainz"], ["apple", "Apple Music"], ["youtube", "YouTube"],
  ["ytmusic", "YouTube Music"], ["spotify", "Spotify"], ["deezer", "Deezer"], ["audius", "Audius"],
  ["archive", "Internet Archive"], ["wikidata", "Wikidata"], ["soundcloud", "SoundCloud"], ["openverse", "Openverse"],
  ["discogs", "Discogs"], ["openwhyd", "Openwhyd"], ["omdb", "Openmusic Database"],
]);
export const catalogSourceLabel = (source: string) => sourceLabels.get(source) ?? source;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatFreshness(updatedAt: string | null, now: number) {
  const age = now - (updatedAt === null ? Number.NaN : Date.parse(updatedAt));
  // A timestamp well in the future cannot describe freshness, so it is unknown rather than "just now".
  if (!Number.isFinite(age) || age < -DAY) return "Update date unknown";
  const minutes = Math.floor(Math.max(age, 0) / MINUTE);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${plural(hours, "hour")} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Updated ${plural(days, "day")} ago`;
  if (days < 365) return `Updated ${plural(Math.min(11, Math.floor(days / 30)), "month")} ago`;
  return `Updated ${plural(Math.floor(days / 365), "year")} ago`;
}

export function catalogProvenance(row: Pick<CatalogResult, "source" | "updatedAt">, now: number) {
  return `${catalogSourceLabel(row.source)} · ${formatFreshness(row.updatedAt, now)}`;
}

/** Catalog popularity is attributed and dated, never a number or a play count; unknown stays absent, not zero. */
export function popularityLabel(popularity: CatalogResult["popularity"]) {
  if (!popularity) return null;
  const observed = popularity.observedAt === null ? Number.NaN : Date.parse(popularity.observedAt);
  if (!Number.isFinite(observed)) return "Popular in the catalog";
  const date = new Date(observed);
  return `Popular in the catalog · as of ${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

export function catalogSubtitle(row: Pick<CatalogResult, "artist" | "album">) {
  return [row.artist.trim() || "Unknown artist", row.album?.trim()].filter(Boolean).join(" · ");
}

/** The library line is the same wording as before the catalog; `existing.playable` always wins over a local request. */
export function recordingLibraryLabel(recording: Pick<RecordingSearchItem, "existing">, requestedStage?: string) {
  if (recording.existing?.playable) return "In your library";
  if (requestedStage !== undefined) return requestedStage === "ready" ? "In your library · Refresh results to play" : "Requested · Available once ready";
  if (recording.existing) return `Not ready · ${recording.existing.stage}`;
  return "Not in your library";
}

/** Starts with the visible label so voice control still matches it, and names the song for screen readers. */
export function recordingActionLabel(label: string, recording: Pick<RecordingSearchItem, "title" | "artist">) {
  const artist = recording.artist.trim();
  return `${label}: ${recording.title}${artist ? ` by ${artist}` : ""}`;
}
