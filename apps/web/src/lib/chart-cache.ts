import { createHash, randomUUID } from "node:crypto";
import { chartSnapshotSchema, type ChartDefinition, type ChartSnapshot } from "./charts";
import { ChartProviderError, fetchChart, validChartArtwork } from "./chart-providers";
import { z } from "zod";
import type { PublicCacheStore } from "@mint/core/public-cache";

export type ChartCacheStore = PublicCacheStore;
export interface CachedChart {
  snapshot: ChartSnapshot | null; status: "fresh" | "stale" | "empty" | "error"; notice: string | null; retryAt: string | null;
}
export const CHART_FRESH_SECONDS = 3600;
export const CHART_KEEP_SECONDS = 7 * 86400;
export function chartCacheKey(chart: ChartDefinition) {
  return `mint:charts:v2:${chart.provider}:${createHash("sha256").update(JSON.stringify([
    chart.id, chart.provider, chart.country ?? null, chart.genre ?? null, chart.territory,
  ])).digest("hex")}`;
}
function validSnapshot(snapshot: ChartSnapshot, chart: ChartDefinition, now: number) {
  const age = now - Date.parse(snapshot.fetchedAt);
  return age >= -300_000 && age < CHART_KEEP_SECONDS * 1000 &&
    snapshot.entries.every((entry, index) => entry.rank === index + 1 && validChartArtwork(chart.provider, entry.artwork)) &&
    new Set(snapshot.entries.map((entry) => entry.id)).size === snapshot.entries.length;
}
function readSnapshot(raw: string | null): ChartSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = chartSnapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) console.error("Invalid chart cache snapshot; refreshing provider data");
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    console.error("Malformed chart cache JSON; refreshing provider data");
    return null;
  }
}
export async function cachedChart(chart: ChartDefinition, store: ChartCacheStore, load = fetchChart, now = Date.now()): Promise<CachedChart> {
  const key = chartCacheKey(chart), raw = await store.get(key);
  const parsed = readSnapshot(raw);
  const snapshot = parsed && validSnapshot(parsed, chart, now) ? parsed : null;
  const providerDelayed = !!snapshot?.providerUpdatedAt && now - Date.parse(snapshot.providerUpdatedAt) > 8 * 86400_000;
  const result = (notice: string | null, retryAt: string | null): CachedChart => ({
    snapshot, status: snapshot ? (notice || providerDelayed ? "stale" : snapshot.entries.length ? "fresh" : "empty") : "error",
    notice: notice ?? (providerDelayed ? "The provider has not published a recent update. This is its latest published ranking." : snapshot?.notice ?? null), retryAt,
  });
  if (snapshot && now - Date.parse(snapshot.fetchedAt) < CHART_FRESH_SECONDS * 1000) return result(null, null);
  const cooldownKey = `mint:charts:cooldown:${chart.provider}`;
  const cooldown = await store.get(cooldownKey);
  if (cooldown) {
    try {
      const state = z.object({ notice: z.string().max(1000), retryAt: z.iso.datetime() }).parse(JSON.parse(cooldown));
      return result(state.notice, state.retryAt);
    } catch {
      console.error("Invalid chart provider cooldown; provider requests remain paused", { provider: chart.provider });
      return result("The chart provider cooldown is unavailable. The cache will be checked again shortly.", new Date(now + 60_000).toISOString());
    }
  }
  const lease = randomUUID(), lock = `${key}:refresh`;
  if (!await store.set(lock, lease, 30, true)) {
    if (!snapshot) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const ready = readSnapshot(await store.get(key));
        if (ready && validSnapshot(ready, chart, now)) return {
          snapshot: ready, status: ready.entries.length ? "fresh" : "empty", notice: ready.notice, retryAt: null,
        };
        if (!await store.get(lock)) break;
      }
    }
    return result("A chart refresh is in progress. Try again shortly.", new Date(now + 10000).toISOString());
  }
  try {
    // Keep this throttle until expiry, including after a fetch completes. Apple uses two calls per refresh.
    if (!await store.set(`mint:charts:throttle:${chart.provider}`, lease, 10, true))
      return result("Provider requests are spaced out. Try again in ten seconds.", new Date(now + 10000).toISOString());
    const next = chartSnapshotSchema.parse(await load(chart));
    if (!validSnapshot(next, chart, now)) throw new ChartProviderError("The provider returned an invalid ranking.");
    if (!await store.publish(key, JSON.stringify(next), CHART_KEEP_SECONDS, lock, lease))
      return result("The chart refresh lease expired. Mint will check the cache again shortly.", new Date(now + 10000).toISOString());
    const delayed = !!next.providerUpdatedAt && now - Date.parse(next.providerUpdatedAt) > 8 * 86400_000;
    return { snapshot: next, status: delayed ? "stale" : next.entries.length ? "fresh" : "empty", retryAt: null,
      notice: delayed ? "The provider has not published a recent update. This is its latest published ranking." : next.notice };
  } catch (error) {
    console.error(`Chart refresh failed (${chart.id})`, error instanceof Error ? error.name : "Unknown error");
    const notice = error instanceof ChartProviderError ? error.message : "The provider timed out or returned an invalid response. Mint will retry; cached rankings are kept.";
    const seconds = error instanceof ChartProviderError ? error.retrySeconds : 300;
    const retryAt = new Date(now + seconds * 1000).toISOString();
    await store.set(cooldownKey, JSON.stringify({ notice, retryAt }), seconds);
    return result(notice, retryAt);
  } finally { await store.release(lock, lease); }
}
