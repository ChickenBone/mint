import {
  eligibleAudioSources, leadArtistName, preferredAudioSources, reviewableAudioSources, compareAudioSources,
  recordingDurationMatches, withInferredDurations, type RecordingIdentity,
} from "@mint/core/matching";
import { searchYoutubeScraped, type ScrapedYoutubeVideo } from "@mint/core/youtube-scrape";

/** Public YouTube search listings captured for one recording, replayed offline against the current audio policy. */
export interface RegressionEntry {
  id: string;
  /** `apple-most-played` entries come from the chart; `reported` ones are songs members saw fail. */
  source: "apple-most-played" | "reported";
  title: string;
  artist: string;
  /** Apple Music length; the replay oracle, and the catalog length in "known length" mode. */
  durationSec: number | null;
  searches: Record<string, Array<Omit<ScrapedYoutubeVideo, "watchVerified">>>;
  /** Hand labels: uploads known to be this recording, or known to be wrong. */
  label?: { accept?: string[]; reject?: string[] };
}
export interface RegressionCorpus { version: 1; capturedAt: string; entries: RegressionEntry[] }
export type ReplayOutcome = "matched" | "needs-source" | "no-source" | "not-captured";
export interface ReplayResult {
  id: string; mode: "known-length" | "unknown-length"; outcome: ReplayOutcome; videoId: string | null;
  /** Selected upload length minus the Apple length, when both are known. */
  lengthErrorSec: number | null; expectedSec: number | null; rejectedPick: boolean; queries: number;
}

class MissingCapture extends Error {}

/** Mirrors the worker's scraping path (without the optional OpenAI tie-break) using captured listings only. */
export async function replayEntry(entry: RegressionEntry, mode: ReplayResult["mode"]): Promise<ReplayResult> {
  const wanted: RecordingIdentity = { title: entry.title, artist: entry.artist, durationSec: mode === "known-length" ? entry.durationSec : null };
  const listings = new Map(Object.values(entry.searches).flat().map((video) => [video.id, video]));
  let queries = 0;
  const result = (outcome: ReplayOutcome, videoId: string | null = null): ReplayResult => {
    const length = videoId ? listings.get(videoId)?.durationSec ?? null : null;
    return { id: entry.id, mode, outcome, videoId, queries, expectedSec: entry.durationSec, rejectedPick: !!videoId && !!entry.label?.reject?.includes(videoId),
      lengthErrorSec: length !== null && entry.durationSec !== null ? Math.round((length - entry.durationSec) * 10) / 10 : null };
  };
  let found: ScrapedYoutubeVideo[];
  try {
    found = await searchYoutubeScraped(`${leadArtistName(entry.artist)} ${entry.title}`, {
      wanted, eligible: (videos) => eligibleAudioSources(wanted, videos),
      search: async (query) => {
        queries++;
        const captured = entry.searches[query];
        if (!captured) throw new MissingCapture(query);
        return captured.map((video) => ({ ...video }));
      },
      // Watch pages are not captured; the listing stands in for the verified page.
      video: async (id) => listings.get(id) ? { ...listings.get(id)! } : null,
    });
  } catch (error) {
    if (error instanceof MissingCapture) return result("not-captured");
    throw error;
  }
  const evidence = withInferredDurations(wanted, found);
  const preferred = preferredAudioSources(evidence, found);
  if (preferred.length) {
    const pick = [...preferred].sort((a, b) => compareAudioSources(evidence, a, b) || (a.rank ?? 0) - (b.rank ?? 0))[0]!;
    return result("matched", pick.id);
  }
  return result(reviewableAudioSources(evidence, found).length ? "needs-source" : "no-source");
}

export async function replayCorpus(corpus: RegressionCorpus) {
  const results: ReplayResult[] = [];
  for (const entry of corpus.entries) {
    for (const mode of ["known-length", "unknown-length"] as const) {
      if (mode === "known-length" && entry.durationSec === null) continue;
      results.push(await replayEntry(entry, mode));
    }
  }
  return results;
}

/** A pick outside the policy's widest studio-audio tolerance of Apple's length is very likely a different upload. */
export const wrongLength = (result: ReplayResult) => result.lengthErrorSec !== null && result.expectedSec !== null &&
  !recordingDurationMatches(result.expectedSec, result.expectedSec + result.lengthErrorSec, "official-audio");

export function summarizeReplay(results: ReplayResult[]) {
  const rows = (["known-length", "unknown-length"] as const).map((mode) => {
    const subset = results.filter((result) => result.mode === mode && result.outcome !== "not-captured");
    const count = (outcome: ReplayOutcome) => subset.filter((result) => result.outcome === outcome).length;
    return { mode, total: subset.length, matched: count("matched"), needsSource: count("needs-source"), noSource: count("no-source"),
      wrongLength: subset.filter(wrongLength).length, rejectedPicks: subset.filter((result) => result.rejectedPick).length,
      averageQueries: subset.length ? Math.round(subset.reduce((sum, result) => sum + result.queries, 0) / subset.length * 10) / 10 : 0 };
  });
  return rows;
}
