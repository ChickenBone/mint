import assert from "node:assert/strict";
import test from "node:test";
import { catalogOrigin, catalogTextMatches, createCatalogDemandQueue, foldCatalogText, lookupCatalogEntity, searchCatalog,
  type CatalogRequestOptions } from "./catalog-client";

const ORIGIN = "http://catalog.test:8080";
const MBID = "5fd10149-6c3b-41b3-a3ae-a6b89fa5eebc";
const env = { MINT_CATALOG_URL: ORIGIN };

const row = (overrides: Record<string, unknown> = {}) => ({
  key: `musicbrainz:global:song:${MBID}`, source: "musicbrainz", origin: "musicbrainz", country: "global", kind: "song",
  provider_id: MBID, title: "Fake Love", artist: "BTS", album: "", genres: [],
  url: `https://musicbrainz.org/recording/${MBID}`, popularity: 0,
  observed_at: "2026-11-10T16:51:56.128155-06:00", updated_at: "2026-11-10T16:51:56.128155-06:00",
  revision: 448, indexed_revision: 448, score: 0.032, canonical_id: null, providers: [], ...overrides,
});
const searchBody = (results: unknown[], mode: "hybrid" | "lexical" = "hybrid", extra: Record<string, unknown> = {}) =>
  Response.json({ query: "q", mode, group_artists: false, results, has_more: false, ...extra });

type Reply = (url: URL, init: RequestInit) => Response | Promise<Response>;
function recorder(...replies: Reply[]) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call = { url, init: init ?? {} };
    calls.push(call);
    return replies[Math.min(calls.length - 1, replies.length - 1)]!(url, call.init);
  }) as typeof fetch;
  return { fetcher, calls };
}
const setup = (...replies: Reply[]) => {
  const { fetcher, calls } = recorder(...replies);
  const logs: Array<{ message: string; detail: Record<string, unknown> }> = [];
  const options: CatalogRequestOptions = { env, fetcher, log: (message, detail) => logs.push({ message, detail }) };
  return { options, calls, logs };
};
const dependencyDown = () => Response.json({ detail: "Catalog search dependency unavailable; lexical mode can be requested explicitly" },
  { status: 503, headers: { "retry-after": "5" } });

test("only an HTTP(S) origin without credentials, path, query or fragment is accepted", () => {
  assert.equal(catalogOrigin("http://catalog-search:8080").origin, "http://catalog-search:8080");
  assert.equal(catalogOrigin("https://catalog.example/").origin, "https://catalog.example");
  for (const value of ["ftp://catalog.test", "http://user:secret@catalog.test", "http://catalog.test/v1", "http://catalog.test/?q=1",
    "http://catalog.test/#x", "not a url", ""]) assert.throws(() => catalogOrigin(value), /MINT_CATALOG_URL/, value);
});

test("an unset catalog is reported as not configured and is never called; an invalid one is misconfigured", async () => {
  const unset = setup(() => searchBody([]));
  for (const value of [undefined, "", "  "]) {
    assert.deepEqual(await searchCatalog("fake love", { ...unset.options, env: { MINT_CATALOG_URL: value } }), { status: "not_configured" });
    assert.deepEqual(await lookupCatalogEntity(`musicbrainz:global:song:${MBID}`, { ...unset.options, env: { MINT_CATALOG_URL: value } }),
      { status: "not_configured" });
  }
  assert.equal(unset.calls.length, 0);
  const invalid = setup(() => searchBody([]));
  assert.deepEqual(await searchCatalog("fake love", { ...invalid.options, env: { MINT_CATALOG_URL: "http://u:p@catalog.test" } }),
    { status: "unavailable", reason: "misconfigured", retryAfterSeconds: null });
  assert.equal(invalid.calls.length, 0);
  assert.match(String(invalid.logs[0]?.detail.error), /MINT_CATALOG_URL/);
  assert.ok(!JSON.stringify(invalid.logs).includes("secret"));
});

test("search is a bounded allowlisted read and maps unknown values honestly", async () => {
  const neighbour = row({ key: "musicbrainz:global:song:11111111-1111-4111-8111-111111111111",
    provider_id: "11111111-1111-4111-8111-111111111111", title: "Love Maze", artist: "Imagine Dragons" });
  const other = row({ key: "deezer:global:song:99", source: "deezer", origin: "deezer", provider_id: "99",
    title: "Fake Love", artist: "Drake", album: "Scorpion", popularity: 0.0376, genres: [" Rap ", ""], url: "javascript:alert(1)" });
  const { options, calls } = setup(() => searchBody([neighbour, row({ provider_id: MBID.toUpperCase() }), other]));
  const result = await searchCatalog("  fake   love ", { ...options, kind: "song", limit: 20 });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, "/v1/search");
  assert.deepEqual(Object.fromEntries(url.searchParams), { q: "fake love", limit: "20", mode: "hybrid", kind: "song", group_artists: "false" });
  assert.equal(init.redirect, "error");
  assert.equal((init as { cache?: string }).cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.mode, "hybrid");
  assert.equal(result.relevance, "matched");
  assert.deepEqual(result.items.map((item) => [item.title, item.matched]), [["Fake Love", true], ["Fake Love", true], ["Love Maze", false]]);
  const [mb, third, near] = result.items;
  assert.equal(mb!.musicBrainzRecordingId, MBID);
  assert.equal(mb!.album, null, "an empty album is unknown, not an empty name");
  assert.equal(mb!.popularity, null, "a zero popularity is unknown, never zero plays");
  assert.equal(mb!.observedAt, "2026-11-10T22:51:56.128Z");
  assert.equal(third!.source, "deezer");
  assert.equal(third!.musicBrainzRecordingId, null, "only MusicBrainz recordings are requestable identities");
  assert.equal(third!.popularity, 0.0376);
  assert.equal(third!.album, "Scorpion");
  assert.deepEqual(third!.genres, ["Rap"]);
  assert.equal(third!.url, null, "only http(s) links are exposed");
  assert.equal(near!.musicBrainzRecordingId, "11111111-1111-4111-8111-111111111111");
});

test("a non-song or non-MusicBrainz row never carries a recording identity", async () => {
  const { options } = setup(() => searchBody([
    row({ kind: "artist", key: "musicbrainz:global:artist:a", provider_id: MBID, title: "BTS" }),
    row({ provider_id: "not-a-uuid" }),
  ]));
  const result = await searchCatalog("bts", options);
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.items.map((item) => item.musicBrainzRecordingId), [null, null]);
});

test("hybrid search always finds neighbours, so relevance is judged by the query words", async () => {
  const neighbours = searchBody([row({ title: "잠시", artist: "BTS" }), row({ key: "k2", provider_id: "x", title: "Swim", artist: "BTS" })]);
  const unrelated = setup(() => neighbours);
  const result = await searchCatalog("qzxjkvhgfdslmm", unrelated.options);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.relevance, "related-only");
    assert.equal(result.items.length, 2);
    assert.ok(result.items.every((item) => !item.matched));
  }
  const nothing = await searchCatalog("anything", setup(() => searchBody([])).options);
  assert.equal(nothing.status, "ok");
  if (nothing.status === "ok") assert.equal(nothing.relevance, "empty");
});

test("a semantic-index outage degrades once to lexical search and says so", async () => {
  const { options, calls } = setup(dependencyDown, () => searchBody([row()], "lexical"));
  const result = await searchCatalog("fake love", options);
  assert.deepEqual(calls.map((call) => call.url.searchParams.get("mode")), ["hybrid", "lexical"]);
  assert.equal(result.status, "lexical-only");
  if (result.status === "lexical-only") assert.equal(result.mode, "lexical");
});

test("capacity limits and a double outage are unavailable with a retry hint, without hammering the catalog", async () => {
  const capacity = setup(() => Response.json({ detail: "Search capacity reached" }, { status: 503, headers: { "retry-after": "1" } }));
  assert.deepEqual(await searchCatalog("fake love", capacity.options), { status: "unavailable", reason: "busy", retryAfterSeconds: 1 });
  assert.equal(capacity.calls.length, 1);
  const both = setup(dependencyDown);
  assert.deepEqual(await searchCatalog("fake love", both.options), { status: "unavailable", reason: "busy", retryAfterSeconds: 5 });
  assert.equal(both.calls.length, 2);
});

test("unreachable, slow, rejected and malformed catalogs are unavailable, never empty results", async () => {
  const down = setup(() => { throw new TypeError("fetch failed"); });
  assert.deepEqual(await searchCatalog("fake love", down.options), { status: "unavailable", reason: "unreachable", retryAfterSeconds: null });
  const slow = setup((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  assert.deepEqual(await searchCatalog("fake love", { ...slow.options, timeoutMs: 20 }), { status: "unavailable", reason: "timeout", retryAfterSeconds: null });
  for (const status of [400, 404, 422]) {
    const rejected = setup(() => Response.json({ detail: "Invalid host header" }, { status }));
    assert.equal((await searchCatalog("fake love", rejected.options) as { reason?: string }).reason, "misconfigured", String(status));
  }
  assert.equal(((await searchCatalog("fake love", setup(() => new Response("<html>", { status: 500 })).options)) as { reason?: string }).reason, "unreachable");
  for (const reply of [() => new Response("not json"), () => Response.json({ mode: "semantic", results: [] }), () => Response.json({ results: [] })]) {
    assert.equal(((await searchCatalog("fake love", setup(reply).options)) as { reason?: string }).reason, "invalid-response");
  }
});

test("oversized responses are rejected by declared length and while streaming", async () => {
  const declared = setup(() => new Response("{}", { headers: { "content-length": "2000000" } }));
  assert.equal(((await searchCatalog("fake love", declared.options)) as { reason?: string }).reason, "invalid-response");
  const streamed = setup(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1_000_001)); controller.close(); },
  })));
  assert.equal(((await searchCatalog("fake love", streamed.options)) as { reason?: string }).reason, "invalid-response");
});

test("one malformed row is skipped and reported, but a response of only malformed rows is invalid", async () => {
  const mixed = setup(() => searchBody([row(), { title: "no key" }, row({ key: "blank", provider_id: "z", title: "   " })]));
  const result = await searchCatalog("fake love", mixed.options);
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.equal(result.items.length, 1);
  assert.deepEqual(mixed.logs.map((entry) => entry.detail.skipped), [2]);
  const broken = setup(() => searchBody([{ title: "no key" }]));
  assert.equal(((await searchCatalog("fake love", broken.options)) as { reason?: string }).reason, "invalid-response");
});

test("the caller's cancellation is propagated, not reported as an outage", async () => {
  const early = new AbortController();
  early.abort();
  const { options, calls } = setup(() => searchBody([row()]));
  await assert.rejects(searchCatalog("fake love", { ...options, signal: early.signal }), { name: "AbortError" });
  assert.equal(calls.length, 0);
  const late = new AbortController();
  const pending = setup((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  const running = searchCatalog("fake love", { ...pending.options, signal: late.signal });
  late.abort();
  await assert.rejects(running, { name: "AbortError" });
  await assert.rejects(searchCatalog("", options), RangeError);
  await assert.rejects(searchCatalog("x".repeat(257), options), RangeError);
});

test("relevance accepts accents, reordering and word prefixes but not misspellings", () => {
  const match = (query: string, ...fields: string[]) => catalogTextMatches(query, ...fields);
  assert.ok(match("beyonce", "Beyoncé"));
  assert.ok(match("love fake", "Fake Love", "BTS"));
  assert.ok(match("fak lo", "Fake Love"));
  assert.ok(match("bts fake", "Fake Love", "BTS"));
  assert.ok(match("잠", "잠시", "BTS"));
  assert.ok(match("a", "A Song"));
  assert.ok(!match("a", "Abba"), "a single letter must be a whole word");
  assert.ok(!match("fkae love", "Fake Love", "BTS"));
  assert.ok(!match("fake love", "Love Maze", "Imagine Dragons"));
  assert.ok(!match("", "Fake Love"));
  assert.ok(!match("   ", "Fake Love"));
  assert.equal(foldCatalogText("Beyoncé — Halo!"), "beyoncehalo");
});

test("entity lookup encodes the key, reports duration only when valid, and distinguishes not found", async () => {
  const key = `musicbrainz:global:song:${MBID}`;
  const found = setup(() => Response.json({ entity: row(), edges: [
    { source: key, target: "musicbrainz:global:artist:b", relation: "artist" },
    { source: key, target: "musicbrainz:global:artist:a", relation: "artist" },
    { source: key, target: "musicbrainz:global:artist:a", relation: "artist" },
    { source: key, target: "musicbrainz:global:album:x", relation: "album" },
    { source: "musicbrainz:global:album:y", target: key, relation: "album" },
    { source: key, relation: "album" },
  ], signals: [], links: [], annotations: { duration_ms: 213_456 } }));
  const result = await lookupCatalogEntity(key, found.options);
  const { url } = found.calls[0]!;
  assert.equal(url.origin, ORIGIN);
  assert.equal(decodeURIComponent(url.pathname), `/v1/entities/${key}`);
  assert.ok(!url.pathname.slice("/v1/entities/".length).includes(":"));
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.durationSec, 213);
    assert.equal(result.entity.musicBrainzRecordingId, MBID);
    assert.deepEqual(result.artistKeys, ["musicbrainz:global:artist:a", "musicbrainz:global:artist:b"], "outgoing, unique and sorted");
    assert.deepEqual(result.albumKeys, ["musicbrainz:global:album:x"], "incoming and malformed edges are ignored");
    assert.deepEqual(result.songKeys, [], "only albums list linked songs");
  }
  const albumKey = "musicbrainz:global:album:y";
  const album = await lookupCatalogEntity(albumKey, setup(() => Response.json({ entity: row({ key: albumKey, kind: "album", provider_id: "y" }), edges: [
    { source: albumKey, target: "musicbrainz:global:artist:a", relation: "artist" },
    { source: "musicbrainz:global:song:b", target: albumKey, relation: "album" },
    { source: "musicbrainz:global:song:a", target: albumKey, relation: "album" },
    { source: "musicbrainz:global:song:a", target: albumKey, relation: "album" },
  ] })).options);
  assert.deepEqual(album.status === "ok" ? album.songKeys : null, ["musicbrainz:global:song:a", "musicbrainz:global:song:b"], "incoming album edges, unique and sorted");
  for (const annotations of [{}, null, { duration_ms: -5 }, { duration_ms: 1.5 }, { duration_ms: "213456" }, { duration_ms: 86_400_001 }, { duration_ms: 100 }]) {
    const lookup = await lookupCatalogEntity(key, setup(() => Response.json({ entity: row(), annotations })).options);
    assert.equal(lookup.status === "ok" ? lookup.durationSec : "x", null, JSON.stringify(annotations));
  }
  assert.deepEqual(await lookupCatalogEntity(key, setup(() => Response.json({ detail: "Entity not found" }, { status: 404 })).options), { status: "not_found" });
  assert.equal((await lookupCatalogEntity(key, setup(() => new Response("x", { status: 503 })).options)).status, "unavailable");
  assert.equal((await lookupCatalogEntity(key, setup(() => Response.json({ entity: { key: "x" } })).options) as { reason?: string }).reason, "invalid-response");
  for (const bad of ["", "a/b", "a b", "a?b", "k".repeat(151)]) await assert.rejects(lookupCatalogEntity(bad, found.options), RangeError, bad);
});

test("the client only ever reads allowlisted catalog paths", async () => {
  const { options, calls } = setup(() => searchBody([row()]), () => Response.json({ entity: row() }));
  await searchCatalog("fake love", options);
  await lookupCatalogEntity(`musicbrainz:global:song:${MBID}`, options);
  assert.ok(calls.every(({ url }) => url.origin === ORIGIN && /^\/v1\/(search|entities\/[^/]+)$/.test(url.pathname)));
});

const DEMAND_TOKEN = "d".repeat(40);
const demandSetup = (reply: Reply = () => Response.json({ queued: 1 }, { status: 202 }), extraEnv: Record<string, string> = {}) => {
  const { fetcher, calls } = recorder(reply);
  const logs: string[] = [];
  let clock = 0;
  const queue = createCatalogDemandQueue({
    env: { ...env, CATALOG_DEMAND_TOKEN: DEMAND_TOKEN, ...extraEnv }, fetcher, delayMs: 60_000, now: () => clock,
    log: (message) => logs.push(message),
  });
  return { queue, calls, logs, advance: (ms: number) => { clock += ms; } };
};
const sentSignals = (call: { init: RequestInit }) => (JSON.parse(String(call.init.body)) as { signals: unknown[] }).signals;

test("demand hints are anonymous, deduplicated, authenticated and drop typeahead prefixes", async () => {
  const { queue, calls } = demandSetup();
  for (const query of ["Rh", "rhi", "Rhianna", "  rhianna  "]) queue.note({ type: "search", query });
  queue.note({ type: "artist", artist: "Cordae" });
  queue.note({ type: "album", title: "The Lost Boy", artist: "Cordae" });
  queue.note({ type: "play", title: "RNP", artist: "Cordae" });
  queue.note({ type: "play", title: "rnp", artist: "CORDAE", count: 2 });
  queue.note({ type: "search", query: "x" });
  assert.equal(await queue.flush(), 4);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call!.url.href, `${ORIGIN}/v1/demand`);
  assert.equal(call!.init.method, "POST");
  assert.equal((call!.init.headers as Record<string, string>).authorization, `Bearer ${DEMAND_TOKEN}`);
  assert.deepEqual(sentSignals(call!), [
    { type: "search", query: "Rhianna" },
    { type: "artist", artist: "Cordae" },
    { type: "album", title: "The Lost Boy", artist: "Cordae" },
    { type: "play", title: "RNP", artist: "Cordae", count: 3 },
  ]);
  assert.doesNotMatch(String(call!.init.body), /user|device|session/i);
});

test("demand hints repeat only after a cooldown and batch at the catalog bound", async () => {
  const { queue, calls, advance } = demandSetup();
  queue.note({ type: "search", query: "passionfruit" });
  await queue.flush();
  queue.note({ type: "search", query: "passionfruit" });
  assert.equal(queue.size, 0);
  advance(11 * 60_000);
  queue.note({ type: "search", query: "passionfruit" });
  for (let index = 0; index < 60; index += 1) queue.note({ type: "artist", artist: `Artist ${index}` });
  assert.equal(await queue.flush(), 61);
  assert.deepEqual(calls.map((call) => sentSignals(call).length), [1, 50, 11]);
});

test("demand hints are disabled without a token and never throw on catalog failures", async () => {
  const disabled = demandSetup(undefined, { CATALOG_DEMAND_TOKEN: "" });
  disabled.queue.note({ type: "search", query: "rnp" });
  assert.equal(await disabled.queue.flush(), 0);
  assert.equal(disabled.calls.length, 0);
  const failing = demandSetup(() => { throw new TypeError("connect ECONNREFUSED"); });
  failing.queue.note({ type: "search", query: "rnp" });
  assert.equal(await failing.queue.flush(), 0);
  assert.deepEqual(failing.logs, ["Metadata catalog demand hints failed"]);
  const rejected = demandSetup(() => new Response("{}", { status: 401 }));
  rejected.queue.note({ type: "search", query: "rnp" });
  assert.equal(await rejected.queue.flush(), 0);
  assert.deepEqual(rejected.logs, ["Metadata catalog rejected demand hints"]);
});
