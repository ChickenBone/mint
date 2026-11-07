import { CLEAN_RECORDING_INSTRUCTIONS, isPreviewUpload, recordingUploadKind } from "@mint/core/matching";

const VERSIONS = ["live", "remix", "cover", "karaoke", "instrumental", "remaster", "remastered", "acoustic", "demo", "extended", "visualizer", "lyrics", "lyric", "sped", "slowed", "nightcore"];
const DECISIONS_URL = "https://api.openai.com/v1/decisions";

export interface CatalogRecording {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number | null;
}

export interface CatalogVideo {
  id: string;
  title: string;
  channel: string;
  durationSec: number | null;
  rank: number;
}

export type RequestChoice =
  | { kind: "recording"; recording: CatalogRecording; videoId: string | null }
  | { kind: "video"; video: CatalogVideo };

interface Pair {
  recording: CatalogRecording;
  video: CatalogVideo;
  score: number;
}

export function normalizeMatchText(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function words(value: string) {
  return normalizeMatchText(value).split(" ").filter(Boolean);
}

function primaryArtist(artist: string) {
  return artist.split(/\s+(?:feat\.?|ft\.?)\s+|,/i)[0]?.trim() || artist;
}

function artistCredits(artist: string) {
  return artist.split(/\s+(?:feat\.?|ft\.?|&|x)\s+|,/i).map((credit) => normalizeMatchText(credit)).filter(Boolean);
}

/** A Topic upload often names only the first artist of a collaboration. */
function artistsMatch(wanted: string, found: string) {
  const wantedCredits = artistCredits(wanted);
  const foundCredits = artistCredits(found);
  if (!wantedCredits.length || !foundCredits.length) return false;
  if (normalizeMatchText(wanted) === normalizeMatchText(found)) return true;
  return foundCredits.every((credit) => wantedCredits.includes(credit)) && foundCredits.includes(wantedCredits[0]!);
}

function phraseIn(phrase: string, text: string) {
  const wanted = words(phrase).join(" ");
  return Boolean(wanted) && words(text).join(" ").includes(wanted);
}

/** Chart titles often append the featured artists. The song title is the part before that credit. */
function coreTitle(value: string) {
  const normalized = normalizeMatchText(value).replace(/\s+(?:feat|ft|featuring)\b.*$/, "").trim();
  return normalized || normalizeMatchText(value);
}

function versionClash(wanted: string, title: string) {
  const allowed = new Set(words(wanted));
  return VERSIONS.some((word) => !allowed.has(word) && words(title).includes(word));
}

/** Official uploads may run longer than the audio duration printed on a chart. */
export function videoMatchesRequest(wanted: { title: string; artist: string; durationSec: number | null }, video: CatalogVideo) {
  const identity = identityFromVideo(video);
  if (!identity || isPreviewUpload(video.title) || versionClash(wanted.title, video.title)) return false;
  if (coreTitle(identity.title) !== coreTitle(wanted.title)) return false;
  if (!artistsMatch(wanted.artist, identity.artist)) return false;
  if (!wanted.durationSec || video.durationSec === null) return true;
  const official = officialScore(video) > 0 || phraseIn(identity.artist, video.channel);
  return Math.abs(wanted.durationSec - video.durationSec) <= (official ? 15 : 2.5);
}

export function identityFromVideo(video: Pick<CatalogVideo, "title" | "channel">) {
  const bare = video.title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  const channel = video.channel.replace(/\s*-\s*topic$/i, "").replace(/vevo$/i, "").replace(/\s+official$/i, "").trim();
  const parts = bare.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const [left, right] = [parts[0]!, parts.slice(1).join(" - ")];
    const leftIsArtist = phraseIn(channel, left) || phraseIn(left, channel);
    const rightIsArtist = phraseIn(channel, right) || phraseIn(right, channel);
    if (rightIsArtist && !leftIsArtist) return { artist: right, title: left };
    return { artist: left, title: right };
  }
  if (!bare || !channel) return null;
  return { artist: channel, title: bare };
}

function officialScore(video: CatalogVideo) {
  const channel = normalizeMatchText(video.channel);
  const title = normalizeMatchText(video.title);
  return (channel.endsWith("vevo") ? 4 : 0) + (title.includes("official audio") || title.includes("official video") ? 2 : 0) + (channel.includes("topic") ? 1 : 0);
}

function supportScore(recording: CatalogRecording, video: CatalogVideo) {
  const artist = primaryArtist(recording.artist);
  const titleWords = words(recording.title);
  if (!titleWords.length || !titleWords.every((word) => words(video.title).includes(word))) return null;
  if (!phraseIn(artist, video.title) && !phraseIn(artist, video.channel)) return null;
  if (versionClash(recording.title, video.title)) return null;
  if (recording.durationSec && video.durationSec !== null && Math.abs(recording.durationSec - video.durationSec) > 2.5) return null;
  if (recording.durationSec && video.durationSec === null) return null;
  const duration = recording.durationSec && video.durationSec !== null ? 3 : 0;
  const rank = video.rank === 0 ? 3 : video.rank === 1 ? 2 : video.rank === 2 ? 1 : 0;
  const score = officialScore(video) + duration + (phraseIn(artist, video.channel) ? 2 : 0) + rank;
  const official = officialScore(video) > 0;
  if (recording.durationSec) return score >= 6 ? score : null;
  return official && video.rank <= 1 && score >= 6 ? score : null;
}

function pairs(recordings: CatalogRecording[], videos: CatalogVideo[]) {
  return recordings.flatMap((recording) => {
    const supported = videos.flatMap((video) => {
      const score = supportScore(recording, video);
      return score === null ? [] : [{ recording, video, score }];
    }).sort((a, b) => b.score - a.score || a.video.rank - b.video.rank);
    const [best, next] = supported;
    if (!best || (next && best.score === next.score)) return [];
    return [best];
  }).sort((a, b) => b.score - a.score);
}

function identityMatchesQuery(query: string, video: CatalogVideo) {
  const identity = identityFromVideo(video);
  if (!identity) return false;
  const queryText = words(query).join(" ");
  const identityWords = new Set([...words(identity.artist), ...words(identity.title)]);
  return phraseIn(identity.title, queryText) && phraseIn(identity.artist, queryText) && words(query).every((word) => identityWords.has(word));
}

function cleanStudioAudio(video: CatalogVideo) {
  return !isPreviewUpload(video.title) && recordingUploadKind(video.title, video.channel) === "clean studio audio";
}

function primaryArtistAudio(query: string, video: CatalogVideo) {
  const identity = identityFromVideo(video);
  if (!identity || versionClash(query, video.title) || !phraseIn(identity.title, query)) return false;
  const artist = words(identity.artist).join(" ");
  return Boolean(artist) && words(query).join(" ").startsWith(artist);
}

function videoOnly(query: string, videos: CatalogVideo[]): CatalogVideo | null {
  const wanted = words(query);
  const supported = videos.flatMap((video) => {
    if (!wanted.length || isPreviewUpload(video.title) || versionClash(query, video.title)) return [];
    const identity = identityFromVideo(video);
    const identified = identityMatchesQuery(query, video) || primaryArtistAudio(query, video);
    const text = `${video.title} ${video.channel}`;
    if (!identified && !wanted.every((word) => words(text).includes(word))) return [];
    const artistChannel = Boolean(identity && phraseIn(identity.artist, video.channel));
    if (video.rank > 1 || officialScore(video) === 0 && !artistChannel) return [];
    const clean = cleanStudioAudio(video) ? 5 : 0;
    const score = officialScore(video) + clean + (artistChannel ? 2 : 0) + (identified ? 3 : 0) + (video.rank === 0 ? 3 : 2);
    return score >= 4 ? [{ video, score }] : [];
  }).sort((a, b) => b.score - a.score || a.video.rank - b.video.rank);
  const [best, next] = supported;
  if (!best || (next && best.score - next.score < 2 && Math.abs((best.video.durationSec ?? 0) - (next.video.durationSec ?? 0)) > 2.5)) return null;
  return best.video;
}

function recordingOnly(query: string, recordings: CatalogRecording[]): CatalogRecording | null {
  const text = words(query).join(" ");
  const matches = recordings.filter((recording) => phraseIn(recording.title, text) && phraseIn(primaryArtist(recording.artist), text));
  const distinct = new Map(matches.map((recording) => [`${normalizeMatchText(recording.title)} ${normalizeMatchText(primaryArtist(recording.artist))}`, recording]));
  return distinct.size === 1 ? [...distinct.values()][0]! : null;
}

/** Confident recording/video choice. A tie or a weak candidate returns null. */
export function chooseRequestMatch(query: string, recordings: CatalogRecording[], videos: CatalogVideo[] | null): RequestChoice | null {
  if (videos?.length) {
    const ranked = pairs(recordings, videos);
    const [best, next] = ranked;
    if (best && (!next || best.score - next.score >= 2)) return { kind: "recording", recording: best.recording, videoId: best.video.id };
    if (ranked.some((pair) => pair.score >= 6)) return null;
    const video = videoOnly(query, videos);
    return video ? { kind: "video", video } : null;
  }
  const recording = recordingOnly(query, recordings);
  return recording ? { kind: "recording", recording, videoId: null } : null;
}

function choiceDescription(video: CatalogVideo) {
  const duration = video.durationSec ?? "unknown";
  return `${video.title}; channel: ${video.channel}; duration: ${duration} seconds; ${recordingUploadKind(video.title, video.channel)}`;
}

export function decisionChoices(query: string, recordings: CatalogRecording[], videos: CatalogVideo[]) {
  const cleanVideos = videos.filter((video) => cleanStudioAudio(video) && primaryArtistAudio(query, video));
  const pairPool = cleanVideos.length ? pairs(recordings, videos).filter((pair) => cleanStudioAudio(pair.video)) : pairs(recordings, videos);
  const paired = pairPool.slice(0, 8).map((pair) => ({
    value: `rec:${pair.recording.id}|vid:${pair.video.id}`,
    description: `${pair.recording.title} by ${pair.recording.artist}, ${pair.recording.durationSec ?? "unknown"}s; video ${choiceDescription(pair.video)}`,
  }));
  const used = new Set(paired.map((choice) => choice.value.split("|vid:")[1]));
  const loose = videos.filter((video) => !used.has(video.id) && !versionClash(query, video.title) && (primaryArtistAudio(query, video) || words(query).every((word) => words(`${video.title} ${video.channel}`).includes(word))));
  const official = loose.filter((video) => recordingUploadKind(video.title, video.channel) === "music video");
  const offered = (cleanVideos.length
    ? loose.filter((video) => cleanStudioAudio(video) && primaryArtistAudio(query, video))
    : official.length ? official : loose).slice(0, Math.max(0, 8 - paired.length));
  return [
    ...paired,
    ...offered.map((video) => ({ value: `vid:${video.id}`, description: choiceDescription(video) })),
    { value: "none", description: "None of these is this song's studio recording." },
  ];
}

export function choiceFromDecision(value: string, recordings: CatalogRecording[], videos: CatalogVideo[]): RequestChoice | null {
  if (value === "none") return null;
  const recordingMatch = /^rec:([^|]+)\|vid:([A-Za-z0-9_-]{11})$/.exec(value);
  if (recordingMatch) {
    const recording = recordings.find((item) => item.id === recordingMatch[1]);
    const video = videos.find((item) => item.id === recordingMatch[2]);
    return recording && video ? { kind: "recording", recording, videoId: video.id } : null;
  }
  const video = videos.find((item) => item.id === value.replace(/^vid:/, ""));
  return video ? { kind: "video", video } : null;
}

export async function matchMissingRequest(input: {
  query: string;
  recordings: CatalogRecording[];
  videos: CatalogVideo[] | null;
  durationSec?: number | null;
  model?: { enabled: boolean; apiKey: string | null };
  fetcher?: typeof fetch;
}): Promise<RequestChoice | null> {
  const deterministic = chooseRequestMatch(input.query, input.recordings, input.videos);
  if (!input.model?.enabled || !input.model.apiKey || !input.videos?.length) return deterministic;
  const choices = decisionChoices(input.query, input.recordings, input.videos);
  if (choices.length < 2) return deterministic;
  try {
    const response = await (input.fetcher ?? fetch)(DECISIONS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${input.model.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
        model: "gpt-6-luna",
        input: [{ role: "user", content: [
          { type: "input_text", text: input.durationSec
            ? `Choose the clean studio audio for this search. The song is ${Math.round(input.durationSec)} seconds. Stay away from music videos.`
            : "Choose the clean studio audio for this search. Stay away from music videos." },
          { type: "input_json", data: {
            query: input.query,
            ...(input.durationSec ? { durationSec: Math.round(input.durationSec) } : {}),
            recordings: input.recordings.slice(0, 25),
            videos: input.videos.slice(0, 10),
          } },
        ] }],
        questions: [{
          type: "choice",
          name: "recording",
          instructions: CLEAN_RECORDING_INSTRUCTIONS,
          choices,
        }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return deterministic;
    const body = await response.json() as { answers?: Array<{ name?: string; choice?: string; confidence?: number; probabilities?: Array<{ value: string; probability: number }> }> };
    const answer = body.answers?.find((item) => item.name === "recording");
    const selected = answer?.probabilities?.find((item) => item.value === answer.choice)?.probability;
    const runnerUp = [...(answer?.probabilities ?? [])].sort((a, b) => b.probability - a.probability).find((item) => item.value !== answer?.choice)?.probability ?? 0;
    if (!answer?.choice || answer.confidence === undefined || selected === undefined || answer.confidence < 0.65 || selected - runnerUp < 0.15) return null;
    if (answer.choice === "none") return null;
    return choiceFromDecision(answer.choice, input.recordings, input.videos);
  } catch {
    return deterministic;
  }
}

