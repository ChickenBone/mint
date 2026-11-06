import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { createChartSourceServer } from "../../../services/chart-source/service.mjs";
import { CHARTS, type ChartSnapshot } from "../src/lib/charts";
import { ChartProviderError } from "../src/lib/chart-providers";
import { chartSourceOrigin, fetchChartSource } from "../src/lib/chart-source";
import type { ChartCacheStore } from "../src/lib/chart-cache";

const now = Date.parse("2026-11-06T12:00:00Z");
const chart = CHARTS[0]!;
const snapshot: ChartSnapshot = {
  entries: [1, 2].map((rank) => ({
    id: `fictional-${rank}`, rank, title: `Fictional Song ${rank}`, artist: "Fictional Artist", album: null,
    durationSec: 180, recordingId: null, isrc: null, url: "https://music.apple.com/", artwork: null, genres: [],
  })),
  fetchedAt: new Date(now).toISOString(), providerUpdatedAt: new Date(now).toISOString(),
  revision: "fixture", period: "Provider-defined period", notice: null,
};
function memory() {
  const values = new Map<string, string>();
  const store: ChartCacheStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value, _seconds, absent) => {
      if (absent && values.has(key)) return false;
      values.set(key, value); return true;
    },
    release: async (key, value) => { if (values.get(key) === value) values.delete(key); },
  };
  return { store, values };
}
async function serve(t: TestContext, options: Parameters<typeof createChartSourceServer>[0]) {
  const server = createChartSourceServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
test("standalone API serves only supported chart metadata and a rank-preserving top song", async (t) => {
  let calls = 0;
  const origin = await serve(t, { store: memory().store, now: () => now,
    load: async (definition) => { assert.equal(definition.id, chart.id); calls++; return snapshot; } });
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200); assert.deepEqual(await health.json(), { status: "ok" });
  const catalog = await fetch(`${origin}/v1/charts`);
  assert.equal((await catalog.json()).charts.length, CHARTS.length);
  const top = await fetch(`${origin}/v1/charts/apple-us?limit=1`);
  assert.equal(top.status, 200); assert.equal(top.headers.get("cache-control"), "no-store");
  const body = await top.json();
  assert.equal(body.chart.territory, chart.territory);
  assert.deepEqual(body.snapshot.entries.map((entry: { rank: number }) => entry.rank), [1]);
  assert.equal(body.snapshot.revision, snapshot.revision);
  const result = await fetchChartSource(chart, origin, fetch, now);
  assert.equal(result.status, "fresh"); assert.equal(result.snapshot?.entries.length, 2);
  assert.equal(result.snapshot?.fetchedAt, snapshot.fetchedAt);
  assert.equal(result.snapshot?.providerUpdatedAt, snapshot.providerUpdatedAt);
  assert.equal(calls, 1, "Top-song requests share the full chart cache");
  assert.ok(!JSON.stringify(body).includes("item"), "No member playback or acquisition data");
});
test("standalone endpoints reject proxies, malformed limits and mutation without fetching", async (t) => {
  let calls = 0;
  const origin = await serve(t, { store: memory().store, load: async () => { calls++; return snapshot; } });
  for (const query of ["limit=0", "limit=51", "limit=1&limit=2", "limit=1.5", "url=https://example.com", "country=xx", "refresh=true"]) {
    assert.equal((await fetch(`${origin}/v1/charts/apple-us?${query}`)).status, 400);
  }
  for (const path of ["/v1/charts/global", "/v1/charts/apple-xx", "/proxy", "/v1/charts/apple-us/audio"]) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404);
  }
  const mutation = await fetch(`${origin}/v1/charts/apple-us`, { method: "POST", body: "{}" });
  assert.equal(mutation.status, 405); assert.equal(mutation.headers.get("allow"), "GET");
  assert.equal(calls, 0);
});
test("rate limiting ignores client supplied forwarding headers", async (t) => {
  const origin = await serve(t, { store: memory().store, now: () => now });
  for (let index = 0; index < 120; index++)
    assert.equal((await fetch(`${origin}/v1/charts`, { headers: { "x-forwarded-for": `fictional-${index}` } })).status, 200);
  const limited = await fetch(`${origin}/v1/charts`);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "60");
});
test("disabled, Redis-down and provider failures report unavailable, not empty", async (t) => {
  let calls = 0;
  const load = async () => { calls++; return snapshot; };
  const disabled = await serve(t, { store: memory().store, enabled: false, load });
  const disabledResult = await fetchChartSource(chart, disabled, fetch, now);
  assert.equal(disabledResult.status, "error"); assert.equal(disabledResult.snapshot, null);
  assert.match(disabledResult.notice!, /disabled/); assert.equal(calls, 0);
  const broken = await serve(t, { store: { ...memory().store, get: async () => { throw new Error("private credentials must not appear"); } },
    load, ready: async () => false });
  assert.equal((await fetch(`${broken}/healthz`)).status, 503);
  const brokenResult = await fetchChartSource(chart, broken, fetch, now);
  assert.equal(brokenResult.status, "error"); assert.equal(brokenResult.snapshot, null);
  assert.match(brokenResult.notice!, /cache is unavailable/); assert.equal(calls, 0);
  const limited = await serve(t, { store: memory().store, now: () => now,
    load: async () => { throw new ChartProviderError("Provider rate limit reached.", 600); } });
  const response = await fetch(`${limited}/v1/charts/apple-us`);
  assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "600");
  const limitedResult = await fetchChartSource(chart, limited, fetch, now);
  assert.equal(limitedResult.status, "error");
  assert.equal(limitedResult.retryAt, new Date(now + 600_000).toISOString());
});
test("provider failures keep bounded stale ranks and revisions through the standalone API", async (t) => {
  const cache = memory();
  const old = { ...snapshot, fetchedAt: new Date(now - 3601_000).toISOString() };
  cache.values.set(`mint:charts:v1:${chart.id}`, JSON.stringify(old));
  const origin = await serve(t, { store: cache.store, now: () => now,
    load: async () => { throw new ChartProviderError("Provider unavailable.", 300); } });
  const result = await fetchChartSource(chart, origin, fetch, now);
  assert.equal(result.status, "stale"); assert.deepEqual(result.snapshot?.entries, snapshot.entries);
  assert.equal(result.snapshot?.revision, old.revision); assert.equal(result.snapshot?.fetchedAt, old.fetchedAt);
  assert.match(result.notice!, /unavailable/);
});
test("remote source validates origin, scope, bounded data, cache states and ranks", async () => {
  for (const value of ["ftp://source", "http://user:password@source", "https://source/path", "https://source?url=elsewhere", "https://source/#fragment"])
    assert.throws(() => chartSourceOrigin(value));
  assert.equal(chartSourceOrigin("http://chart-source:3090").origin, "http://chart-source:3090");
  const valid = { chart, snapshot, status: "fresh", notice: null, retryAt: null };
  const transport: typeof fetch = async (input, init) => {
    assert.equal(String(input), "http://chart-source:3090/v1/charts/apple-us");
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    assert.deepEqual(init?.headers, { accept: "application/json" });
    return Response.json(valid);
  };
  assert.equal((await fetchChartSource(chart, "http://chart-source:3090", transport, now)).status, "fresh");
  for (const value of [
    { ...valid, chart: { ...chart, territory: "Worldwide" } },
    { ...valid, status: "empty" },
    { ...valid, snapshot: null },
    { ...valid, snapshot: { ...snapshot, fetchedAt: new Date(now - 8 * 86400_000).toISOString() } },
    { ...valid, snapshot: { ...snapshot, fetchedAt: new Date(now + 600_000).toISOString() } },
    { ...valid, snapshot: { ...snapshot, entries: [snapshot.entries[0], snapshot.entries[0]] } },
    { ...valid, snapshot: { ...snapshot, entries: [{ ...snapshot.entries[0], rank: 2 }] } },
  ]) await assert.rejects(fetchChartSource(chart, "http://chart-source:3090", async () => Response.json(value), now));
  const delayed = await fetchChartSource(chart, "http://chart-source:3090", async () => Response.json({
    ...valid, snapshot: { ...snapshot, providerUpdatedAt: new Date(now - 9 * 86400_000).toISOString() },
  }), now);
  assert.equal(delayed.status, "stale"); assert.match(delayed.notice!, /not published/);
  const empty = await fetchChartSource(chart, "http://chart-source:3090", async () => Response.json({
    ...valid, status: "empty", snapshot: { ...snapshot, entries: [] },
  }), now);
  assert.equal(empty.status, "empty");
  await assert.rejects(fetchChartSource(chart, "http://chart-source:3090", async () => new Response("x".repeat(2_000_001)), now), /safety limit/);
});
