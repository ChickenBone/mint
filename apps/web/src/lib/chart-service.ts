import { CHANNEL, publish } from "@mint/core/events";
import { getDb, schema } from "@mint/core/db";
import { createRedis, getRedis } from "@mint/core/redis";
import { redisPublicCacheStore } from "@mint/core/public-cache";
import { PLAYABLE } from "@mint/core/playback";
import { MusicError } from "@mint/core/music";
import { toTrackView } from "@mint/core/views";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { CHARTS, chartIdentity, chartKey, compatibleChartRecording, matchChartEntry, type ChartEntry, type ChartPage, type ChartDefinition } from "./charts";
import { cachedChart, type CachedChart, type ChartCacheStore } from "./chart-cache";
import { cachedChartSource } from "./chart-source";
import { videoMatchesRequest, type RequestChoice } from "./request-match";
import { readRequestRecording, requestRecording, searchRecordings, youtubeSource } from "./music-requests";
import { trackPlayerItem } from "./player-protocol";

const connections = globalThis as typeof globalThis & { __mintChartRedis?: ReturnType<typeof createRedis> };
function cacheStore(): ChartCacheStore {
  if (!connections.__mintChartRedis) {
    connections.__mintChartRedis = createRedis({ maxRetriesPerRequest: 1, commandTimeout: 2500, connectTimeout: 2500 });
    connections.__mintChartRedis.on("error", (error) => console.error("Chart cache connection failed", error.message));
  }
  const redis = connections.__mintChartRedis;
  return redisPublicCacheStore(() => redis);
}
async function loadChart(chart: ChartDefinition): Promise<CachedChart> {
  if (process.env.MINT_CHARTS_ENABLED === "false") return { snapshot: null, status: "error", retryAt: null,
    notice: "Charts are disabled on this instance. The operator can enable MINT_CHARTS_ENABLED on the web service." };
  if (process.env.MINT_CHART_SOURCE_URL) {
    try { return await cachedChartSource(chart, process.env.MINT_CHART_SOURCE_URL); }
    catch (error) {
      console.error("Chart source request failed", error instanceof Error ? error.name : "Unknown error");
      return { snapshot: null, status: "error", retryAt: null,
        notice: "The configured chart source is unavailable or returned invalid data. Check MINT_CHART_SOURCE_URL and service health." };
    }
  }
  try { return await cachedChart(chart, cacheStore()); }
  catch (error) {
    console.error("Chart cache unavailable", error instanceof Error ? error.message : "Unknown cache error");
    return { snapshot: null, status: "error", retryAt: null, notice: "The server chart cache is unavailable. Check Redis configuration and connectivity, then retry." };
  }
}
export function chartDefinition(id: string) {
  const chart = CHARTS.find((chart) => chart.id === id);
  if (!chart) throw new MusicError("Chart not found. Choose a collection from Discover.", 404);
  return chart;
}
export async function chartRows(chart: ChartDefinition, entries: ChartEntry[], userId: string | null) {
  if (!entries.length) return [];
  const db = getDb(), t = schema.tracks, links = schema.chartEntryLinks;
  const linked = userId ? await db.select().from(links).where(and(eq(links.userId, userId), eq(links.provider, chart.provider),
    inArray(links.entryId, entries.map((entry) => entry.id)))) : [];
  // Each identity lookup is index-backed and capped. Overfull identities remain ambiguous, never truncated into a match.
  const candidates = await Promise.all(entries.map(async (entry) => {
    const binding = linked.find((link) => link.entryId === entry.id && link.identity === chartIdentity(entry));
    const rows = await db.select({ track: t, playable: sql<boolean>`coalesce(${PLAYABLE},false)` }).from(t).where(or(
      and(sql`mint_search_text(${t.artist}) = ${chartKey(entry.artist)}`, sql`mint_search_text(${t.title}) = ${chartKey(entry.title)}`),
      entry.recordingId ? eq(t.mbRecordingId, entry.recordingId) : undefined,
      binding ? eq(t.id, binding.trackId) : undefined,
    )).limit(21);
    if (rows.length === 21) return { ...entry, availability: "ambiguous" as const, reason: "Too many editions fit this identity. Choose the exact recording.", progress: null, item: null };
    const match = matchChartEntry(entry, rows.map(({ track, playable }) => ({ ...track, playable,
      durationSec: track.durationSec ?? track.existingDurationSec })), binding?.trackId);
    const found = rows.find(({ track }) => track.id === match.trackId);
    return { ...entry, artwork: found?.playable && match.availability === "available" ? toTrackView(found.track).artworkUrl || entry.artwork : entry.artwork,
      availability: match.availability, reason: match.availability === "failed" && found?.track.detail ? found.track.detail : match.reason, progress: match.progress === null ? null : Math.max(0, Math.min(100, Math.round(match.progress * 100))),
      item: userId && found?.playable && match.availability === "available" ? {
        ...trackPlayerItem(toTrackView(found.track)), duration: (found.track.durationSec ?? found.track.existingDurationSec ?? 0) * 1000,
      } : null };
  }));
  return candidates;
}
export async function chartPage(id: string, userId: string | null, offset = 0, limit = 25, revision?: string): Promise<ChartPage> {
  const chart = chartDefinition(id), cached = await loadChart(chart), snapshot = cached.snapshot;
  if (revision && snapshot && revision !== snapshot.revision) throw new MusicError("The chart has changed. Return to the first page for its latest order.", 409);
  const total = snapshot?.entries.length ?? 0;
  return { chart, status: cached.status, notice: cached.notice, retryAt: cached.retryAt,
    period: snapshot?.period ?? null, providerUpdatedAt: snapshot?.providerUpdatedAt ?? null, fetchedAt: snapshot?.fetchedAt ?? null,
    revision: snapshot?.revision ?? null, total, offset, nextOffset: offset + limit < total ? offset + limit : null,
    member: !!userId, items: await chartRows(chart, snapshot?.entries.slice(offset, offset + limit) ?? [], userId) };
}
function chartChoiceMatches(entry: ChartEntry, choice: RequestChoice) {
  if (choice.kind === "recording") {
    return compatibleChartRecording(entry, choice.recording)
      && (!entry.album || Boolean(choice.recording.album && chartKey(entry.album) === chartKey(choice.recording.album)));
  }
  return videoMatchesRequest(entry, choice.video);
}

async function linkChartRequest(userId: string, provider: ChartDefinition["provider"], entry: ChartEntry, result: { trackId: string; stage: string; needsQueue: boolean }) {
  await getDb().insert(schema.chartEntryLinks).values({ userId, provider, entryId: entry.id,
    identity: chartIdentity(entry), trackId: result.trackId }).onConflictDoUpdate({
    target: [schema.chartEntryLinks.userId, schema.chartEntryLinks.provider, schema.chartEntryLinks.entryId],
    set: { identity: chartIdentity(entry), trackId: result.trackId },
  });
  return { status: "requested" as const, ...result };
}

export async function chartAcquisition(userId: string, input: { chart: string; entry: string; token?: string; youtubeUrl?: string; existingTrackId?: string }) {
  const definition = chartDefinition(input.chart), cached = await loadChart(definition);
  const entry = cached.snapshot?.entries.find((entry) => entry.id === input.entry);
  if (!entry) throw new MusicError("This chart entry is no longer available. Reload the chart before requesting it.", 409);
  const [local] = await chartRows(definition, [entry], userId);
  if (local?.availability === "available") return { status: "available" as const };
  const query = `${entry.artist} ${entry.title}`.slice(0, 100);
  if (local?.availability === "ambiguous" && !input.token) return { status: "resolve" as const,
    message: local.reason, query, results: [] };
  let token = input.token;
  if (!token && !input.youtubeUrl) {
    const results = await searchRecordings(userId, query, fetch, entry.isrc);
    const safe = results.filter((result) => compatibleChartRecording(entry, result) &&
      (entry.recordingId === result.id || entry.durationSec && result.durationSec) &&
      (!entry.isrc || result.isrcs?.includes(entry.isrc)) &&
      (!entry.album || result.album && chartKey(entry.album) === chartKey(result.album)));
    if (safe.length === 1) token = safe[0]!.token;
  }
  if (!token) {
    const { NeedsVideoError, resolveAndRequest } = await import("./resolve-request");
    try {
      const result = await resolveAndRequest(userId, query, input.youtubeUrl, fetch, {
        accept: (choice) => chartChoiceMatches(entry, choice),
        allowUnmatchedUrl: false,
        durationSec: entry.durationSec,
        existingTrackId: input.existingTrackId,
      });
      return linkChartRequest(userId, definition.provider, entry, result);
    } catch (error) {
      if (error instanceof NeedsVideoError) return { status: "needs-video" as const, message: error.message, query };
      throw error;
    }
  }
  const recording = readRequestRecording(userId, token);
  if (!compatibleChartRecording(entry, recording)) throw new MusicError("That recording differs in artist, title, version or duration. Choose the chart's exact recording; nothing was requested.", 409);
  return linkChartRequest(userId, definition.provider, entry, await requestRecording(userId, token, input.youtubeUrl, input.existingTrackId));
}

export function catalogBusy(error: unknown) {
  return error instanceof MusicError && (error.status === 429 || error.status === 503) && /busy|could not be reached|rate limited/i.test(error.message);
}

/** Record the request immediately. Matching runs afterwards so the chart stays usable. */
export async function acceptChartRequest(userId: string, input: { chart: string; entry: string; token?: string; youtubeUrl?: string }) {
  if (input.youtubeUrl) youtubeSource(input.youtubeUrl);
  if (input.token) return { ...(await chartAcquisition(userId, input)), needsMatch: false as const };
  const definition = chartDefinition(input.chart), cached = await loadChart(definition);
  const entry = cached.snapshot?.entries.find((item) => item.id === input.entry);
  if (!entry) throw new MusicError("This chart entry is no longer available. Reload the chart before requesting it.", 409);
  const [local] = await chartRows(definition, [entry], userId);
  if (local?.availability === "available") return { status: "available" as const, needsMatch: false as const };
  const query = `${entry.artist} ${entry.title}`.slice(0, 100);
  if (local?.availability === "ambiguous") return { status: "resolve" as const, message: local.reason, query, results: [] as [], needsMatch: false as const };
  const db = getDb();
  const links = schema.chartEntryLinks;
  const queued = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chart:${userId}:${definition.provider}:${entry.id}`}, 783))`);
    const [link] = await tx.select().from(links).where(and(eq(links.userId, userId), eq(links.provider, definition.provider), eq(links.entryId, entry.id))).limit(1);
    const linked = link ? (await tx.select().from(schema.tracks).where(eq(schema.tracks.id, link.trackId)).limit(1))[0] : undefined;
    if (linked && (linked.stage === "ready" || linked.filePath)) return { status: "available" as const, needsMatch: false as const, track: undefined as undefined };
    if (linked && linked.stage !== "failed") return { status: "requested" as const, trackId: linked.id, stage: linked.stage, needsQueue: false, needsMatch: false as const, track: undefined };
    const trackId = linked?.id;
    const [track] = trackId
      ? await tx.update(schema.tracks).set({ stage: "queued", progress: 0, error: null, detail: "Queued for matching" }).where(eq(schema.tracks.id, trackId)).returning()
      : await tx.insert(schema.tracks).values({
        title: entry.title, artist: entry.artist, album: entry.album, durationSec: entry.durationSec ? Math.round(entry.durationSec) : null, detail: "Queued for matching",
      }).returning();
    if (!track) throw new MusicError("The song could not be queued.", 503);
    await tx.insert(schema.userTracks).values({ userId, trackId: track.id, origin: "request" }).onConflictDoNothing();
    await tx.insert(links).values({ userId, provider: definition.provider, entryId: entry.id, identity: chartIdentity(entry), trackId: track.id }).onConflictDoUpdate({
      target: [links.userId, links.provider, links.entryId],
      set: { identity: chartIdentity(entry), trackId: track.id },
    });
    return { status: "requested" as const, trackId: track.id, stage: track.stage, needsQueue: false, needsMatch: true as const, track };
  });
  if (queued.needsMatch && queued.track) await publish(getRedis(), CHANNEL.public, { type: "track", data: toTrackView(queued.track) }).catch(() => undefined);
  const { track: _track, ...result } = queued;
  return result;
}
