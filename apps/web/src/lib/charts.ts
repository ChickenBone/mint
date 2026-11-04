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
export const chartIdentity = (entry: ChartEntry) => JSON.stringify([entry.title, entry.artist, entry.album, entry.durationSec, entry.recordingId, entry.isrc]);

export interface ChartCandidate {
  id: string; title: string; artist: string; album: string | null; durationSec: number | null; mbRecordingId: string | null;
  stage: string; playable: boolean; progress: number;
}
export function compatibleChartRecording(entry: ChartEntry, candidate: { title: string; artist: string; durationSec: number | null; id?: string; isrcs?: string[] }) {
  return chartKey(entry.title) === chartKey(candidate.title) && chartKey(entry.artist) === chartKey(candidate.artist)
    && (!entry.recordingId || !candidate.id || entry.recordingId === candidate.id)
    && (!entry.isrc || !candidate.isrcs?.length || candidate.isrcs.includes(entry.isrc))
    && (!entry.durationSec || !candidate.durationSec || Math.abs(entry.durationSec - candidate.durationSec) <= 2.5);
}
export function matchChartEntry(entry: ChartEntry, candidates: ChartCandidate[], linkedTrackId?: string) {
  const identity = candidates.filter((candidate) => compatibleChartRecording(entry, { ...candidate, id: candidate.mbRecordingId ?? undefined }));
  const linked = identity.find((candidate) => candidate.id === linkedTrackId);
  const matches = linked ? [linked] : identity.filter((candidate) =>
    (!entry.recordingId || candidate.mbRecordingId === entry.recordingId) &&
    (entry.recordingId || entry.durationSec && candidate.durationSec) &&
    (!entry.album || candidate.album && chartKey(entry.album) === chartKey(candidate.album)));
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
