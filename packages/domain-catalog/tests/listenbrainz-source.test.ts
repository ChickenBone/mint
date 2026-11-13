import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_SEED_INGESTION_LIMITS as limits,
  CatalogSeedIngestionError,
  LISTENBRAINZ_SEED_URL,
  fetchListenBrainzSnapshot,
  parseListenBrainzSnapshot,
} from "../src/listenbrainz-source";

const id = "12345678-1234-4234-ABCD-123456789012";
function row() {
  return {
    recording_mbid: id, artist_mbids: [id], track_name: "  A   song ",
    artist_name: "Artist", release_name: "Album", listen_count: 7,
  };
}
function fixture(recordings: unknown[] = [row()]) {
  return { payload: { range: "week", from_ts: 100, to_ts: 200, last_updated: 201, recordings } };
}
const active = () => new AbortController().signal;
const invalid = (body: unknown) => assert.throws(() => parseListenBrainzSnapshot(body), {
  name: "CatalogSeedIngestionError", code: "invalid_source",
});

test("weekly observations preserve origin IDs, occurrence positions and bounded metadata only", () => {
  const parsed = parseListenBrainzSnapshot(fixture([
    { track_name: "Unknown", recording_mbid: "" },
    { ...row(), media_url: "https://invalid.example/audio", rank: 1000 },
    { ...row(), release_name: "Other version" },
  ]));
  assert.equal(parsed.received, 3);
  assert.equal(parsed.missingIdentifiers, 1);
  assert.deepEqual(parsed.observations, [
    { position: 2, recordingMbid: id.toLowerCase(), title: "A song", artist: "Artist",
      release: "Album", artistMbids: [id.toLowerCase()], listenCount: 7 },
    { position: 3, recordingMbid: id.toLowerCase(), title: "A song", artist: "Artist",
      release: "Other version", artistMbids: [id.toLowerCase()], listenCount: 7 },
  ]);
  assert.equal(parsed.from.toISOString(), "1970-01-01T00:01:40.000Z");
  assert.equal(parseListenBrainzSnapshot(fixture([])).observations.length, 0);
  assert.equal(parseListenBrainzSnapshot(fixture(Array.from({ length: 100 }, row))).observations.length, 100);
});

test("malformed source data fails the whole bounded page, without identity guesses", () => {
  for (const body of [null, [], {}, { payload: null },
    { payload: { ...fixture().payload, range: "all_time" } },
    { payload: { ...fixture().payload, from_ts: 300 } },
    { payload: { ...fixture().payload, last_updated: -1 } },
    fixture(Array.from({ length: 101 }, row)),
    fixture([null]), fixture([{ ...row(), recording_mbid: "same title" }]),
    fixture([{ ...row(), track_name: " " }]), fixture([{ ...row(), artist_name: "x\0y" }]),
    fixture([{ ...row(), release_name: "x".repeat(501) }]),
    fixture([{ ...row(), artist_mbids: Array(101).fill(id) }]),
    fixture([{ ...row(), artist_mbids: ["artist name"] }]),
    ...[-1, 0.1, Number.MAX_SAFE_INTEGER + 1, "7"].map((listen_count) => fixture([{ ...row(), listen_count }])),
  ]) invalid(body);
});

test("fixed transport has no credentials, redirects, lookup calls or supplied URLs", async () => {
  let calls = 0;
  const request: typeof fetch = async (input, init) => {
    calls += 1;
    assert.equal(input, LISTENBRAINZ_SEED_URL);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.deepEqual(Object.keys(init?.headers ?? {}).sort(), ["accept", "user-agent"]);
    return Response.json(fixture());
  };
  assert.equal((await fetchListenBrainzSnapshot(request, active())).observations.length, 1);
  assert.equal(calls, 1);
});

test("stream byte budgets apply with or without content length", async () => {
  for (const headers of [new Headers(), new Headers({ "content-length": String(limits.maxBytes + 1) })]) {
    let cancelled = false;
    const request: typeof fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(limits.maxBytes + 1)); },
      cancel() { cancelled = true; },
    }), { headers });
    await assert.rejects(fetchListenBrainzSnapshot(request, active()), { code: "invalid_source" });
    assert.equal(cancelled, true);
  }
  const overhead = Buffer.byteLength(JSON.stringify({ ...fixture(), padding: "" }));
  const exact = JSON.stringify({ ...fixture(), padding: "x".repeat(limits.maxBytes - overhead) });
  assert.equal(Buffer.byteLength(exact), limits.maxBytes);
  assert.equal((await fetchListenBrainzSnapshot(async () => new Response(exact), active())).observations.length, 1);
});

test("malformed JSON, redirects and network errors do not become empty success", async () => {
  for (const response of [
    new Response("{"), new Response("null"), new Response("{}", { status: 302 }),
    new Response("no", { status: 404 }), new Response("no", { status: 500 }),
    new Response(JSON.stringify(fixture()), { status: 206 }),
  ]) {
    await assert.rejects(fetchListenBrainzSnapshot(async () => response, active()), CatalogSeedIngestionError);
  }
  await assert.rejects(fetchListenBrainzSnapshot(async () => { throw new Error("private upstream text"); }, active()),
    (error: unknown) => error instanceof CatalogSeedIngestionError && !error.message.includes("private"));
});

test("204 is unavailable and Retry-After seconds/date cannot be shortened by retry policy", async () => {
  for (const [status, header, minimum] of [
    [204, null, 3_600_000],
    [429, "86400", 86_400_000],
    [503, new Date(Date.now() + 120_000).toUTCString(), 118_000],
    [503, "not a date", 60_000],
  ] as const) {
    const before = Date.now();
    await assert.rejects(fetchListenBrainzSnapshot(async () => new Response(null, {
      status, headers: header ? { "retry-after": header } : {},
    }), active()), (error: unknown) => error instanceof CatalogSeedIngestionError
      && error.code === "source_unavailable" && !!error.retryAt
      && error.retryAt.getTime() >= before + minimum);
  }
  await assert.rejects(fetchListenBrainzSnapshot(async () => new Response(null, {
    status: 429, headers: { "retry-after": "9".repeat(1000) },
  }), active()), (error: unknown) => error instanceof CatalogSeedIngestionError
    && error.retryAt?.getTime() === 8_640_000_000_000_000);
});

test("caller cancellation aborts stalled fetch and body and cancels its reader", async () => {
  const abort = new AbortController();
  const waiting = fetchListenBrainzSnapshot(async () => new Promise<Response>(() => {}), abort.signal);
  abort.abort();
  await assert.rejects(waiting, { code: "aborted" });

  const bodyAbort = new AbortController();
  let cancelled = false;
  const body = fetchListenBrainzSnapshot(async () => new Response(new ReadableStream({
    start() { queueMicrotask(() => bodyAbort.abort()); },
    cancel() { cancelled = true; },
  })), bodyAbort.signal);
  await assert.rejects(body, { code: "aborted" });
  assert.equal(cancelled, true);
});

test("a stuck refusal-body cleanup stays bounded and retains the provider cooldown", async () => {
  const keepAlive = setTimeout(() => {}, 3000);
  try {
    await assert.rejects(fetchListenBrainzSnapshot(async () => new Response(new ReadableStream({
      cancel() { return new Promise<void>(() => {}); },
    }), { status: 429, headers: { "retry-after": "86400" } }), active()),
    (error: unknown) => error instanceof AggregateError
      && error.errors.some((item: unknown) => item instanceof CatalogSeedIngestionError
        && item.retryAt !== undefined && item.retryAt.getTime() >= Date.now() + 86_390_000));
  } finally { clearTimeout(keepAlive); }
});

test("the eight-second source deadline bounds a stalled body without caller cancellation", { timeout: 11_000 }, async () => {
  const keepAlive = setTimeout(() => {}, 10_000);
  let cancelled = false;
  const before = performance.now();
  try {
    await assert.rejects(fetchListenBrainzSnapshot(async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    })), active()), { code: "aborted" });
    const elapsed = performance.now() - before;
    assert.ok(elapsed >= limits.requestTimeoutMs - 20);
    assert.ok(elapsed < limits.requestTimeoutMs + 2000);
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});
