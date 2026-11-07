import { z } from "zod";
import type { PlayerItem } from "./player-protocol";

export const chartEntrySchema = z.object({
  id: z.string().min(1).max(200), rank: z.number().int().min(1).max(50),
  title: z.string().min(1).max(1000), artist: z.string().min(1).max(1000),
  album: z.string().max(1000).nullable(), durationSec: z.number().positive().max(86400).nullable(),
  recordingId: z.uuid().nullable(), isrc: z.string().max(100).nullable().transform((value) => value?.replaceAll("-", "").toUpperCase() ?? null),
  url: z.url().max(2048), artwork: z.url().max(2048).nullable(), genres: z.array(z.string().max(100)).max(30),
});
export type ChartEntry = z.infer<typeof chartEntrySchema>;
export type ChartProvider = "apple" | "listenbrainz" | "audius";
export interface ChartDefinition {
  id: string; provider: ChartProvider; providerName: string; title: string; territory: string;
  description: string; url: string; country?: string; genre?: string;
}
export const CHARTS: ChartDefinition[] = [
  ...[["us", "United States"], ["gb", "United Kingdom"], ["ca", "Canada"], ["au", "Australia"], ["jp", "Japan"], ["de", "Germany"], ["fr", "France"]].map(([country, territory]) => ({
    id: `apple-${country}`, provider: "apple" as const, providerName: "Apple Music", title: `${territory} Top 50`,
    territory: territory!, country: country!, description: "Most-played songs in this Apple Music storefront. Apple does not publish the ranking window.",
    url: "https://rss.marketingtools.apple.com/",
  })),
  { id: "listenbrainz-week", provider: "listenbrainz", providerName: "ListenBrainz", title: "Community Top 50",
    territory: "Worldwide · ListenBrainz listeners", description: "Sitewide recordings ranked by submitted listens. An international community chart, not a worldwide industry chart.",
    url: "https://listenbrainz.org/charts/" },
  ...[undefined, "Electronic", "Hip-Hop/Rap", "Pop", "Rock", "Jazz"].map((genre) => ({
    id: genre ? `audius-${genre.toLowerCase().replace(/[^a-z]+/g, "-")}` : "audius-week",
    provider: "audius" as const, providerName: "Audius", title: genre ? `${genre} trending` : "Independent Top 50",
    territory: "Worldwide · Audius", genre, description: "Weekly trending tracks across Audius. Provider ranking, not a chart of all recorded music.",
    url: "https://audius.co/trending",
  })),
];
export const chartSnapshotSchema = z.object({
  entries: z.array(chartEntrySchema).max(50), period: z.string().max(300),
  providerUpdatedAt: z.iso.datetime().nullable(), fetchedAt: z.iso.datetime(), revision: z.string().max(100),
  notice: z.string().max(1000).nullable(),
});
export type ChartSnapshot = z.infer<typeof chartSnapshotSchema>;
export type ChartAvailability = "available" | "missing" | "ambiguous" | "requested" | "processing" | "failed";
export interface ChartRow extends ChartEntry {
  availability: ChartAvailability; reason: string; progress: number | null;
  item: PlayerItem | null;
}
export interface ChartPage {
  chart: ChartDefinition; status: "fresh" | "stale" | "empty" | "error";
  period: string | null; providerUpdatedAt: string | null; fetchedAt: string | null;
  revision: string | null; notice: string | null; retryAt: string | null;
  items: ChartRow[]; offset: number; total: number; nextOffset: number | null; member: boolean;
}
export const chartKey = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const coreChartTitle = (value: string) => chartKey(value).replace(/\s+(?:feat|ft|featuring)\b.*$/, "").trim() || chartKey(value);
export const chartIdentity = (entry: ChartEntry) => JSON.stringify([entry.title, entry.artist, entry.album, entry.durationSec, entry.recordingId, entry.isrc]);

export interface ChartCandidate {
  id: string; title: string; artist: string; album: string | null; durationSec: number | null; mbRecordingId: string | null;
  stage: string; playable: boolean; progress: number;
}
interface ChartRecordingCandidate {
  title: string; artist: string; durationSec: number | null; id?: string; isrcs?: string[]; album?: string | null;
}
export function compatibleChartRecording(entry: ChartEntry, candidate: ChartRecordingCandidate) {
  return chartKey(entry.title) === chartKey(candidate.title) && chartKey(entry.artist) === chartKey(candidate.artist)
    && (!entry.recordingId || !candidate.id || entry.recordingId === candidate.id)
    && (!entry.isrc || !candidate.isrcs?.length || candidate.isrcs.includes(entry.isrc))
    && (!entry.durationSec || !candidate.durationSec || Math.abs(entry.durationSec - candidate.durationSec) <= 2.5);
}
export function confidentChartRecording(entry: ChartEntry, candidate: ChartRecordingCandidate) {
  if (!compatibleChartRecording(entry, candidate)) return false;
  const recordingIdentity = !!entry.recordingId && entry.recordingId === candidate.id;
  const isrcIdentity = !!entry.isrc && !!candidate.isrcs?.includes(entry.isrc);
  const durationMatch = entry.durationSec !== null && candidate.durationSec !== null;
  // An absent album is not a conflict, but duration alone cannot identify an unknown edition.
  const albumMatch = !entry.album || (candidate.album
    ? chartKey(entry.album) === chartKey(candidate.album)
    : recordingIdentity || isrcIdentity);
  return (recordingIdentity || isrcIdentity || durationMatch) && (!entry.isrc || isrcIdentity) && !!albumMatch;
}
export function chartRecordingResolution<T extends ChartRecordingCandidate>(entry: ChartEntry, candidates: T[], localAmbiguous = false) {
  const results = candidates.filter((candidate) => compatibleChartRecording(entry, candidate));
  const confident = results.filter((candidate) => confidentChartRecording(entry, candidate));
  return { results, automatic: !localAmbiguous && confident.length === 1 ? confident[0]! : null };
}
export function matchChartEntry(entry: ChartEntry, candidates: ChartCandidate[], linkedTrackId?: string) {
  const identity = candidates.filter((candidate) => compatibleChartRecording(entry, { ...candidate, id: candidate.mbRecordingId ?? undefined }));
  const linked = identity.find((candidate) => candidate.id === linkedTrackId)
    ?? candidates.find((candidate) => candidate.id === linkedTrackId && coreChartTitle(candidate.title) === coreChartTitle(entry.title));
  const matches = linked ? [linked] : identity.filter((candidate) =>
    (!entry.recordingId || candidate.mbRecordingId === entry.recordingId) &&
    // The library index has no ISRC field; it must not claim to have verified one.
    confidentChartRecording({ ...entry, isrc: null }, { ...candidate, id: candidate.mbRecordingId ?? undefined }));
  if (matches.length > 1 || !matches.length && identity.length) return {
    availability: "ambiguous" as const, trackId: null, progress: null,
    reason: "Recording or edition is uncertain. Choose the exact recording before requesting or playing.",
  };
  const found = matches[0];
  if (!found) return { availability: "missing" as const, trackId: null, progress: null, reason: "Not available in your local library." };
  const availability: ChartAvailability = found.playable ? "available" : found.stage === "failed" ? "failed" : found.stage === "queued" ? "requested" : "processing";
  return { availability, trackId: found.id, progress: found.progress, reason: {
    available: "Available in Mint", failed: "Acquisition failed. Review the source or retry in Jobs.",
    requested: "Already requested. Waiting for acquisition.", processing: `Acquiring · ${found.stage}`,
  }[availability] };
}

export type ChartRequestOutcome = { status: "available" | "requested" | "resolve" } | { status: "error"; message: string };
/** Decides how a finished request may affect the UI; `current` is false once the member has changed chart, page or reloaded. */
export function chartRequestEffect(current: boolean, title: string, outcome: ChartRequestOutcome) {
  const none = { resolve: false, rowError: null as string | null, markRequested: false, refresh: false, notice: "", error: "" };
  if (current) {
    if (outcome.status === "resolve") return { ...none, resolve: true };
    if (outcome.status === "error") return { ...none, rowError: outcome.message };
    if (outcome.status === "available") return { ...none, refresh: true, notice: `${title} is already in your library.` };
    return { ...none, markRequested: true, refresh: true, notice: "Request sent." };
  }
  if (outcome.status === "resolve") return { ...none, notice: `Pick a version of ${title} to add it.` };
  if (outcome.status === "error") return { ...none, error: `Couldn’t add ${title}. ${outcome.message}` };
  if (outcome.status === "available") return { ...none, notice: `${title} is already in your library.` };
  return { ...none, notice: `Request sent for ${title}.` };
}
