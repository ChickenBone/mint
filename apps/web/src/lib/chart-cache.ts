import { randomUUID } from "node:crypto";
import { chartSnapshotSchema, type ChartDefinition, type ChartSnapshot } from "./charts";
import { ChartProviderError, fetchChart } from "./chart-providers";

export interface ChartCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, seconds: number, onlyIfAbsent?: boolean): Promise<boolean>;
  release(key: string, value: string): Promise<void>;
}
export interface CachedChart {
  snapshot: ChartSnapshot | null; status: "fresh" | "stale" | "empty" | "error"; notice: string | null; retryAt: string | null;
}
export const CHART_FRESH_SECONDS = 3600;
export const CHART_KEEP_SECONDS = 7 * 86400;
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
  const key = `mint:charts:v1:${chart.id}`, raw = await store.get(key);
  const parsed = readSnapshot(raw);
  const snapshot = parsed && now - Date.parse(parsed.fetchedAt) < CHART_KEEP_SECONDS * 1000 ? parsed : null;
  const providerDelayed = !!snapshot?.providerUpdatedAt && now - Date.parse(snapshot.providerUpdatedAt) > 8 * 86400_000;
  const result = (notice: string | null, retryAt: string | null): CachedChart => ({
    snapshot, status: snapshot ? (notice || providerDelayed ? "stale" : snapshot.entries.length ? "fresh" : "empty") : "error",
    notice: notice ?? (providerDelayed ? "The provider has not published a recent update. This is its latest published ranking." : snapshot?.notice ?? null), retryAt,
  });
  if (snapshot && now - Date.parse(snapshot.fetchedAt) < CHART_FRESH_SECONDS * 1000) return result(null, null);
  const cooldownKey = `mint:charts:cooldown:${chart.provider}`;
  const cooldown = await store.get(cooldownKey);
  if (cooldown) {
    const state = JSON.parse(cooldown) as { notice: string; retryAt: string };
    return result(state.notice, state.retryAt);
  }
  const lease = randomUUID(), lock = `${key}:refresh`;
  if (!await store.set(lock, lease, 30, true)) return result("A chart refresh is in progress. Try again shortly.", new Date(now + 10000).toISOString());
  try {
    // Keep this throttle until expiry, including after a fetch completes. Apple uses two calls per refresh.
    if (!await store.set(`mint:charts:throttle:${chart.provider}`, lease, 10, true))
      return result("Provider requests are spaced out. Try again in ten seconds.", new Date(now + 10000).toISOString());
    const next = await load(chart);
    await store.set(key, JSON.stringify(next), CHART_KEEP_SECONDS);
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
