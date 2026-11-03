import { decrypt, encrypt } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { requireEnv } from "@mint/core/env";
import { eq } from "drizzle-orm";
import { HttpError, httpJson } from "../http";

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
