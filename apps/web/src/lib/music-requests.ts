import { z } from "zod";
import { signToken, verifyToken } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { eq, inArray, sql } from "drizzle-orm";
import { MusicError } from "@mint/core/music";

const recording = z.object({
  id: z.uuid(), title: z.string().trim().min(1).max(1000), artist: z.string().trim().min(1).max(1000),
  album: z.string().max(1000).nullable(), durationSec: z.number().int().positive().nullable(),
  isrcs: z.array(z.string().max(100)).max(100).optional(),
});
export type RequestRecording = z.infer<typeof recording>;
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const sameRecordingMetadata = (track: { title: string; artist: string; durationSec: number | null }, item: RequestRecording) =>
  normalize(track.title) === normalize(item.title) && normalize(track.artist) === normalize(item.artist) &&
  (!track.durationSec || !item.durationSec || Math.abs(track.durationSec - item.durationSec) <= 2.5);
export function youtubeSource(value?: string) {
  if (!value?.trim()) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new MusicError("Use a full YouTube video URL."); }
  if (url.protocol !== "https:" || url.port || url.username || url.password) throw new MusicError("Use a normal HTTPS YouTube video URL.");
  const id = url.hostname === "youtu.be" ? url.pathname.slice(1) : ["youtube.com", "www.youtube.com", "music.youtube.com"].includes(url.hostname) && url.pathname === "/watch" ? url.searchParams.get("v") : null;
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new MusicError("Use a YouTube video link, not a playlist or channel.");
  return id;
}
export async function searchRecordings(userId: string, query: string, fetcher: typeof fetch = fetch, isrc?: string | null) {
  const escaped = query.replace(/(["\\+\-!(){}[\]^~*?:/]|&&|\|\|)/g, "\\$1");
  const url = new URL("https://musicbrainz.org/ws/2/recording");
  const identifier = isrc?.replaceAll("-", "").toUpperCase();
  url.search = new URLSearchParams({ query: identifier && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(identifier) ? `isrc:${identifier}` : escaped, fmt: "json", limit: "10" }).toString();
  const response = await fetcher(url, { headers: { "user-agent": process.env.MUSICBRAINZ_USER_AGENT ?? "Mint/3.5 ( https://github.com/ChickenBone/mint )", accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new MusicError(response.status === 429 || response.status === 503 ? "MusicBrainz is busy. Wait a few seconds and search again." : "The recording catalog could not be reached. Try again.", 503);
  const reader = response.body?.getReader();
  if (!reader) throw new MusicError("The recording catalog returned an empty response.", 503);
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 1_000_000) { await reader.cancel(); throw new MusicError("The recording catalog response was too large.", 503); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const raw = z.object({ recordings: z.array(z.object({
    id: z.uuid(), title: z.string(), length: z.number().nullish(),
    "artist-credit": z.array(z.object({ name: z.string() })).optional(),
    releases: z.array(z.object({ title: z.string() })).optional(),
    isrcs: z.array(z.string().max(100)).max(100).optional(),
  })).max(10) }).parse(body);
  const items = raw.recordings.flatMap((item) => {
    const parsed = recording.safeParse({ id: item.id, title: item.title, artist: item["artist-credit"]?.map((credit) => credit.name).join(" / ") ?? "",
      album: item.releases?.[0]?.title ?? null, durationSec: item.length ? Math.round(item.length / 1000) : null,
      isrcs: item.isrcs?.map((isrc) => isrc.replaceAll("-", "").toUpperCase()) });
    return parsed.success ? [parsed.data] : [];
  });
  const existing = items.length ? await getDb().select({
    id: schema.tracks.id, recordingId: schema.tracks.mbRecordingId, stage: schema.tracks.stage,
    error: schema.tracks.error, detail: schema.tracks.detail,
  }).from(schema.tracks).where(inArray(schema.tracks.mbRecordingId, items.map((item) => item.id))).limit(210) : [];
  return items.map((item) => ({ ...item, existing: existing.find((track) => track.recordingId === item.id) ?? null,
    token: signToken("music-request", { userId, recording: item }, 15 * 60_000) }));
}
export function readRequestRecording(userId: string, token: string) {
  const raw = verifyToken<{ userId: string; recording: unknown }>("music-request", token);
  if (!raw || raw.userId !== userId) throw new MusicError("This search result expired. Search for the song again.", 400);
  return recording.parse(raw.recording);
}
export async function requestRecording(userId: string, token: string, source?: string) {
  const item = readRequestRecording(userId, token), videoId = youtubeSource(source);
  return getDb().transaction(async (tx) => {
    if (videoId) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`video:${videoId}`}, 783))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${item.id}, 783))`);
    const candidates = await tx.select().from(schema.tracks).where(eq(schema.tracks.mbRecordingId, item.id)).orderBy(sql`case when ${schema.tracks.stage} in ('ready','analyzing') then 0 else 1 end`).limit(21).for("update");
    if (candidates.length > 1) throw new MusicError("Multiple library editions share this recording. Open Library and choose the exact edition; no new acquisition was started.", 409);
    let track = candidates[0];
    if (track && !sameRecordingMetadata(track, item)) throw new MusicError("The indexed recording has conflicting version or duration metadata. Check this edition in Library before requesting it.", 409);
    if (videoId && !track?.youtubeVideoId) {
      const [existing] = await tx.select().from(schema.tracks).where(eq(schema.tracks.youtubeVideoId, videoId)).limit(1).for("update");
      if (existing && existing.id !== track?.id) {
        if (existing.mbRecordingId && existing.mbRecordingId !== item.id ||
            !sameRecordingMetadata(existing, item)) {
          throw new MusicError("That video belongs to a different recording in Mint. Choose another video or request without a video link.");
        }
        if (track) throw new MusicError("This video is already used by another library entry. Request without a video link.");
        track = existing;
      }
    }
    if (!track) [track] = await tx.insert(schema.tracks).values({ title: item.title, artist: item.artist, album: item.album,
      durationSec: item.durationSec, mbRecordingId: item.id, youtubeVideoId: videoId, detail: "Requested from search" }).returning();
    else if (!track.youtubeVideoId && videoId && !["ready", "analyzing"].includes(track.stage)) {
      [track] = await tx.update(schema.tracks).set({ youtubeVideoId: videoId }).where(eq(schema.tracks.id, track.id)).returning();
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
