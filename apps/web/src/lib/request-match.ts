import { CLEAN_RECORDING_INSTRUCTIONS, audioSourceRejection, compareAudioSources, normalizeRecordingText,
  eligibleAudioSources, preferredAudioSources, recordingIdentityFromVideo, recordingUploadKind, sameRecordingVersion, sourceSelectionMessage, type AudioCandidate } from "@mint/core/matching";

const DECISIONS_URL = "https://api.openai.com/v1/decisions";

export interface CatalogRecording {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number | null;
}

export interface CatalogVideo extends AudioCandidate {
  /** Provider relevance position, never a popularity measurement. */
  rank: number;
  /** Public watch metadata was checked during this search, not inferred from the result title. */
  watchVerified?: boolean;
}

export type RequestChoice =
  | { kind: "recording"; recording: CatalogRecording; videoId: string | null }
  | { kind: "video"; video: CatalogVideo };

export const normalizeMatchText = normalizeRecordingText;
export const identityFromVideo = recordingIdentityFromVideo;

function words(value: string) {
  return normalizeMatchText(value).split(" ").filter(Boolean);
}

function phraseIn(phrase: string, text: string) {
  const wanted = words(phrase).join(" ");
  return Boolean(wanted) && ` ${words(text).join(" ")} `.includes(` ${wanted} `);
}

export function videoMatchesRequest(wanted: { title: string; artist: string; durationSec: number | null }, video: CatalogVideo, explicitPin = false) {
  return !audioSourceRejection(wanted, video, explicitPin);
}

function matchesDuration(video: CatalogVideo, durationSec: number | null, explicitPin = false) {
  if (durationSec === null) return true;
  const identity = identityFromVideo(video);
  return Boolean(identity && !audioSourceRejection({ ...identity, durationSec }, video, explicitPin));
}

function recordingOnly(query: string, recordings: CatalogRecording[]): CatalogRecording | null {
  const matches = namedRecordings(query, recordings);
  // Distinct recording IDs/editions must not collapse just because the display names match.
  return matches.length === 1 ? matches[0]! : null;
}

function queryIdentity(query: string, video: CatalogVideo) {
  const identity = identityFromVideo(video);
  const title = identity?.title.replace(/\s*[\[(]?(?:feat\.?|ft\.?|featuring)\b.*$/i, "").trim();
  if (!identity || !title || !phraseIn(title, query) || !sameRecordingVersion(query, video.title)) return null;
  const primary = identity.artist.split(/\s+(?:feat\.?|ft\.?|&|\/)\s+|,/i)[0]!;
  const featured = /\b(?:feat\.?|ft\.?|featuring)\s+(.+?)(?:\)|\]|$)/i.exec(identity.title)?.[1];
  if (![identity.artist, ...(featured ? [featured] : [])].every((credit) =>
    credit.split(/\s+(?:feat\.?|ft\.?|featuring|&|\/|x)\s+|,/i).every((artist) => phraseIn(artist, query)))) return null;
  const known = new Set([...words(identity.artist), ...words(identity.title)]);
  const extras = words(query).filter((word) => !known.has(word));
  if (extras.length && (!normalizeMatchText(query).startsWith(normalizeMatchText(primary)) ||
    !/\s(?:&|\/|feat\.?|ft\.?|featuring)\s|,/.test(query))) return null;
  return { ...identity, durationSec: null };
}

function queryVideos(query: string, videos: CatalogVideo[], durationSec: number | null = null, explicitPin = false) {
  const supported = videos.filter((video) => {
    const identity = queryIdentity(query, video);
    return identity && !audioSourceRejection({ ...identity, durationSec }, video, explicitPin);
  });
  const first = supported[0];
  if (!first) return [];
  const wanted = { title: query, artist: "", durationSec };
  const ranked = [...supported].sort((a, b) => compareAudioSources(wanted, a, b));
  const best = ranked[0]!;
  return ranked.filter((video) => compareAudioSources(wanted, best, video) === 0);
}

function pairs(recordings: CatalogRecording[], videos: CatalogVideo[], explicitPin = false) {
  const supported = recordings.flatMap((recording) => preferredAudioSources(recording, videos, explicitPin).map((video) => ({ recording, video })));
  const identity = { title: "", artist: "", durationSec: null };
  const best = [...supported].sort((a, b) => compareAudioSources(identity, a.video, b.video))[0];
  return best ? supported.filter((pair) => compareAudioSources(identity, best.video, pair.video) === 0) : [];
}

function namedRecordings(query: string, recordings: CatalogRecording[]) {
  return recordings.filter((recording) => {
    const known = new Set([...words(recording.artist), ...words(recording.title), "feat", "ft", "featuring", "x", "and"]);
    return words(query).every((word) => known.has(word)) && sameRecordingVersion(query, recording.title) &&
      phraseIn(recording.title.replace(/\s*[\[(]?(?:feat\.?|ft\.?|featuring)\b.*$/i, "").trim(), query) &&
      phraseIn(recording.artist.split(/\s+(?:feat\.?|ft\.?|&|\/)\s+|,/i)[0]!, query);
  });
}

export function requestMatchMessage(query: string, recordings: CatalogRecording[], videos: CatalogVideo[], durationSec: number | null = null) {
  const named = namedRecordings(query, recordings);
  const inferred = videos.map((video) => queryIdentity(query, video)).find((identity) => identity !== null);
  const expected = named[0] ?? { title: inferred?.title ?? query, artist: inferred?.artist ?? "", durationSec };
  return sourceSelectionMessage(expected, videos);
}

export function requestAudioCandidates(query: string, recordings: CatalogRecording[], videos: CatalogVideo[], durationSec: number | null = null) {
  const named = namedRecordings(query, recordings);
  return named.length ? named.flatMap((recording) => eligibleAudioSources(recording, videos.filter((video) => matchesDuration(video, durationSec))))
    : queryVideos(query, videos, durationSec);
}

/** Source tiers never yield to relevance rank, model preference or a music video's duration. */
export function chooseRequestMatch(query: string, recordings: CatalogRecording[], videos: CatalogVideo[] | null, durationSec: number | null = null, explicitPin = false): RequestChoice | null {
  if (!videos?.length) {
    const recording = recordingOnly(query, recordings);
    return recording ? { kind: "recording", recording, videoId: null } : null;
  }
  const named = namedRecordings(query, recordings);
  const supported = pairs(named, videos.filter((video) => matchesDuration(video, durationSec, explicitPin)), explicitPin);
  if (supported.length === 1) {
    const best = supported[0]!;
    return { kind: "recording", recording: best.recording, videoId: best.video.id };
  }
  if (supported.length || named.length) return null;
  const preferred = queryVideos(query, videos, durationSec, explicitPin);
  return preferred.length === 1 ? { kind: "video", video: preferred[0]! } : null;
}

function choiceDescription(video: CatalogVideo) {
  return `${video.title}; channel: ${video.channel}; duration: ${video.durationSec ?? "unknown"} seconds; views: ${video.viewCount ?? "unknown"}; ${recordingUploadKind(video.title, video.channel)}`;
}

export function decisionChoices(query: string, recordings: CatalogRecording[], videos: CatalogVideo[], durationSec: number | null = null, explicitPin = false) {
  const named = namedRecordings(query, recordings);
  const supported = pairs(named, videos.filter((video) => matchesDuration(video, durationSec, explicitPin)), explicitPin);
  const paired = supported.slice(0, 8).map((pair) => ({
    value: `rec:${pair.recording.id}|vid:${pair.video.id}`,
    description: `${pair.recording.title} by ${pair.recording.artist}, ${pair.recording.durationSec ?? "unknown"}s; ${choiceDescription(pair.video)}`,
  }));
  const loose = supported.length || named.length ? [] : queryVideos(query, videos, durationSec, explicitPin).slice(0, 8);
  return [...paired, ...loose.map((video) => ({ value: `vid:${video.id}`, description: choiceDescription(video) })),
    { value: "none", description: "None of these is this song's studio recording." }];
}

export function choiceFromDecision(value: string, recordings: CatalogRecording[], videos: CatalogVideo[], query?: string, durationSec: number | null = null, explicitPin = false): RequestChoice | null {
  if (value === "none") return null;
  const recordingMatch = /^rec:([^|]+)\|vid:([A-Za-z0-9_-]{11})$/.exec(value);
  if (recordingMatch) {
    const recording = recordings.find((item) => item.id === recordingMatch[1]);
    const video = videos.find((item) => item.id === recordingMatch[2]);
    return recording && video && videoMatchesRequest(recording, video, explicitPin) ? { kind: "recording", recording, videoId: video.id } : null;
  }
  const video = videos.find((item) => item.id === value.replace(/^vid:/, ""));
  return video && query && queryVideos(query, [video], durationSec, explicitPin).length === 1 ? { kind: "video", video } : null;
}

export async function matchMissingRequest(input: {
  query: string;
  recordings: CatalogRecording[];
  videos: CatalogVideo[] | null;
  durationSec?: number | null;
  explicitPin?: boolean;
  model?: { enabled: boolean; apiKey: string | null };
  fetcher?: typeof fetch;
}): Promise<RequestChoice | null> {
  const deterministic = chooseRequestMatch(input.query, input.recordings, input.videos, input.durationSec ?? null, input.explicitPin);
  if (!input.model?.enabled || !input.model.apiKey || !input.videos?.length) return deterministic;
  const choices = decisionChoices(input.query, input.recordings, input.videos, input.durationSec ?? null, input.explicitPin);
  if (choices.length < 2) return deterministic;
  try {
    const response = await (input.fetcher ?? fetch)(DECISIONS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${input.model.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: "gpt-6-luna",
        input: [{ role: "user", content: [
          { type: "input_text", text: "Choose only among the offered safety-checked recordings. Never choose a music video." },
          { type: "input_json", data: { query: input.query, durationSec: input.durationSec ?? null } },
        ] }],
        questions: [{ type: "choice", name: "recording", instructions: CLEAN_RECORDING_INSTRUCTIONS, choices }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`OpenAI Decisions returned ${response.status}`);
    const body = await response.json() as { answers?: Array<{ name?: string; choice?: string; confidence?: number; probabilities?: Array<{ value: string; probability: number }> }> };
    const answer = body.answers?.find((item) => item.name === "recording");
    const selected = answer?.probabilities?.find((item) => item.value === answer.choice)?.probability;
    const runnerUp = [...(answer?.probabilities ?? [])].sort((a, b) => b.probability - a.probability).find((item) => item.value !== answer?.choice)?.probability ?? 0;
    if (!answer?.choice || typeof answer.confidence !== "number" || typeof selected !== "number" ||
      !Number.isFinite(answer.confidence) || answer.confidence < 0.65 || answer.confidence > 1 ||
      !answer.probabilities?.every((item) => Number.isFinite(item.probability) && item.probability >= 0 && item.probability <= 1) ||
      selected - runnerUp < 0.15) return null;
    if (answer.choice === "none") return null;
    if (!choices.some((choice) => choice.value === answer.choice)) {
      console.error("OpenAI selected an unoffered or unsafe source; using deterministic audio matching");
      return deterministic;
    }
    return choiceFromDecision(answer.choice, input.recordings, input.videos, input.query, input.durationSec ?? null, input.explicitPin);
  } catch {
    console.error("OpenAI recording matching unavailable; using deterministic audio matching");
    return deterministic;
  }
}
