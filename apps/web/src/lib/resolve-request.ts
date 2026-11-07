import "server-only";
import { z } from "zod";
import { getDb, schema } from "@mint/core/db";
import { getMatchingDecision } from "@mint/core/matching-db";
import { MusicError } from "@mint/core/music";
import { and, eq, sql } from "drizzle-orm";
import { youtubeSource } from "./music-requests";
import { identityFromVideo, matchMissingRequest, normalizeMatchText, type CatalogRecording, type CatalogVideo, type RequestChoice } from "./request-match";
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

async function catalogRecordings(query: string, fetcher: typeof fetch): Promise<CatalogRecording[]> {
  const url = new URL("https://musicbrainz.org/ws/2/recording");
  url.search = new URLSearchParams({ query, fmt: "json", limit: "25" }).toString();
  const response = await fetcher(url, {
    headers: { "user-agent": process.env.MUSICBRAINZ_USER_AGENT ?? "Mint/3.5 ( https://github.com/ChickenBone/mint )", accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new MusicError(response.status === 429 || response.status === 503 ? "MusicBrainz is busy. Wait a few seconds and search again." : "The recording catalog could not be reached. Try again.", 503);
  const body = await readBoundedJson(response);
  const raw = z.object({ recordings: z.array(z.object({
    id: z.uuid(), title: z.string(), length: z.number().nullish(),
    "artist-credit": z.array(z.object({ name: z.string() })).optional(),
    releases: z.array(z.object({ title: z.string() })).optional(),
  })).max(25) }).parse(body);
  return raw.recordings.flatMap((item) => {
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

async function addIdentifiedRecordings(recordings: CatalogRecording[], videos: CatalogVideo[] | null, fetcher: typeof fetch) {
  const seen = new Set(recordings.map((item) => item.id));
  for (const video of (videos ?? []).slice(0, 3)) {
    const identity = identityFromVideo(video);
    if (!identity) continue;
    try {
      for (const item of await catalogRecordings(`recording:${quoted(identity.title)} AND artist:${quoted(identity.artist)}`, fetcher)) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        recordings.push(item);
      }
    } catch {
      break;
    }
  }
  return recordings.slice(0, 25);
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

/** Search MusicBrainz and linked YouTube together, then queue one confident match. */
export async function resolveAndRequest(userId: string, query: string, youtubeUrl?: string, fetcher: typeof fetch = fetch, options?: {
  accept?: (choice: RequestChoice) => boolean;
  allowUnmatchedUrl?: boolean;
  durationSec?: number | null;
  existingTrackId?: string;
}) {
  const pinnedId = youtubeSource(youtubeUrl);
  const catalogPromise = catalogRecordings(escaped(query), fetcher);
  let videos: Awaited<ReturnType<typeof searchLinkedYouTube>>;
  try {
    videos = pinnedId
      ? [await linkedYouTubeVideo(userId, pinnedId) ?? { id: pinnedId, title: query, channel: "", durationSec: null, rank: 0 }]
      : await searchLinkedYouTube(userId, query);
  } catch (error) {
    await catalogPromise.catch(() => undefined);
    throw error;
  }
  let recordings: CatalogRecording[] = [];
  let catalogError: unknown = null;
  try {
    recordings = await catalogPromise;
  } catch (error) {
    catalogError = error;
  }
  if (!catalogError || videos?.length || pinnedId) recordings = await addIdentifiedRecordings(recordings, videos, fetcher);
  let model = { enabled: false, apiKey: null as string | null };
  try {
    const stored = await getMatchingDecision();
    model = { enabled: stored.enabled, apiKey: stored.apiKey };
  } catch { /* deterministic matching still runs */ }
  let choice = await matchMissingRequest({ query, recordings, videos, durationSec: options?.durationSec, model });
  if (choice && options?.accept && !options.accept(choice)) {
    const rejected = choice;
    const video = rejected.kind === "recording" ? videos?.find((item) => item.id === rejected.videoId) : null;
    const fallback = video ? { kind: "video" as const, video } : null;
    choice = fallback && options.accept(fallback) ? fallback : null;
  }
  if (!choice && pinnedId && options?.allowUnmatchedUrl !== false) {
    const video = videos?.[0];
    const identity = video ? identityFromVideo(video) : null;
    return storeRequest(userId, {
      title: identity?.title || video?.title || query,
      artist: identity?.artist || "Unknown",
      album: null,
      durationSec: video?.durationSec ?? null,
      mbRecordingId: null,
      videoId: pinnedId,
    });
  }
  if (!choice) {
    if (catalogError && !videos?.length && !pinnedId) throw catalogError;
    if (pinnedId && options?.allowUnmatchedUrl === false) throw new NeedsVideoError(true, "That video does not match this song's artist, title, and duration.");
    throw new NeedsVideoError(videos !== null);
  }
  return storedChoice(userId, choice, pinnedId, options?.existingTrackId);
}
