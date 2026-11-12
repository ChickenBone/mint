import "server-only";
import { decrypt, encrypt } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { requireEnv } from "@mint/core/env";
import { MusicError } from "@mint/core/music";
import { audioSearchQueries, audioSearchSatisfied, pauseYoutubeSearch, reserveYoutubeSearch, YoutubeSearchDeferredError, validatedViewCount, youtubeDurationSeconds } from "@mint/core/matching";
import { getRedis } from "@mint/core/redis";
import { readYoutubeScrapeVideo, searchYoutubeScraped, youtubeScrapeDeferred, youtubeScrapingAuthorized } from "@mint/core/youtube-scrape";
import { eq } from "drizzle-orm";
import type { CatalogVideo } from "./request-match";

const API = "https://www.googleapis.com/youtube/v3";

async function requireActiveMember(userId: string) {
  const member = await getDb().query.users.findFirst({ where: eq(schema.users.id, userId), columns: { status: true } });
  if (member?.status !== "active") throw new MusicError("The requesting member no longer has approved access.", 403);
}

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
  if (!response.ok) throw new MusicError("YouTube access could not be refreshed. Reconnect YouTube and try again.", 503);
  const token = await response.json() as { access_token?: string; expires_in?: number };
  if (!token.access_token || !token.expires_in) throw new MusicError("YouTube returned unavailable account metadata. Reconnect YouTube.", 503);
  await db.update(schema.youtubeAccounts).set({
    accessTokenEnc: encrypt(token.access_token),
    expiresAt: new Date(Date.now() + token.expires_in * 1000),
  }).where(eq(schema.youtubeAccounts.userId, userId));
  return token.access_token;
}

/** A linked account that is rate limited is busy, not missing. */
async function linkedResponse(response: Response) {
  if (response.status === 429) {
    await pauseYoutubeSearch(getRedis());
    throw new MusicError("YouTube is busy. Matching will retry.", 503);
  }
  if (response.status === 503) throw new MusicError("YouTube is busy. Matching will retry.", 503);
  if (response.status === 403) {
    const text = await response.text().catch(() => "");
    if (/quota|rate|dailyLimit/i.test(text)) {
      await pauseYoutubeSearch(getRedis());
      throw new MusicError("YouTube search quota is exhausted. Try again later.", 503);
    }
  }
  if (response.status === 401 || response.status === 403) {
    throw new MusicError("YouTube access was refused. Reconnect YouTube and try again.", 401);
  }
  return response;
}

async function videoDetails(token: string, ids: string[]): Promise<CatalogVideo[]> {
  if (!ids.length) return [];
  const url = new URL(`${API}/videos`);
  url.search = new URLSearchParams({ id: ids.join(","), part: "snippet,contentDetails,statistics" }).toString();
  const response = await linkedResponse(await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }));
  if (!response.ok) throw new MusicError("YouTube source metadata is temporarily unavailable. Try again.", 503);
  const body = await response.json() as { items?: Array<{ id?: string; snippet?: { title?: string; channelTitle?: string }; contentDetails?: { duration?: string }; statistics?: { viewCount?: string } }> };
  if (!Array.isArray(body.items)) throw new MusicError("YouTube returned invalid source metadata. Try again.", 503);
  const byId = new Map((body.items ?? []).map((item) => [item.id, item]));
  return ids.flatMap((id, rank) => {
    const item = byId.get(id);
    if (typeof item?.snippet?.title !== "string" || typeof item.snippet.channelTitle !== "string" ||
      !item.snippet.title.trim() || !item.snippet.channelTitle.trim()) return [];
    return [{ id, title: item.snippet.title, channel: item.snippet.channelTitle, durationSec: youtubeDurationSeconds(item.contentDetails?.duration),
      viewCount: validatedViewCount(item.statistics?.viewCount), rank }];
  });
}

/** Lazy audio/Topic rounds, then bounded lyric results. Null means a required account is not linked. */
export async function searchLinkedYouTube(userId: string, query: string, eligible: (videos: CatalogVideo[]) => CatalogVideo[], signal?: AbortSignal): Promise<CatalogVideo[] | null> {
  const scraping = youtubeScrapingAuthorized();
  try {
    if (scraping) {
      await requireActiveMember(userId);
      return await searchYoutubeScraped(query, {
        eligible,
        signal,
        onDegraded: (round, candidates) => console.warn("YouTube metadata search degraded; retaining eligible audio from completed rounds", {
          round, candidates: candidates.length, reason: "provider-failure",
        }),
      });
    }
    const token = await accessToken(userId);
    if (!token) return null;
    const seen = new Set<string>();
    const details: CatalogVideo[] = [];
    for (const [round, search] of audioSearchQueries(query).entries()) {
      try {
        await reserveYoutubeSearch(getRedis());
        const url = new URL(`${API}/search`);
        url.search = new URLSearchParams({ ...search, part: "snippet", type: "video", maxResults: "10", videoCategoryId: "10" }).toString();
        const response = await linkedResponse(await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }));
        if (!response.ok) throw new MusicError("YouTube search is temporarily unavailable. Try again.", 503);
        const body = await response.json() as { items?: Array<{ id?: { videoId?: string } }> };
        if (!Array.isArray(body.items)) throw new MusicError("YouTube returned invalid search metadata. Try again.", 503);
        const ids = [...new Set(body.items.slice(0, 10).flatMap((item) => item.id?.videoId && /^[A-Za-z0-9_-]{11}$/.test(item.id.videoId) ? [item.id.videoId] : []))]
          .filter((id) => !seen.has(id));
        const batch = await videoDetails(token, ids);
        for (const id of ids) seen.add(id);
        details.push(...batch.map((video) => ({ ...video, rank: [...seen].indexOf(video.id) })));
      } catch (error) {
        if (error instanceof MusicError && error.status === 401) throw error;
        if (!eligible(details).length) throw error;
        console.warn("YouTube search degraded; retaining eligible audio from completed rounds", {
          round: round + 1, candidates: details.length,
          reason: error instanceof YoutubeSearchDeferredError ? "quota-or-budget" : "provider-failure",
        });
        break;
      }
      if (audioSearchSatisfied(eligible(details), round)) break;
    }
    if (seen.size && !details.length) throw new MusicError("YouTube source metadata is unavailable for the search results. Try again.", 503);
    return details;
  } catch (error) {
    if (error instanceof MusicError) throw error;
    const deferred = youtubeScrapeDeferred(error);
    if (deferred) throw new MusicError(deferred.message, 503);
    if (error instanceof YoutubeSearchDeferredError) throw new MusicError(error.message, 503);
    throw new MusicError("YouTube search failed temporarily. Try again.", 503);
  }
}

export async function linkedYouTubeVideo(userId: string, videoId: string, signal?: AbortSignal): Promise<CatalogVideo | null> {
  const scraping = youtubeScrapingAuthorized();
  try {
    if (scraping) {
      await requireActiveMember(userId);
      return await readYoutubeScrapeVideo(videoId, { signal });
    }
    const token = await accessToken(userId);
    if (!token) return null;
    const [video] = await videoDetails(token, [videoId]);
    return video ?? null;
  } catch (error) {
    if (error instanceof MusicError) throw error;
    if (signal?.aborted && error === signal.reason) throw new MusicError("YouTube source metadata took too long. Try again.", 503);
    const deferred = youtubeScrapeDeferred(error);
    if (deferred) throw new MusicError(deferred.message, 503);
    throw new MusicError("YouTube source metadata could not be read. Try again.", 503);
  }
}
