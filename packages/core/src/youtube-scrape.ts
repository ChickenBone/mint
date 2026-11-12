import { z } from "zod";
import {
  audioSearchQueries,
  audioSearchSatisfied,
  normalizeRecordingText,
  sourceKind,
  validatedViewCount,
  YoutubeSearchDeferredError,
  type AudioCandidate,
  type RecordingIdentity,
} from "./matching";
import {
  getPublicReadCache,
  PublicCacheUnavailableError,
  PublicProviderBusyError,
  publicCacheKey,
  publicRetryAfter,
  type PublicReadCache,
  type PublicReadResult,
} from "./public-cache";

const PROVIDER = "YouTubeMetadata";
// Watch pages are challenged independently of search pages, so they cool down separately.
const WATCH_PROVIDER = "YouTubeWatch";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const MAX_RESULTS = 10;
const MAX_NODES = 80_000;

const videoSchema = z.object({
  id: z.string().regex(VIDEO_ID),
  title: z.string().trim().min(1).max(1000),
  channel: z.string().trim().min(1).max(1000),
  durationSec: z.number().finite().positive().max(86_400).nullable(),
  viewCount: z.number().int().nonnegative().safe().nullable(),
  rank: z.number().int().nonnegative(),
  watchVerified: z.boolean().optional(),
});

export type ScrapedYoutubeVideo = z.infer<typeof videoSchema>;

type AccessReason = "http-401" | "http-403" | "redirect" | "challenge" | "sign-in" | "age-check" | "content-check" | "restricted" | "refused";

export class YoutubeScrapeAccessError extends PublicProviderBusyError {
  constructor(public readonly reason: AccessReason = "refused") {
    super(PROVIDER, 3600);
    this.name = "YoutubeScrapeAccessError";
    this.message = "YouTube refused automated metadata access.";
  }
}

export class YoutubeScrapeRateLimitError extends PublicProviderBusyError {}

/** Watch-page metadata is refused or paused; public search listings remain usable evidence. */
export class YoutubeWatchBlockedError extends YoutubeScrapeRateLimitError {
  constructor(public readonly blocked: PublicProviderBusyError) {
    super(WATCH_PROVIDER, blocked.retryAfter);
    this.name = "YoutubeWatchBlockedError";
    this.message = blocked instanceof YoutubeScrapeAccessError
      ? `YouTube refused watch-page metadata (${blocked.reason}); search listings remain usable.`
      : "YouTube watch-page metadata is paused; search listings remain usable.";
  }
}

export class YoutubeScrapeUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "YoutubeScrapeUnavailableError";
  }
}

/** Operators must explicitly confirm permission before using the public-page adapter. */
export function youtubeScrapingAuthorized(): boolean {
  const value = process.env.YOUTUBE_SCRAPE_AUTHORIZED?.trim().toLowerCase();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new Error("YOUTUBE_SCRAPE_AUTHORIZED must be true or false.");
}

function requireScrapingAuthorization() {
  if (!youtubeScrapingAuthorized()) {
    throw new Error("YouTube metadata scraping requires YOUTUBE_SCRAPE_AUTHORIZED=true.");
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  const item = object(value);
  if (!item) return null;
  const simple = typeof item.simpleText === "string" ? item.simpleText : null;
  const runs = Array.isArray(item.runs)
    ? item.runs.map((run) => object(run)?.text).filter((part): part is string => typeof part === "string").join("")
    : null;
  const result = (simple ?? runs)?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return result && result.length <= 1000 ? result : null;
}

function duration(value: string | null): number | null {
  if (!value || !/^\d+(?::[0-5]\d){1,2}$/.test(value)) return null;
  const parts = value.split(":").map(Number);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86_400 ? seconds : null;
}

function viewCount(value: string | null): number | null {
  if (!value) return null;
  if (/^no views$/i.test(value)) return 0;
  const match = /^((?:\d{1,3}(?:,\d{3})+)|\d+) views?$/i.exec(value);
  return match ? validatedViewCount(match[1]!.replaceAll(",", "")) : null;
}

function visibleChallenge(html: string): boolean {
  const lower = html.toLowerCase();
  let cursor = 0;
  for (;;) {
    let start = lower.indexOf("<script", cursor);
    while (start >= 0 && !/[\s/>]/.test(lower[start + 7] ?? "")) start = lower.indexOf("<script", start + 7);
    const visible = lower.slice(cursor, start < 0 ? lower.length : start);
    if (/<form[^>]+(?:captcha|consent|sorry)/.test(visible) ||
      /our systems have detected unusual traffic from your computer network/.test(visible)) return true;
    if (start < 0) return false;
    const tagEnd = lower.indexOf(">", start + 7);
    const closing = tagEnd < 0 ? -1 : lower.indexOf("</script", tagEnd + 1);
    const closeEnd = closing < 0 ? -1 : lower.indexOf(">", closing + 8);
    if (closeEnd < 0) return false;
    cursor = closeEnd + 1;
  }
}

function assignedJson(html: string, name: "ytInitialData" | "ytInitialPlayerResponse"): Record<string, unknown> {
  if (visibleChallenge(html)) throw new YoutubeScrapeAccessError("challenge");
  const target = `(?:(?:window\\.)?${name}|window\\[['"]${name}['"]\\])`;
  const marker = new RegExp(`(?:^|[>;\\r\\n])\\s*(?:(?:var|let|const)\\s+)?${target}\\s*=\\s*\\{`).exec(html);
  if (!marker) {
    if (/(?:unusual traffic|confirm you.re not a bot|<form[^>]+(?:captcha|consent|sorry))/i.test(html)) {
      throw new YoutubeScrapeAccessError("challenge");
    }
    throw new YoutubeScrapeUnavailableError("YouTube returned a page without usable metadata.");
  }
  const start = marker.index + marker[0].length - 1;
  let depth = 0, nesting = 0, quoted = false, escaped = false;
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
    } else if (character === "\"") quoted = true;
    else if (character === "{" || character === "[") {
      if (++nesting > 100) throw new YoutubeScrapeUnavailableError("YouTube metadata exceeded its nesting budget.");
      if (character === "{") depth++;
    } else if (character === "}" || character === "]") {
      nesting--;
      if (character !== "}" || --depth !== 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(html.slice(start, index + 1));
      } catch (error) {
        throw new YoutubeScrapeUnavailableError("YouTube returned invalid embedded metadata.", { cause: error });
      }
      const result = object(parsed);
      if (result) return result;
      break;
    }
  }
  throw new YoutubeScrapeUnavailableError("YouTube returned incomplete embedded metadata.");
}

function searchVideo(value: unknown, rank: number): ScrapedYoutubeVideo | null {
  const item = object(value);
  if (!item) return null;
  const overlays = Array.isArray(item.thumbnailOverlays) ? item.thumbnailOverlays : [];
  const overlayDuration = overlays.map((overlay) => text(object(object(overlay)?.thumbnailOverlayTimeStatusRenderer)?.text)).find(Boolean) ?? null;
  const parsed = videoSchema.safeParse({
    id: item.videoId,
    title: text(item.title),
    channel: text(item.ownerText) ?? text(item.longBylineText) ?? text(item.shortBylineText),
    durationSec: duration(text(item.lengthText) ?? overlayDuration),
    viewCount: viewCount(text(item.viewCountText)),
    rank,
  });
  return parsed.success ? parsed.data : null;
}

/** Parse public search results without executing any page script. */
export function parseYoutubeSearchPage(html: string): ScrapedYoutubeVideo[] {
  const root = assignedJson(html, "ytInitialData");
  const contents = object(root.contents);
  const columns = object(contents?.twoColumnSearchResultsRenderer);
  const primary = object(columns?.primaryContents);
  const sections = object(primary?.sectionListRenderer)?.contents;
  if (!Array.isArray(sections)) {
    throw new YoutubeScrapeUnavailableError("YouTube search metadata has an unsupported layout.");
  }
  const pending: Array<{ value: unknown; depth: number }> = [{ value: sections, depth: 0 }];
  const videos: ScrapedYoutubeVideo[] = [];
  const seen = new Set<string>();
  let visited = 0, renderers = 0, explicitlyEmpty = false;
  while (pending.length && videos.length < MAX_RESULTS) {
    const current = pending.pop()!;
    if (++visited > MAX_NODES || current.depth > 60) {
      throw new YoutubeScrapeUnavailableError("YouTube search metadata exceeded its parsing budget.");
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index--) {
        pending.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    const node = object(current.value);
    if (!node) continue;
    const message = text(object(node.messageRenderer)?.text);
    if (message && /\bno results found\b/i.test(message)) explicitlyEmpty = true;
    // Signed-out searches containing some words show only an age gate; it is empty for this query, not a provider outage.
    const promo = object(node.backgroundPromoRenderer);
    if (promo && /^confirm your age$/i.test(text(promo.title)?.trim() ?? "")) explicitlyEmpty = true;
    if ("videoRenderer" in node) {
      renderers++;
      const video = searchVideo(node.videoRenderer, videos.length);
      if (video && !seen.has(video.id)) {
        seen.add(video.id);
        videos.push(video);
      }
      continue;
    }
    const children = Object.values(node);
    for (let index = children.length - 1; index >= 0; index--) {
      if (typeof children[index] === "object" && children[index] !== null) {
        pending.push({ value: children[index], depth: current.depth + 1 });
      }
    }
  }
  if (renderers && !videos.length) {
    throw new YoutubeScrapeUnavailableError("YouTube search results lack usable video metadata.");
  }
  if (!renderers && !explicitlyEmpty) {
    throw new YoutubeScrapeUnavailableError("YouTube search returned no recognizable result metadata.");
  }
  return videos;
}

/** Read public video metadata only; never retain descriptions or streaming URLs. */
export function parseYoutubeWatchPage(html: string, expectedId: string): ScrapedYoutubeVideo | null {
  if (!VIDEO_ID.test(expectedId)) throw new Error("Invalid YouTube video ID.");
  const root = assignedJson(html, "ytInitialPlayerResponse");
  const playability = object(root.playabilityStatus);
  const status = playability?.status;
  const reason = typeof playability?.reason === "string" ? playability.reason : "";
  if (status !== "OK") {
    if (status === "AGE_CHECK_REQUIRED" || /age.restricted/i.test(reason)) throw new YoutubeScrapeAccessError("age-check");
    if (status === "CONTENT_CHECK_REQUIRED") throw new YoutubeScrapeAccessError("content-check");
    if (/confirm you.re not a bot/i.test(reason)) throw new YoutubeScrapeAccessError("challenge");
    if (status === "LOGIN_REQUIRED" || /sign in/i.test(reason)) throw new YoutubeScrapeAccessError("sign-in");
    if (/members.only/i.test(reason)) throw new YoutubeScrapeAccessError("restricted");
    if (/(?:temporar(?:y|ily)|try again|something went wrong)/i.test(reason)) {
      throw new YoutubeScrapeUnavailableError("YouTube video metadata is temporarily unavailable.");
    }
    if (status === "ERROR" || status === "UNPLAYABLE") return null;
    throw new YoutubeScrapeUnavailableError("YouTube video availability metadata is incomplete.");
  }
  const details = object(root.videoDetails);
  if (!details || details.videoId !== expectedId) {
    throw new YoutubeScrapeUnavailableError("YouTube returned mismatched video metadata.");
  }
  if (details.isPrivate === true || details.isLiveContent === true) return null;
  const seconds = typeof details.lengthSeconds === "string" && /^\d+$/.test(details.lengthSeconds)
    ? Number(details.lengthSeconds) : null;
  const parsed = videoSchema.safeParse({
    id: details.videoId,
    title: details.title,
    channel: details.author,
    durationSec: seconds && Number.isSafeInteger(seconds) && seconds <= 86_400 ? seconds : null,
    viewCount: validatedViewCount(details.viewCount),
    rank: 0,
    watchVerified: true,
  });
  if (!parsed.success) throw new YoutubeScrapeUnavailableError("YouTube returned incomplete video metadata.");
  return parsed.data;
}

interface ScrapeOptions {
  cache?: PublicReadCache;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

const PUBLIC_PATHS = new Set(["/results", "/watch"]);
const REFUSAL_REDIRECT = /^(?:consent\.(?:youtube|google)\.com|accounts\.google\.com|(?:www\.)?google\.com)$/;

/** Classifies a redirect: same-page YouTube hops are followed once; sign-in/consent/challenge pages are refusals. */
export function youtubeScrapeRedirect(from: URL, location: string | null): URL | YoutubeScrapeAccessError | YoutubeScrapeRateLimitError {
  let target: URL;
  try {
    if (!location) throw new Error("missing location");
    target = new URL(location, from);
  } catch {
    return new YoutubeScrapeRateLimitError(PROVIDER, 300);
  }
  if (target.protocol === "https:" && target.hostname === "www.youtube.com" && PUBLIC_PATHS.has(target.pathname)) return target;
  if (REFUSAL_REDIRECT.test(target.hostname)) {
    return new YoutubeScrapeAccessError(target.hostname.startsWith("accounts.") ? "sign-in" : target.hostname.startsWith("consent.") ? "redirect" : "challenge");
  }
  // Unrecognised redirects are treated as a short provider back-off rather than an hour-long refusal.
  return new YoutubeScrapeRateLimitError(PROVIDER, 300);
}

async function page(url: URL, signal: AbortSignal, fetcher: typeof fetch, redirected = false): Promise<string> {
  requireScrapingAuthorization();
  let response: Response;
  try {
    const request = {
      headers: {
        accept: "text/html",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": "Mint/3.5 (public metadata; https://github.com/ChickenBone/mint)",
      },
      redirect: "manual" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      signal,
    };
    response = await fetcher(url, request);
  } catch (error) {
    throw new YoutubeScrapeUnavailableError("YouTube metadata could not be reached.", { cause: error });
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new YoutubeScrapeAccessError(response.status === 401 ? "http-401" : "http-403");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    const next = youtubeScrapeRedirect(url, response.headers.get("location"));
    if (next instanceof URL && !redirected) return page(next, signal, fetcher, true);
    throw next instanceof URL ? new YoutubeScrapeRateLimitError(PROVIDER, 300) : next;
  }
  if (response.status === 429 || response.status === 503 || (!response.ok && response.headers.has("retry-after"))) {
    await response.body?.cancel();
    throw new YoutubeScrapeRateLimitError(PROVIDER, publicRetryAfter(response.headers.get("retry-after")));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new YoutubeScrapeUnavailableError(`YouTube metadata returned HTTP ${response.status}.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new YoutubeScrapeUnavailableError("YouTube returned an empty metadata response.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new YoutubeScrapeUnavailableError("YouTube metadata exceeded its response budget.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof YoutubeScrapeUnavailableError) throw error;
    throw new YoutubeScrapeUnavailableError("YouTube metadata could not be read completely.", { cause: error });
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readYoutubeScrapeSearch(query: string, options: ScrapeOptions = {}): Promise<ScrapedYoutubeVideo[]> {
  requireScrapingAuthorization();
  const wanted = z.string().trim().min(1).max(500).parse(query);
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", wanted);
  url.searchParams.set("hl", "en");
  const cached = await (options.cache ?? getPublicReadCache()).read({
    provider: PROVIDER,
    key: publicCacheKey(PROVIDER, "search-v1", wanted),
    freshSeconds: 3600,
    keepSeconds: 3600,
    negativeSeconds: 300,
    spacingSeconds: 2,
    timeoutMs: 20_000,
    respectCooldownForFresh: true,
    maxBytes: 32_000,
    signal: options.signal,
    validate: (value) => z.array(videoSchema).max(MAX_RESULTS).parse(value),
    negative: (value) => !value.length,
    load: async (signal) => parseYoutubeSearchPage(await page(url, signal, options.fetcher ?? fetch)),
  });
  if (cached.stale) throw new YoutubeScrapeUnavailableError("YouTube search metadata needs refreshing.");
  return cached.value;
}

export async function readYoutubeScrapeVideo(videoId: string, options: ScrapeOptions = {}): Promise<ScrapedYoutubeVideo | null> {
  requireScrapingAuthorization();
  if (!VIDEO_ID.test(videoId)) throw new Error("Invalid YouTube video ID.");
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", videoId);
  url.searchParams.set("hl", "en");
  let cached: PublicReadResult<ScrapedYoutubeVideo | null>;
  try {
    cached = await (options.cache ?? getPublicReadCache()).read({
      provider: WATCH_PROVIDER,
      key: publicCacheKey(PROVIDER, "video-v1", videoId),
      freshSeconds: 120,
      keepSeconds: 120,
      negativeSeconds: 60,
      spacingSeconds: 2,
      timeoutMs: 20_000,
      respectCooldownForFresh: true,
      maxBytes: 8_000,
      signal: options.signal,
      validate: (value) => videoSchema.nullable().parse(value),
      negative: (value) => value === null,
      load: async (signal) => parseYoutubeWatchPage(await page(url, signal, options.fetcher ?? fetch), videoId),
    });
  } catch (error) {
    if (error instanceof PublicProviderBusyError && !(error instanceof YoutubeWatchBlockedError)) {
      throw new YoutubeWatchBlockedError(error);
    }
    throw error;
  }
  if (cached.stale) throw new YoutubeScrapeUnavailableError("YouTube video metadata needs refreshing.");
  return cached.value;
}

/**
 * Confirms a known ID from its watch page, or from an exact public search listing while watch pages are refused.
 * YouTube often omits a video from a search for its bare ID, so optional title/artist queries (usually still cached
 * from selection) are checked for the same ID too. Only the exact ID is ever accepted; nothing is substituted.
 */
export async function readYoutubeScrapeVideoOrListing(videoId: string, options: ScrapeOptions & { queries?: string[] } = {}): Promise<ScrapedYoutubeVideo | null> {
  try {
    return await readYoutubeScrapeVideo(videoId, options);
  } catch (error) {
    if (!(error instanceof YoutubeWatchBlockedError)) throw error;
    for (const query of [videoId, ...(options.queries ?? [])]) {
      const listing = (await readYoutubeScrapeSearch(query, options)).find((video) => video.id === videoId);
      if (listing) return { ...listing, rank: 0, watchVerified: false };
    }
    throw error;
  }
}

interface ScrapedSearchOptions {
  eligible: (videos: ScrapedYoutubeVideo[]) => AudioCandidate[];
  /** Enables evidence-score early stopping; its catalog-linked video IDs are read before any search. */
  wanted?: RecordingIdentity;
  onDegraded?: (round: number, candidates: ScrapedYoutubeVideo[], error: unknown) => void;
  onWatchBlocked?: (error: YoutubeWatchBlockedError) => void;
  signal?: AbortSignal;
  search?: (query: string) => Promise<ScrapedYoutubeVideo[]>;
  video?: (id: string) => Promise<ScrapedYoutubeVideo | null>;
}

/**
 * Retain eligible completed results if a later non-authorization request fails. When only watch pages are
 * refused, search listings (title, channel, length and views) remain the source evidence instead of pausing.
 */
export async function searchYoutubeScraped(query: string, options: ScrapedSearchOptions): Promise<ScrapedYoutubeVideo[]> {
  const candidates: ScrapedYoutubeVideo[] = [];
  const seen = new Set<string>();
  const checked = new Set<string>();
  const queryWords = normalizeRecordingText(query).split(" ").filter((word) => word.length > 1);
  let detailReads = 0, lyricReads = 0, degraded = false, watchBlocked = false;
  const search = (value: string) => {
    options.signal?.throwIfAborted();
    return options.search ? options.search(value) : readYoutubeScrapeSearch(value, { signal: options.signal });
  };
  const video = async (id: string): Promise<ScrapedYoutubeVideo | null | undefined> => {
    options.signal?.throwIfAborted();
    try {
      return await (options.video ? options.video(id) : readYoutubeScrapeVideo(id, { signal: options.signal }));
    } catch (error) {
      if (!(error instanceof YoutubeWatchBlockedError)) throw error;
      watchBlocked = true;
      options.onWatchBlocked?.(error);
      return undefined;
    }
  };
  const eligibleVerified = () => options.eligible(candidates.filter((candidate) => candidate.watchVerified || watchBlocked));
  const verifyEligible = async () => {
    while (detailReads < 10 && !watchBlocked) {
      const next = options.eligible(candidates).find((candidate) =>
        !checked.has(candidate.id) && !candidates.find((video) => video.id === candidate.id)?.watchVerified);
      if (!next) break;
      const candidate = candidates.find((video) => video.id === next.id)!;
      checked.add(candidate.id);
      detailReads++;
      const detail = await video(candidate.id);
      if (detail === undefined) break;
      if (detail && detail.id === candidate.id) {
        Object.assign(candidate, { ...detail, rank: candidate.rank, watchVerified: true });
      } else {
        candidates.splice(candidates.indexOf(candidate), 1);
      }
    }
  };
  for (const id of [...new Set(options.wanted?.catalogVideoIds ?? [])].slice(0, 3)) {
    if (watchBlocked) break;
    try {
      const detail = await video(id);
      if (detail && detail.id === id && !seen.has(id)) {
        seen.add(id);
        checked.add(id);
        candidates.push({ ...detail, rank: candidates.length, watchVerified: true });
      }
    } catch (error) {
      if (error instanceof YoutubeScrapeAccessError || options.signal?.aborted) throw error;
    }
  }
  if (options.wanted && audioSearchSatisfied(eligibleVerified(), 0, options.wanted)) return candidates;
  for (const [round, searchRound] of audioSearchQueries(query).entries()) {
    try {
      const found = await search(searchRound.q);
      for (const video of found) {
        if (seen.has(video.id)) continue;
        seen.add(video.id);
        candidates.push({ ...video, rank: candidates.length, watchVerified: false });
      }
      await verifyEligible();
      if (audioSearchSatisfied(eligibleVerified(), round, options.wanted)) break;
      for (const candidate of candidates) {
        const words = new Set(normalizeRecordingText(`${candidate.title} ${candidate.channel}`).split(" "));
        const hasQueryWords = queryWords.length > 0 && queryWords.every((word) => words.has(word));
        if (watchBlocked || detailReads >= 10 || lyricReads >= 3 || checked.has(candidate.id) ||
          sourceKind(candidate) !== "lyric" || candidate.viewCount !== null ||
          (!hasQueryWords && !options.eligible([{ ...candidate, viewCount: 0 }]).some((video) => video.id === candidate.id))) continue;
        detailReads++;
        lyricReads++;
        checked.add(candidate.id);
        const detail = await video(candidate.id);
        if (detail && detail.id === candidate.id) Object.assign(candidate, { ...detail, rank: candidate.rank, watchVerified: true });
      }
      await verifyEligible();
    } catch (error) {
      const failure = options.signal?.aborted && error === options.signal.reason
        ? new YoutubeScrapeUnavailableError("YouTube metadata search exceeded its time budget.", { cause: error })
        : error;
      if (failure instanceof YoutubeScrapeAccessError ||
        (failure instanceof PublicProviderBusyError && !(failure instanceof YoutubeScrapeRateLimitError)) ||
        !(failure instanceof YoutubeScrapeUnavailableError || failure instanceof YoutubeScrapeRateLimitError) ||
        !eligibleVerified().length) throw failure;
      degraded = true;
      options.onDegraded?.(round + 1, candidates, failure);
      break;
    }
    if (audioSearchSatisfied(eligibleVerified(), round, options.wanted)) break;
  }
  const hasUnverified = (candidate: ScrapedYoutubeVideo) =>
    !watchBlocked && !candidate.watchVerified && options.eligible([candidate]).some((video) => video.id === candidate.id);
  return degraded ? candidates.filter((candidate) => !hasUnverified(candidate)) : candidates;
}

export function youtubeScrapeDeferred(error: unknown): YoutubeSearchDeferredError | null {
  if (error instanceof YoutubeScrapeAccessError) {
    return new YoutubeSearchDeferredError(`YouTube refused automated metadata access (${error.reason}); check provider access and permission.`, error.retryAfter * 1000);
  }
  if (error instanceof YoutubeScrapeRateLimitError) {
    return new YoutubeSearchDeferredError("YouTube metadata is temporarily rate limited; matching will retry.", error.retryAfter * 1000);
  }
  if (error instanceof PublicProviderBusyError) {
    return new YoutubeSearchDeferredError("YouTube metadata matching is temporarily paused; matching will retry.", error.retryAfter * 1000);
  }
  if (error instanceof PublicCacheUnavailableError || error instanceof YoutubeScrapeUnavailableError) {
    return new YoutubeSearchDeferredError("YouTube metadata is temporarily unavailable; matching will retry.", 30_000);
  }
  return null;
}
