import { decrypt, encrypt } from "@mint/core/crypto";
import { isPreviewUpload } from "@mint/core/matching";
import { getDb, schema } from "@mint/core/db";
import { requireEnv } from "@mint/core/env";
import { eq } from "drizzle-orm";
import { HttpError, httpJson } from "../http";
import { log } from "../log";
import { classifyRequestedVideo } from "./matching-classifier";

const API = "https://www.googleapis.com/youtube/v3";

export interface YtVideo {
  id: string;
  title: string;
  channelTitle: string;
  description: string;
  categoryId: string | null;
  durationIso: string | null;
}

export interface YtPlaylist {
  id: string;
  title: string;
  description: string;
  thumbnail: string | null;
  itemCount: number;
}

interface VideoResource {
  id: string;
  snippet?: { title: string; channelTitle: string; description: string; categoryId?: string };
  contentDetails?: { duration?: string };
}

export class YoutubeAuthError extends Error {}

/** Returns a valid access token for the user, refreshing (and persisting) it if needed. */
export async function getAccessToken(userId: string): Promise<string> {
  const db = getDb();
  const acct = await db.query.youtubeAccounts.findFirst({ where: eq(schema.youtubeAccounts.userId, userId) });
  if (!acct) throw new YoutubeAuthError("YouTube account not linked");
  if (acct.expiresAt.getTime() - Date.now() > 60_000) return decrypt(acct.accessTokenEnc);

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refresh_token: decrypt(acct.refreshTokenEnc),
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text();
    if (resp.status === 400 || resp.status === 401) throw new YoutubeAuthError(`Google refused token refresh: ${body.slice(0, 200)}`);
    throw new HttpError(resp.status, "Google token refresh failed", body);
  }
  const tok = (await resp.json()) as { access_token: string; expires_in: number };
  await db
    .update(schema.youtubeAccounts)
    .set({ accessTokenEnc: encrypt(tok.access_token), expiresAt: new Date(Date.now() + tok.expires_in * 1000) })
    .where(eq(schema.youtubeAccounts.userId, userId));
  return tok.access_token;
}

export async function findRequestedVideo(userId: string, track: { title: string; artist: string; durationSec: number | null }): Promise<string | null> {
  const user = await getDb().query.users.findFirst({ where: eq(schema.users.id, userId), columns: { status: true } });
  if (user?.status !== "active") throw new YoutubeAuthError("The requesting member no longer has approved access.");
  const token = await getAccessToken(userId);
  const lead = track.artist.split(/\s+(?:feat\.?|ft\.?|&|\/)\s+|,/i)[0]!.trim();
  const found = await httpJson<{ items: Array<{ id?: { videoId?: string } }> }>(`${API}/search`, {
    headers: { authorization: `Bearer ${token}` },
    query: { q: `${lead} ${track.title}`, part: "snippet", type: "video", maxResults: 10, videoCategoryId: "10" },
  });
  const ids = found.items.flatMap((item) => item.id?.videoId && /^[A-Za-z0-9_-]{11}$/.test(item.id.videoId) ? [item.id.videoId] : []);
  const candidates = await videosById(token, ids);
  const classified = await classifyRequestedVideo(track, candidates);
  if (classified.status === "selected") {
    const chosen = candidates.find((video) => video.id === classified.id);
    if (chosen && (isPreviewUpload(chosen.title) || !sameRequestedVersion(track.title, chosen.title))) {
      log.info({ videoId: classified.id, title: chosen.title }, "OpenAI selected a different version; using deterministic matching");
    } else {
      log.info({ videoId: classified.id, confidence: classified.confidence }, "OpenAI selected YouTube recording");
      return classified.id;
    }
  }
  if (classified.status === "none") {
    log.info({ confidence: classified.confidence }, "OpenAI rejected all YouTube candidates");
    return null;
  }
  if (classified.status === "fallback") {
    log.info({ reason: classified.reason, title: track.title, artist: track.artist }, "OpenAI did not select a recording; using deterministic matching");
  }
  return selectRequestedVideo(track, candidates);
}

const VERSION_WORDS = ["live", "remix", "cover", "karaoke", "instrumental", "remaster", "remastered", "acoustic", "demo", "extended", "visualizer", "lyrics", "lyric", "sped", "slowed", "nightcore"];

function matchText(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** A visualizer, lyric video, or other alternate version is not the requested recording. */
export function sameRequestedVersion(requestedTitle: string, videoTitle: string) {
  const wanted = matchText(requestedTitle).split(" ").filter(Boolean);
  const title = matchText(videoTitle).split(" ").filter(Boolean);
  return !VERSION_WORDS.some((version) => !wanted.includes(version) && title.includes(version));
}

export function selectRequestedVideo(track: { title: string; artist: string; durationSec: number | null }, candidates: YtVideo[]): string | null {
  if (!track.durationSec) return null;
  const wanted = matchText(track.title), artist = matchText(track.artist.split(/\s+(?:feat\.?|ft\.?|&|\/)\s+|,/i)[0]!);
  const words = wanted.split(" ").filter(Boolean);
  const versions = VERSION_WORDS;
  const duration = (value: string | null) => {
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? "");
    return match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : null;
  };
  const matches = candidates.flatMap((video) => {
    const title = matchText(video.title), channel = matchText(video.channelTitle), seconds = duration(video.durationIso);
    const compactArtist = artist.replace(/\s+/g, "");
    const artistChannel = [artist, `${artist} topic`, `${artist} official`, `${artist} vevo`, `${compactArtist}vevo`].includes(channel);
    if (!artist || !words.length || !words.every((word) => title.split(" ").includes(word)) ||
        !artistChannel ||
        versions.some((version) => !wanted.split(" ").includes(version) && title.split(" ").includes(version)) ||
        (seconds === null || Math.abs(track.durationSec! - seconds) > 2.5)) return [];
    const distance = Math.abs(track.durationSec! - seconds!);
    const score = (channel.endsWith("vevo") ? 4 : 0) + (title.includes("official audio") ? 2 : 0) + (/\btopic\b/.test(channel) ? 1 : 0);
    return [{ id: video.id, score, distance }];
  }).sort((a, b) => b.score - a.score || a.distance - b.distance);
  const [best, next] = matches;
  if (!best || (next && best.score === next.score && best.distance === next.distance)) return null;
  return best.id;
}

function toVideo(v: VideoResource): YtVideo | null {
  if (!v.snippet) return null;
  return {
    id: v.id,
    title: v.snippet.title,
    channelTitle: v.snippet.channelTitle,
    description: v.snippet.description ?? "",
    categoryId: v.snippet.categoryId ?? null,
    durationIso: v.contentDetails?.duration ?? null,
  };
}

/** Pages through every video the user has liked (YouTube + YouTube Music share this list). */
export async function* likedVideos(token: string): AsyncGenerator<YtVideo> {
  let pageToken: string | undefined;
  do {
    const page = await httpJson<{ items: VideoResource[]; nextPageToken?: string }>(`${API}/videos`, {
      headers: { authorization: `Bearer ${token}` },
      query: { myRating: "like", part: "snippet,contentDetails", maxResults: 50, pageToken },
    });
    for (const item of page.items) {
      const v = toVideo(item);
      if (v) yield v;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
}

export async function listPlaylists(token: string): Promise<YtPlaylist[]> {
  const out: YtPlaylist[] = [];
  let pageToken: string | undefined;
  do {
    const page = await httpJson<{
      items: Array<{
        id: string;
        snippet: { title: string; description: string; thumbnails?: Record<string, { url: string }> };
        contentDetails: { itemCount: number };
      }>;
      nextPageToken?: string;
    }>(`${API}/playlists`, {
      headers: { authorization: `Bearer ${token}` },
      query: { mine: true, part: "snippet,contentDetails", maxResults: 50, pageToken },
    });
    for (const p of page.items) {
      const thumbs = p.snippet.thumbnails ?? {};
      out.push({
        id: p.id,
        title: p.snippet.title,
        description: p.snippet.description,
        thumbnail: (thumbs.high ?? thumbs.medium ?? thumbs.default)?.url ?? null,
        itemCount: p.contentDetails.itemCount,
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export async function playlistVideoIds(token: string, playlistId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await httpJson<{ items: Array<{ contentDetails: { videoId: string } }>; nextPageToken?: string }>(
      `${API}/playlistItems`,
      {
        headers: { authorization: `Bearer ${token}` },
        query: { playlistId, part: "contentDetails", maxResults: 50, pageToken },
      },
    );
    ids.push(...page.items.map((i) => i.contentDetails.videoId));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

export async function videosById(token: string, ids: string[]): Promise<YtVideo[]> {
  const out: YtVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const page = await httpJson<{ items: VideoResource[] }>(`${API}/videos`, {
      headers: { authorization: `Bearer ${token}` },
      query: { id: ids.slice(i, i + 50).join(","), part: "snippet,contentDetails", maxResults: 50 },
    });
    for (const item of page.items) {
      const v = toVideo(item);
      if (v) out.push(v);
    }
  }
  return out;
}
