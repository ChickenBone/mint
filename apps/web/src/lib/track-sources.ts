import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@mint/core/db";
import { MusicError } from "@mint/core/music";
import { enqueueRetry } from "./queues";

/** Member decisions about a track's YouTube audio: pick a reviewed upload, or reject the one in use. */
export const trackSourceActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("choose"), videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/) }),
  z.object({ action: z.literal("wrong") }),
]);

export interface TrackSourceState {
  trackId: string;
  stage: string;
  /** Up to three vetted uploads the worker could not choose between automatically. */
  choices: Array<{ id: string; title: string; channel: string; durationSec: number | null; viewCount: number | null }>;
  /** The YouTube upload currently used, which a member may report as the wrong audio. */
  videoId: string | null;
  canReportWrong: boolean;
}

async function ownedTrack(userId: string, admin: boolean, trackId: string) {
  z.uuid().parse(trackId);
  const db = getDb();
  if (!admin) {
    const owns = await db.query.userTracks.findFirst({
      where: and(eq(schema.userTracks.userId, userId), eq(schema.userTracks.trackId, trackId)),
    });
    if (!owns) throw new MusicError("Only songs in your own library can change their audio source.", 404);
  }
  const track = await db.query.tracks.findFirst({ where: eq(schema.tracks.id, trackId) });
  if (!track) throw new MusicError("Song not found.", 404);
  return track;
}

const wrongReportable = (track: { youtubeVideoId: string | null; source: string | null; stage: string }) =>
  !!track.youtubeVideoId && track.source !== "lidarr" && track.stage !== "downloading";

export async function trackSourceState(userId: string, admin: boolean, trackId: string): Promise<TrackSourceState> {
  const track = await ownedTrack(userId, admin, trackId);
  return {
    trackId: track.id, stage: track.stage, videoId: track.youtubeVideoId, canReportWrong: wrongReportable(track),
    choices: track.stage === "failed" ? (track.sourceChoices ?? []).map(({ id, title, channel, durationSec, viewCount }) =>
      ({ id, title, channel, durationSec, viewCount })) : [],
  };
}

/**
 * Choosing pins one of the worker's own reviewed uploads (the acquire job still re-validates it).
 * Reporting wrong audio blocks the upload for this track and matches again without it.
 */
export async function changeTrackSource(userId: string, admin: boolean, trackId: string, input: unknown) {
  const action = trackSourceActionSchema.parse(input);
  const track = await ownedTrack(userId, admin, trackId);
  const db = getDb();
  if (action.action === "choose") {
    if (track.stage !== "failed" || !track.sourceChoices?.some((choice) => choice.id === action.videoId)) {
      throw new MusicError("That upload is no longer offered for this song. Refresh and choose again.", 409);
    }
    const [other] = await db.select({ id: schema.tracks.id }).from(schema.tracks)
      .where(and(eq(schema.tracks.youtubeVideoId, action.videoId), sql`${schema.tracks.id} <> ${track.id}`)).limit(1);
    if (other) throw new MusicError("That upload is already used by another song in Mint. Choose another one.", 409);
    await db.update(schema.tracks).set({ youtubeVideoId: action.videoId, sourceChoices: null, stage: "queued", progress: 0,
      error: null, detail: "Using the source you chose", filePath: null }).where(eq(schema.tracks.id, track.id));
    await enqueueRetry(track.id, true, userId);
    return trackSourceState(userId, admin, trackId);
  }
  if (!wrongReportable(track)) throw new MusicError("This song has no YouTube audio to report.", 409);
  await db.update(schema.tracks).set({
    blockedVideoIds: sql`array_append(array_remove(${schema.tracks.blockedVideoIds}, ${track.youtubeVideoId}), ${track.youtubeVideoId})`,
    youtubeVideoId: null, sourceChoices: null, stage: "queued", progress: 0, error: null,
    detail: "Finding different audio", filePath: null,
  }).where(eq(schema.tracks.id, track.id));
  await enqueueRetry(track.id, true, userId);
  return trackSourceState(userId, admin, trackId);
}
