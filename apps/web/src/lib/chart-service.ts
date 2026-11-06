import { getDb, schema } from "@mint/core/db";
import { createRedis } from "@mint/core/redis";
import { PLAYABLE } from "@mint/core/playback";
import { MusicError } from "@mint/core/music";
import { toTrackView } from "@mint/core/views";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { CHARTS, chartIdentity, chartKey, compatibleChartRecording, matchChartEntry, type ChartEntry, type ChartPage, type ChartDefinition } from "./charts";
import { cachedChart, type CachedChart, type ChartCacheStore } from "./chart-cache";
import { fetchChartSource } from "./chart-source";
import { readRequestRecording, requestRecording, searchRecordings } from "./music-requests";
import { trackPlayerItem } from "./player-protocol";

const connections = globalThis as typeof globalThis & { __mintChartRedis?: ReturnType<typeof createRedis> };
function cacheStore(): ChartCacheStore {
  if (!connections.__mintChartRedis) {
    connections.__mintChartRedis = createRedis({ maxRetriesPerRequest: 1, commandTimeout: 2500, connectTimeout: 2500 });
    connections.__mintChartRedis.on("error", (error) => console.error("Chart cache connection failed", error.message));
  }
  const redis = connections.__mintChartRedis;
  return {
    get: (key) => redis.get(key),
    set: async (key, value, seconds, onlyIfAbsent) => (onlyIfAbsent
      ? await redis.set(key, value, "EX", seconds, "NX")
      : await redis.set(key, value, "EX", seconds)) === "OK",
    release: async (key, value) => { await redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, key, value); },
  };
}
async function loadChart(chart: ChartDefinition): Promise<CachedChart> {
  if (process.env.MINT_CHARTS_ENABLED === "false") return { snapshot: null, status: "error", retryAt: null,
    notice: "Charts are disabled on this instance. The operator can enable MINT_CHARTS_ENABLED on the web service." };
  if (process.env.MINT_CHART_SOURCE_URL) {
    try { return await fetchChartSource(chart, process.env.MINT_CHART_SOURCE_URL); }
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
      availability: match.availability, reason: match.reason, progress: match.progress === null ? null : Math.max(0, Math.min(100, Math.round(match.progress * 100))),
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
export async function chartAcquisition(userId: string, input: { chart: string; entry: string; token?: string; youtubeUrl?: string }) {
  const definition = chartDefinition(input.chart), cached = await loadChart(definition);
  const entry = cached.snapshot?.entries.find((entry) => entry.id === input.entry);
  if (!entry) throw new MusicError("This chart entry is no longer available. Reload the chart before requesting it.", 409);
  const [local] = await chartRows(definition, [entry], userId);
  if (local?.availability === "available") return { status: "available" as const };
  let token = input.token;
  if (!token) {
    const results = await searchRecordings(userId, `${entry.artist} ${entry.title}`.slice(0, 100), fetch, entry.isrc);
    const safe = results.filter((result) => compatibleChartRecording(entry, result) &&
      (entry.recordingId === result.id || entry.durationSec && result.durationSec) &&
      (!entry.isrc || result.isrcs?.includes(entry.isrc)) &&
      (!entry.album || result.album && chartKey(entry.album) === chartKey(result.album)));
    if (safe.length !== 1 || local?.availability === "ambiguous") return { status: "resolve" as const,
      message: "Choose the exact recording and, if needed, a source video. Nothing has been requested yet.",
      query: `${entry.artist} ${entry.title}`.slice(0, 100), results };
    token = safe[0]!.token;
  }
  const recording = readRequestRecording(userId, token);
  if (!compatibleChartRecording(entry, recording)) throw new MusicError("That recording differs in artist, title, version or duration. Choose the chart's exact recording; nothing was requested.", 409);
  const result = await requestRecording(userId, token, input.youtubeUrl);
  await getDb().insert(schema.chartEntryLinks).values({ userId, provider: definition.provider, entryId: entry.id,
    identity: chartIdentity(entry), trackId: result.trackId }).onConflictDoUpdate({
    target: [schema.chartEntryLinks.userId, schema.chartEntryLinks.provider, schema.chartEntryLinks.entryId],
    set: { identity: chartIdentity(entry), trackId: result.trackId },
  });
  return { status: "requested" as const, ...result };
}
