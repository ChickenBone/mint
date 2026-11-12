import { decrypt, encrypt } from "@mint/core/crypto";
import { audioSearchQueries, audioSearchSatisfied, audioSourceRejection, audioSourceScore, compareAudioSources, eligibleAudioSources, preferredAudioSources, reviewableAudioSources, sameRecordingVersion, sourceSelectionDiagnostics, sourceSelectionMessage, withInferredDurations,
  leadArtistName, pauseYoutubeSearch, reserveYoutubeSearch, YoutubeSearchDeferredError, validatedViewCount, youtubeDurationSeconds, type AudioCandidate, type RecordingIdentity } from "@mint/core/matching";
import { getRedis } from "@mint/core/redis";
import { getDb, schema } from "@mint/core/db";
import { requireEnv } from "@mint/core/env";
import { readYoutubeScrapeVideo, readYoutubeScrapeVideoOrListing, searchYoutubeScraped, youtubeScrapeDeferred, youtubeScrapingAuthorized,
  YoutubeWatchBlockedError, type ScrapedYoutubeVideo } from "@mint/core/youtube-scrape";
import { eq } from "drizzle-orm";
import { UnrecoverableError } from "bullmq";
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
  viewCount?: number | null;
  rank?: number;
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
  statistics?: { viewCount?: string };
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

/** A member-reviewable source choice; never includes descriptions or media URLs. */
export interface SourceChoice { id: string; title: string; channel: string; durationSec: number | null; viewCount: number | null; score: number | null }

/** Nothing reached automatic-selection confidence; the best veto-passing uploads await a member's choice. */
export class NeedsSourceError extends UnrecoverableError {
  constructor(message: string, public readonly choices: SourceChoice[]) {
    super(message);
    // BullMQ and onAcquireFailed recognise final failures by this name.
    this.name = "UnrecoverableError";
  }
}

function needsSource(track: RecordingIdentity, candidates: AudioCandidate[], message: string) {
  const evidence = withInferredDurations(track, candidates);
  const choices = reviewableAudioSources(evidence, candidates).map((candidate) => ({
    id: candidate.id, title: candidate.title.slice(0, 200), channel: candidate.channel.slice(0, 200),
    durationSec: candidate.durationSec, viewCount: validatedViewCount(candidate.viewCount), score: audioSourceScore(evidence, candidate),
  }));
  return new NeedsSourceError(choices.length ? `${message} Choose one of the suggested uploads or paste an audio URL.` : `${message} Paste an audio URL for this recording and retry.`, choices);
}

export async function findRequestedVideo(userId: string, track: RecordingIdentity,
  options: { syncOrigin?: boolean; reserve?: () => Promise<void>; pause?: () => Promise<void>;
    onSelected?: (candidate: AudioCandidate) => void; scrapeSearch?: typeof searchYoutubeScraped;
    scrapeVideo?: typeof readYoutubeScrapeVideo; blockedVideoIds?: string[] } = {}): Promise<string | null> {
  const blocked = new Set(options.blockedVideoIds ?? []);
  const user = await getDb().query.users.findFirst({ where: eq(schema.users.id, userId), columns: { status: true } });
  if (user?.status !== "active") throw new YoutubeAuthError("The requesting member no longer has approved access.");
  const scraping = youtubeScrapingAuthorized();
  const token = scraping ? null : await getAccessToken(userId);
  const lead = leadArtist(track.artist);
  const seen = new Set<string>(blocked);
  const candidates: YtVideo[] = [];
  const watched = new Map<string, ScrapedYoutubeVideo>();
  const rounds: Array<{ round: number; freshIds: number; metadataCount: number }> = [];
  if (scraping) {
    try {
      const found = await (options.scrapeSearch ?? searchYoutubeScraped)(`${lead} ${track.title}`, {
        eligible: (videos) => eligibleAudioSources(track, videos.filter((video) => !blocked.has(video.id))),
        wanted: { ...track, catalogVideoIds: track.catalogVideoIds?.filter((id) => !blocked.has(id)) },
        onDegraded: (round, videos) => log.warn({ round, reason: "provider-failure", ...sourceSelectionDiagnostics(track, videos) },
          "YouTube metadata search degraded; retaining eligible audio from completed rounds"),
        onWatchBlocked: (error) => log.warn({ reason: error.message, retryAfter: error.retryAfter },
          "YouTube watch pages are refused; selecting from search listings"),
      });
      for (const video of found) {
        if (blocked.has(video.id)) continue;
        seen.add(video.id);
        candidates.push(scrapedVideo(video));
        if (video.watchVerified) watched.set(video.id, video);
      }
    } catch (error) {
      throw youtubeScrapeDeferred(error) ?? error;
    }
  } else {
    for (const [round, search] of audioSearchQueries(`${lead} ${track.title}`).entries()) {
      try {
        await (options.reserve ?? (() => reserveYoutubeSearch(getRedis(), options.syncOrigin,
          Number(process.env.YOUTUBE_SYNC_SEARCH_DAILY_LIMIT ?? 60))))();
        const found = await httpJson<{ items: Array<{ id?: { videoId?: string } }> }>(`${API}/search`, {
          headers: { authorization: `Bearer ${token}` }, retries: 0,
          query: { ...search, part: "snippet", type: "video", maxResults: 10, videoCategoryId: "10" },
        });
        if (!found || !Array.isArray(found.items)) throw new Error("YouTube returned unavailable or invalid search metadata. Matching will retry.");
        const ids = [...new Set(found.items.slice(0, 10).flatMap((item) => item.id?.videoId && /^[A-Za-z0-9_-]{11}$/.test(item.id.videoId) ? [item.id.videoId] : []))]
          .filter((id) => !seen.has(id));
        const details = await videosById(token!, ids);
        rounds.push({ round: round + 1, freshIds: ids.length, metadataCount: details.length });
        for (const id of ids) seen.add(id);
        candidates.push(...details.map((video) => ({ ...video, rank: [...seen].indexOf(video.id) })));
      } catch (error) {
        if (error instanceof HttpError && (error.status === 429 || (error.status === 403 && /quota|rate|dailyLimit/i.test(error.body ?? "")))) {
          await (options.pause ?? (() => pauseYoutubeSearch(getRedis())))();
          error = new YoutubeSearchDeferredError("YouTube search quota is exhausted; waiting before matching.", 300_000);
        }
        if (error instanceof YoutubeAuthError || error instanceof HttpError && (error.status === 401 || error.status === 403)) throw error;
        if (!eligibleAudioSources(track, candidates.map(audioCandidate)).length) throw error;
        log.warn({ round: round + 1, reason: error instanceof YoutubeSearchDeferredError ? "quota-or-budget" : "provider-failure",
          ...sourceSelectionDiagnostics(track, candidates.map(audioCandidate)) },
        "YouTube search degraded; retaining eligible audio from completed rounds");
        break;
      }
      if (audioSearchSatisfied(eligibleAudioSources(track, candidates.map(audioCandidate)), round, track)) break;
    }
  }
  if (seen.size && !candidates.length) {
    log.warn({ ...sourceSelectionDiagnostics(track, []), rounds }, "YouTube search results have no available source metadata");
    throw new Error("YouTube source metadata is unavailable for the search results. Matching will retry.");
  }
  track = withInferredDurations(track, candidates.map(audioCandidate));
  const preferred = preferredAudioSources(track, candidates.map(audioCandidate));
  if (!preferred.length) {
    log.warn({ ...sourceSelectionDiagnostics(track, candidates.map(audioCandidate)), rounds }, "YouTube audio source selection rejected all candidates");
    throw needsSource(track, candidates.map(audioCandidate), sourceSelectionMessage(track, candidates.map(audioCandidate)));
  }
  const classified = await classifyRequestedVideo(track, candidates);
  let selected: AudioCandidate | undefined;
  if (classified.status === "selected") {
    const chosen = preferred.find((video) => video.id === classified.id);
    if (!chosen || audioSourceRejection(track, chosen)) {
      log.warn({ videoId: classified.id }, "OpenAI selected an ineligible source; using deterministic matching");
    } else {
      log.info({ videoId: classified.id, confidence: classified.confidence }, "OpenAI selected YouTube recording");
      selected = chosen;
    }
  }
  if (classified.status === "none") {
    log.info({ confidence: classified.confidence }, "OpenAI rejected all YouTube candidates");
    throw needsSource(track, candidates.map(audioCandidate), "No eligible audio source was confirmed.");
  }
  if (!selected) {
    log.info({ reason: classified.status === "fallback" ? classified.reason : "unsafe-selection", title: track.title, artist: track.artist }, "OpenAI did not select a recording; using deterministic matching");
    const selectedId = selectRequestedVideo(track, candidates);
    selected = preferred.find((candidate) => candidate.id === selectedId);
  }
  if (!selected) throw new UnrecoverableError(sourceSelectionMessage(track, candidates.map(audioCandidate)));
  if (scraping) {
    const remaining = [...candidates];
    for (;;) {
      let verified: ScrapedYoutubeVideo | null;
      try {
        verified = watched.get(selected.id) ?? await (options.scrapeVideo ?? readYoutubeScrapeVideo)(selected.id);
      } catch (error) {
        if (error instanceof YoutubeWatchBlockedError) {
          log.warn({ videoId: selected.id, reason: error.message }, "YouTube watch pages are refused; using the eligible search listing");
          break;
        }
        throw youtubeScrapeDeferred(error) ?? error;
      }
      if (verified && !audioSourceRejection(track, verified)) {
        selected = verified;
        break;
      }
      log.warn({ videoId: selected.id }, "YouTube search candidate was unavailable or changed; checking the next eligible source");
      const index = remaining.findIndex((video) => video.id === selected!.id);
      if (index >= 0) remaining.splice(index, 1);
      const next = selectRequestedVideo(track, remaining);
      selected = remaining.map(audioCandidate).find((candidate) => candidate.id === next);
      if (!selected) throw needsSource(track, remaining.map(audioCandidate), "No available YouTube audio source could be verified for this recording.");
    }
  }
  options.onSelected?.(selected);
  return selected.id;
}

export const sameRequestedVersion = sameRecordingVersion;

function scrapedVideo(video: ScrapedYoutubeVideo): YtVideo {
  return { id: video.id, title: video.title, channelTitle: video.channel, description: "", categoryId: null,
    durationIso: video.durationSec === null ? null : `PT${video.durationSec}S`, viewCount: video.viewCount, rank: video.rank };
}

export function audioCandidate(video: YtVideo): AudioCandidate {
  return { id: video.id, title: video.title, channel: video.channelTitle,
    durationSec: youtubeDurationSeconds(video.durationIso), viewCount: video.viewCount, rank: video.rank };
}

export function selectRequestedVideo(track: RecordingIdentity, candidates: YtVideo[]): string | null {
  const eligible = eligibleAudioSources(track, candidates.map(audioCandidate));
  return eligible.sort((a, b) => compareAudioSources(track, a, b) || (a.rank ?? candidates.findIndex((video) => video.id === a.id)) -
    (b.rank ?? candidates.findIndex((video) => video.id === b.id)))[0]?.id ?? null;
}

const leadArtist = leadArtistName;

/** Recheck pinned/imported sources before either local delivery or remote handoff. Never substitute. */
export async function validateRequestedVideo(userId: string, track: { title: string; artist: string; durationSec: number | null }, videoId: string,
  options: { scrapeVideo?: typeof readYoutubeScrapeVideoOrListing } = {}) {
  const user = await getDb().query.users.findFirst({ where: eq(schema.users.id, userId), columns: { status: true } });
  if (user?.status !== "active") throw new YoutubeAuthError("The requesting member no longer has approved access.");
  const scraping = youtubeScrapingAuthorized();
  let candidate: AudioCandidate | null;
  if (scraping) {
    try {
      candidate = await (options.scrapeVideo ?? readYoutubeScrapeVideoOrListing)(videoId,
        { queries: audioSearchQueries(`${leadArtist(track.artist)} ${track.title}`).map((round) => round.q) });
    } catch (error) {
      throw youtubeScrapeDeferred(error) ?? error;
    }
  } else {
    const [video] = await videosById(await getAccessToken(userId), [videoId]);
    candidate = video ? audioCandidate(video) : null;
  }
  if (!candidate) throw new UnrecoverableError(scraping
    ? "Pinned YouTube source metadata is unavailable. Choose an available audio source."
    : "Pinned YouTube source metadata is unavailable. Reconnect YouTube or choose an available audio source.");
  if (audioSourceRejection(track, candidate, "member")) throw new UnrecoverableError(`Pinned source rejected. ${sourceSelectionMessage(track, [candidate], "member")} Choose the same recording's audio; no substitute was selected.`);
}

function toVideo(v: VideoResource): YtVideo | null {
  if (!v || typeof v.id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(v.id) ||
    typeof v.snippet?.title !== "string" || typeof v.snippet.channelTitle !== "string" ||
    !v.snippet.title.trim() || !v.snippet.channelTitle.trim()) return null;
  return {
    id: v.id,
    title: v.snippet.title,
    channelTitle: v.snippet.channelTitle,
    description: typeof v.snippet.description === "string" ? v.snippet.description : "",
    categoryId: typeof v.snippet.categoryId === "string" ? v.snippet.categoryId : null,
    durationIso: typeof v.contentDetails?.duration === "string" ? v.contentDetails.duration : null,
    viewCount: validatedViewCount(v.statistics?.viewCount),
  };
}

/** Pages through every video the user has liked (YouTube + YouTube Music share this list). */
export async function* likedVideos(token: string): AsyncGenerator<YtVideo> {
  let pageToken: string | undefined;
  do {
    const page = await httpJson<{ items: VideoResource[]; nextPageToken?: string }>(`${API}/videos`, {
      headers: { authorization: `Bearer ${token}` },
      query: { myRating: "like", part: "snippet,contentDetails,statistics", maxResults: 50, pageToken },
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
      query: { id: ids.slice(i, i + 50).join(","), part: "snippet,contentDetails,statistics", maxResults: 50 },
    });
    if (!page || !Array.isArray(page.items)) throw new Error("YouTube returned unavailable or invalid video metadata. Matching will retry.");
    for (const item of page.items) {
      const v = toVideo(item);
      if (v) out.push(v);
    }
  }
  return out;
}
