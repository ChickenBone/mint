import "server-only";
import { z } from "zod";
import { getDb, schema } from "@mint/core/db";
import { getMatchingDecision } from "@mint/core/matching-db";
import { MusicError } from "@mint/core/music";
import { sameRecordingVersion } from "@mint/core/matching";
import { youtubeScrapingAuthorized } from "@mint/core/youtube-scrape";
import { and, eq, sql } from "drizzle-orm";
import { youtubeSource } from "./music-requests";
import { identityFromVideo, matchMissingRequest, normalizeMatchText, requestAudioCandidates, requestMatchMessage, videoMatchesRequest, type CatalogRecording, type CatalogVideo, type RequestChoice } from "./request-match";
import { linkedYouTubeVideo, searchLinkedYouTube } from "./youtube-search";

export class NeedsVideoError extends MusicError {
  constructor(linked: boolean, message?: string) {
    super(message ?? (linked
      ? "Mint could not confidently match this search to one recording. Paste the YouTube video URL."
      : "Mint could not confidently match this search. Link YouTube in Settings, or paste the YouTube video URL."), 409);
  }
}

const quoted = (value: string) => `"${value.replace(/["\\]/g, " ").slice(0, 200)}"`;
const escaped = (value: string) => value.replace(/(["\\+\-!(){}[\]^~*?:/]|&&|\|\|)/g, "\\$1");

async function readBoundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new MusicError("The recording catalog returned an empty response.", 503);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) {
        await reader.cancel();
        throw new MusicError("The recording catalog response was too large.", 503);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function catalogRecordings(query: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<CatalogRecording[]> {
  signal?.throwIfAborted();
  const url = new URL("https://musicbrainz.org/ws/2/recording");
  url.search = new URLSearchParams({ query, fmt: "json", limit: "25" }).toString();
  const response = await fetcher(url, {
    headers: { "user-agent": process.env.MUSICBRAINZ_USER_AGENT ?? "Mint/3.5 ( https://github.com/ChickenBone/mint )", accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new MusicError(response.status === 429 || response.status === 503 ? "MusicBrainz is busy. Wait a few seconds and search again." : "The recording catalog could not be reached. Try again.", 503);
  const body = await readBoundedJson(response);
  const raw = z.object({ recordings: z.array(z.object({
    id: z.uuid(), title: z.string(), length: z.number().nullish(), video: z.boolean().optional(), disambiguation: z.string().optional(),
    "artist-credit": z.array(z.object({ name: z.string() })).optional(),
    releases: z.array(z.object({ title: z.string() })).optional(),
  })).max(25) }).parse(body);
  return raw.recordings.flatMap((item) => {
    if (item.video === true || !sameRecordingVersion(item.title, `${item.title} ${item.disambiguation ?? ""}`)) return [];
    const artist = item["artist-credit"]?.map((credit) => credit.name).join(" / ") ?? "";
    if (!item.title.trim() || !artist.trim()) return [];
    return [{
      id: item.id,
      title: item.title,
      artist,
      album: item.releases?.[0]?.title ?? null,
      durationSec: item.length ? Math.round(item.length / 1000) : null,
    }];
  });
}

async function addIdentifiedRecordings(recordings: CatalogRecording[], videos: CatalogVideo[] | null, fetcher: typeof fetch, signal?: AbortSignal) {
  const seen = new Set(recordings.map((item) => item.id));
  let failure: unknown = null;
  for (const video of (videos ?? []).slice(0, 3)) {
    const identity = identityFromVideo(video);
    if (!identity) continue;
    try {
      for (const item of await catalogRecordings(`recording:${quoted(identity.title)} AND artist:${quoted(identity.artist)}`, fetcher, signal)) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        recordings.push(item);
      }
    } catch (error) {
      failure = error;
      console.warn("Identified recording catalog lookup unavailable; retaining completed metadata");
      break;
    }
  }
  return { recordings: recordings.slice(0, 25), failure };
}

const sameRecording = (track: { title: string; artist: string; durationSec: number | null }, item: { title: string; artist: string; durationSec: number | null }) =>
  normalizeMatchText(track.title) === normalizeMatchText(item.title) && normalizeMatchText(track.artist) === normalizeMatchText(item.artist)
  && (!track.durationSec || !item.durationSec || Math.abs(track.durationSec - item.durationSec) <= 2.5);

async function storeRequest(userId: string, item: {
  title: string; artist: string; album: string | null; durationSec: number | null; mbRecordingId: string | null; videoId: string | null;
}, existingTrackId?: string) {
  return getDb().transaction(async (tx) => {
    if (item.videoId) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`video:${item.videoId}`}, 783))`);
    if (item.mbRecordingId) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${item.mbRecordingId}, 783))`);
    const candidates = item.mbRecordingId
      ? await tx.select().from(schema.tracks).where(eq(schema.tracks.mbRecordingId, item.mbRecordingId)).orderBy(sql`case when ${schema.tracks.stage} in ('ready','analyzing') then 0 else 1 end`).limit(21).for("update")
      : [];
    if (candidates.length > 1) throw new MusicError("Multiple library editions share this recording. Open Library and choose the exact edition; no new acquisition was started.", 409);
    let track = candidates[0];
    if (track && !sameRecording(track, item)) throw new MusicError("The indexed recording has conflicting version or duration metadata. Check this edition in Library before requesting it.", 409);
    if (item.videoId && !track?.youtubeVideoId) {
      const [existing] = await tx.select().from(schema.tracks).where(eq(schema.tracks.youtubeVideoId, item.videoId)).limit(1).for("update");
      if (existing && existing.id !== track?.id) {
        if ((item.mbRecordingId && existing.mbRecordingId && existing.mbRecordingId !== item.mbRecordingId) || !sameRecording(existing, item)) {
          throw new MusicError("That video belongs to a different recording in Mint. Choose another video or request without a video link.");
        }
        if (track) throw new MusicError("This video is already used by another library entry. Request without a video link.");
        track = existing;
      }
    }
    if (!track && existingTrackId) {
      const [placeholder] = await tx.select().from(schema.tracks).where(eq(schema.tracks.id, existingTrackId)).limit(1).for("update");
      if (placeholder && !placeholder.filePath && !["ready", "analyzing"].includes(placeholder.stage)) track = placeholder;
    }
    if (track && existingTrackId && track.id !== existingTrackId) {
      await tx.delete(schema.tracks).where(and(eq(schema.tracks.id, existingTrackId), sql`${schema.tracks.filePath} is null`));
    }
    if (!track) [track] = await tx.insert(schema.tracks).values({
      title: item.title, artist: item.artist, album: item.album, durationSec: item.durationSec,
      mbRecordingId: item.mbRecordingId, youtubeVideoId: item.videoId, detail: "Requested from search",
    }).returning();
    else if (existingTrackId && track.id === existingTrackId) {
      [track] = await tx.update(schema.tracks).set({
        title: item.title, artist: item.artist, album: item.album, durationSec: item.durationSec,
        mbRecordingId: item.mbRecordingId, youtubeVideoId: item.videoId ?? track.youtubeVideoId,
        stage: "queued", progress: 0, error: null, detail: "Matched. Queued for download.",
      }).where(eq(schema.tracks.id, track.id)).returning();
    }
    else if (!track.youtubeVideoId && item.videoId && !["ready", "analyzing"].includes(track.stage)) {
      [track] = await tx.update(schema.tracks).set({ youtubeVideoId: item.videoId }).where(eq(schema.tracks.id, track.id)).returning();
    }
    if (!track) throw new Error("The requested song was not stored.");
    if (track.stage === "failed") {
      [track] = await tx.update(schema.tracks).set({ stage: "queued", progress: 0, error: null, detail: "Requested again from search" }).where(eq(schema.tracks.id, track.id)).returning();
    }
    if (!track) throw new Error("The requested song could not be updated.");
    await tx.insert(schema.userTracks).values({ userId, trackId: track.id, origin: "request" }).onConflictDoNothing();
    return { trackId: track.id, stage: track.stage, needsQueue: track.stage === "queued" };
  });
}

function storedChoice(userId: string, choice: RequestChoice, pinnedId: string | null, existingTrackId?: string) {
  if (choice.kind === "video") {
    const identity = identityFromVideo(choice.video);
    return storeRequest(userId, {
      title: identity?.title ?? choice.video.title,
      artist: identity?.artist || choice.video.channel || "Unknown",
      album: null,
      durationSec: choice.video.durationSec,
      mbRecordingId: null,
      videoId: choice.video.id,
    }, existingTrackId);
  }
  return storeRequest(userId, {
    title: choice.recording.title,
    artist: choice.recording.artist,
    album: choice.recording.album,
    durationSec: choice.recording.durationSec,
    mbRecordingId: choice.recording.id,
    videoId: pinnedId ?? choice.videoId,
  }, existingTrackId);
}

/** Resolve catalog evidence, then search YouTube and queue one confident match. */
export async function resolveAndRequest(userId: string, query: string, youtubeUrl?: string, fetcher: typeof fetch = fetch, options?: {
  accept?: (choice: RequestChoice) => boolean;
  allowUnmatchedUrl?: boolean;
  durationSec?: number | null;
  existingTrackId?: string;
}) {
  const pinnedId = youtubeSource(youtubeUrl);
  const signal = youtubeScrapingAuthorized() ? AbortSignal.timeout(35_000) : undefined;
  let recordings: CatalogRecording[] = [];
  let catalogError: unknown = null;
  try {
    recordings = await catalogRecordings(escaped(query), fetcher, signal);
  } catch (error) {
    catalogError = error instanceof MusicError ? error : new MusicError("The recording catalog is temporarily unavailable. Try again.", 503);
    console.warn("Recording catalog unavailable; checking independent audio evidence");
  }
  let videos: Awaited<ReturnType<typeof searchLinkedYouTube>>;
  if (pinnedId) {
    const pinned = await linkedYouTubeVideo(userId, pinnedId, signal);
    if (!pinned) throw new NeedsVideoError(true, youtubeScrapingAuthorized()
      ? "Pinned source metadata is unavailable. Choose an available audio URL."
      : "Pinned source metadata is unavailable. Link YouTube and choose an available audio URL.");
    videos = [pinned];
  } else videos = await searchLinkedYouTube(userId, query, (candidates) => requestAudioCandidates(query, recordings, candidates, options?.durationSec ?? null), signal);
  if (!catalogError || videos?.length || pinnedId) {
    const identified = await addIdentifiedRecordings(recordings, videos, fetcher, signal);
    recordings = identified.recordings;
    if (identified.failure) catalogError ??= identified.failure instanceof MusicError ? identified.failure
      : new MusicError("The recording catalog is temporarily unavailable. Try again.", 503);
  }
  let model = { enabled: false, apiKey: null as string | null };
  try {
    const stored = await getMatchingDecision();
    model = { enabled: stored.enabled, apiKey: stored.apiKey };
  } catch { console.error("Matching settings unavailable; using deterministic audio matching"); }
  let choice = await matchMissingRequest({ query, recordings, videos, durationSec: options?.durationSec, explicitPin: Boolean(pinnedId), model });
  if (!pinnedId && videos && youtubeScrapingAuthorized()) {
    for (let attempts = 0; choice && attempts < 10; attempts++) {
      const videoId = choice.kind === "recording" ? choice.videoId : choice.video.id;
      if (!videoId) break;
      const checked = videos.find((video) => video.id === videoId && video.watchVerified);
      const verified = checked ?? await linkedYouTubeVideo(userId, videoId, signal);
      const eligible = verified && requestAudioCandidates(query, recordings, [verified], options?.durationSec ?? null)
        .some((video) => video.id === videoId);
      if (verified && eligible && (choice.kind !== "recording" || videoMatchesRequest(choice.recording, verified))) {
        const source = { ...verified, rank: videos.find((video) => video.id === videoId)?.rank ?? verified.rank, watchVerified: true };
        videos = videos.map((video) => video.id === videoId ? source : video);
        if (choice.kind === "video") choice = { kind: "video", video: source };
        break;
      }
      console.warn("YouTube search candidate was unavailable or changed; checking the next eligible source", { videoId });
      videos = videos.filter((video) => video.id !== videoId);
      choice = await matchMissingRequest({ query, recordings, videos, durationSec: options?.durationSec, model });
      if (attempts === 9 && choice && (choice.kind === "video" || choice.videoId)) choice = null;
    }
  }
  if (choice && options?.accept && !options.accept(choice)) {
    const rejected = choice;
    const video = rejected.kind === "recording" ? videos?.find((item) => item.id === rejected.videoId) : null;
    const fallback = video ? { kind: "video" as const, video } : null;
    choice = fallback && options.accept(fallback) ? fallback : null;
  }
  if (!choice) {
    if (catalogError && !pinnedId) throw catalogError;
    if (pinnedId) throw new NeedsVideoError(true, "Pinned source rejected: the artist, title, version or duration was not confirmed for this song. No substitute was selected.");
    const detail = videos ? requestMatchMessage(query, recordings, videos, options?.durationSec ?? null) : null;
    throw new NeedsVideoError(videos !== null, detail ? `${detail} Choose an audio URL for this exact recording.` : undefined);
  }
  return storedChoice(userId, choice, pinnedId, options?.existingTrackId);
}
