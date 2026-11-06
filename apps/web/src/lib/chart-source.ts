import { z } from "zod";
import { chartSnapshotSchema, type ChartDefinition } from "./charts";
import { boundedProviderJson, ChartProviderError } from "./chart-providers";
import { CHART_KEEP_SECONDS, type CachedChart } from "./chart-cache";

export const chartSourceResponseSchema = z.object({
  chart: z.object({ id: z.string(), provider: z.enum(["apple", "listenbrainz", "audius"]), territory: z.string() }),
  snapshot: chartSnapshotSchema.nullable(),
  status: z.enum(["fresh", "stale", "empty", "error"]),
  notice: z.string().max(1000).nullable(),
  retryAt: z.iso.datetime().nullable(),
});

export function chartSourceOrigin(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash)
    throw new Error("MINT_CHART_SOURCE_URL must be an HTTP(S) origin without credentials, paths or query parameters.");
  return url;
}

export async function fetchChartSource(chart: ChartDefinition, origin: string, transport: typeof fetch = fetch, now = Date.now()): Promise<CachedChart> {
  const url = new URL(`/v1/charts/${encodeURIComponent(chart.id)}`, chartSourceOrigin(origin));
  const response = await transport(url, {
    headers: { accept: "application/json" }, redirect: "error",
    signal: AbortSignal.timeout(20_000), cache: "no-store",
  });
  // An unavailable source still supplies its honest cache state, not a fabricated empty chart.
  if (!response.ok && response.status !== 503) await boundedProviderJson(response);
  const body = await boundedProviderJson(response.status === 503
    ? new Response(response.body, { headers: response.headers }) : response);
  const parsed = chartSourceResponseSchema.parse(body);
  if (parsed.chart.id !== chart.id || parsed.chart.provider !== chart.provider || parsed.chart.territory !== chart.territory)
    throw new ChartProviderError("The chart source returned the wrong chart or territory.");
  const snapshot = parsed.snapshot;
  if (snapshot) {
    const age = now - Date.parse(snapshot.fetchedAt);
    if (age >= CHART_KEEP_SECONDS * 1000 || age < -300_000 ||
      new Set(snapshot.entries.map((entry) => entry.id)).size !== snapshot.entries.length ||
      snapshot.entries.some((entry, index) => entry.rank !== index + 1 || entry.artwork !== null))
      throw new ChartProviderError("The chart source returned an invalid or expired ranking.");
  }
  if (response.ok !== !!snapshot || (!!snapshot && parsed.status === "error") ||
    (!snapshot && parsed.status !== "error") ||
    (parsed.status === "empty" && snapshot?.entries.length !== 0) ||
    (parsed.status === "fresh" && !snapshot?.entries.length))
    throw new ChartProviderError("The chart source returned an inconsistent cache state.");
  const delayed = !!snapshot?.providerUpdatedAt && now - Date.parse(snapshot.providerUpdatedAt) > 8 * 86400_000;
  const expired = !!snapshot && now - Date.parse(snapshot.fetchedAt) >= 3600_000;
  return { snapshot, status: delayed || expired ? "stale" : parsed.status,
    notice: delayed ? "The provider has not published a recent update. This is its latest published ranking."
      : expired && !parsed.notice ? "The chart source is serving a cached ranking while awaiting refresh." : parsed.notice,
    retryAt: parsed.retryAt };
}
