import "server-only";
import { decrypt, encrypt } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { requireEnv } from "@mint/core/env";
import { MusicError } from "@mint/core/music";
import { eq } from "drizzle-orm";
import type { CatalogVideo } from "./request-match";

const API = "https://www.googleapis.com/youtube/v3";

async function accessToken(userId: string) {
  const db = getDb();
  const account = await db.query.youtubeAccounts.findFirst({ where: eq(schema.youtubeAccounts.userId, userId) });
  if (!account) return null;
  if (account.expiresAt.getTime() - Date.now() > 60_000) return decrypt(account.accessTokenEnc);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refresh_token: decrypt(account.refreshTokenEnc),
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const token = await response.json() as { access_token?: string; expires_in?: number };
  if (!token.access_token || !token.expires_in) return null;
  await db.update(schema.youtubeAccounts).set({
    accessTokenEnc: encrypt(token.access_token),
    expiresAt: new Date(Date.now() + token.expires_in * 1000),
  }).where(eq(schema.youtubeAccounts.userId, userId));
  return token.access_token;
}

function durationSeconds(value: string | null | undefined) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? "");
  return match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : null;
}

/** A linked account that is rate limited is busy, not missing. */
async function linkedResponse(response: Response) {
  if (response.status === 429 || response.status === 503) throw new MusicError("YouTube is busy. Matching will retry.", 503);
  if (response.status === 403) {
    const text = await response.text().catch(() => "");
    if (/quota|rate/i.test(text)) throw new MusicError("YouTube is busy. Matching will retry.", 503);
  }
  return response;
}

async function videoDetails(token: string, ids: string[]): Promise<CatalogVideo[]> {
  if (!ids.length) return [];
  const url = new URL(`${API}/videos`);
  url.search = new URLSearchParams({ id: ids.join(","), part: "snippet,contentDetails" }).toString();
  const response = await linkedResponse(await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }));
  if (!response.ok) return [];
  const body = await response.json() as { items?: Array<{ id?: string; snippet?: { title?: string; channelTitle?: string }; contentDetails?: { duration?: string } }> };
  const byId = new Map((body.items ?? []).map((item) => [item.id, item]));
  return ids.flatMap((id, rank) => {
    const item = byId.get(id);
    if (!item?.snippet?.title || !item.snippet.channelTitle) return [];
    return [{ id, title: item.snippet.title, channel: item.snippet.channelTitle, durationSec: durationSeconds(item.contentDetails?.duration), rank }];
  });
}

/** Music videos for the member's own query. Null means YouTube is not linked or could not be searched. */
export async function searchLinkedYouTube(userId: string, query: string): Promise<CatalogVideo[] | null> {
  try {
    const token = await accessToken(userId);
    if (!token) return null;
    const url = new URL(`${API}/search`);
    url.search = new URLSearchParams({ q: query, part: "snippet", type: "video", maxResults: "10", videoCategoryId: "10" }).toString();
    const response = await linkedResponse(await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }));
    if (!response.ok) return null;
    const body = await response.json() as { items?: Array<{ id?: { videoId?: string } }> };
    const ids = (body.items ?? []).flatMap((item) => item.id?.videoId && /^[A-Za-z0-9_-]{11}$/.test(item.id.videoId) ? [item.id.videoId] : []);
    return videoDetails(token, ids);
  } catch (error) {
    if (error instanceof MusicError) throw error;
    return null;
  }
}

export async function linkedYouTubeVideo(userId: string, videoId: string): Promise<CatalogVideo | null> {
  try {
    const token = await accessToken(userId);
    if (!token) return null;
    const [video] = await videoDetails(token, [videoId]);
    return video ?? null;
  } catch (error) {
    if (error instanceof MusicError) throw error;
    return null;
  }
}
