import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { schema } from "@mint/core/db";
import { signToken } from "@mint/core/crypto";
import { catalogRecordingMetadata, readRequestRecording, requestRecording, searchCatalogRecordings, searchRecordingMetadata, searchRecordings, youtubeSource } from "../src/lib/music-requests";
import { publicCacheFixture } from "../../../packages/core/src/public-cache-fixture";

const catalogFixture = () => ({ recordings: [{
  id: randomUUID(), title: "First Light", length: 90000, score: 100,
  "artist-credit": [{ name: "Mint Fixture" }], releases: [{ title: "Browser Sessions" }],
}] });

test("recording tokens validate owner, signature, purpose, expiry and signed metadata without a database", () => {
  const secret = process.env.MINT_SIGNING_SECRET;
  process.env.MINT_SIGNING_SECRET = "music-request-fixture-secret-at-least-32-characters";
  try {
    const item = { id: randomUUID(), title: "First Light", artist: "Mint Fixture", album: null, durationSec: 90 };
    const token = signToken("music-request", { userId: "owner", recording: item }, 60000);
    assert.deepEqual(readRequestRecording("owner", token), item);
    assert.throws(() => readRequestRecording("other", token), /expired/);
    assert.throws(() => readRequestRecording("owner", `${token}broken`), /expired/);
    assert.throws(() => readRequestRecording("owner", signToken("other-purpose", { userId: "owner", recording: item }, 60000)), /expired/);
    assert.throws(() => readRequestRecording("owner", signToken("music-request", { userId: "owner", recording: item }, -1000)), /expired/);
    assert.throws(() => readRequestRecording("owner", signToken("music-request", { userId: "owner", recording: { ...item, id: "invalid" } }, 60000)));
  } finally {
    if (secret === undefined) delete process.env.MINT_SIGNING_SECRET; else process.env.MINT_SIGNING_SECRET = secret;
  }
});

test("search uses catalog graph recordings and a MusicBrainz cooldown cannot fail a catalog answer", async () => {
  const id = randomUUID(), env = { MINT_CATALOG_URL: "http://catalog.test" };
  const row = (provider_id: string, extra = {}) => ({ key: `musicbrainz:global:song:${provider_id}`, source: "musicbrainz", kind: "song",
    provider_id, title: "Red Lipstick", artist: "Rihanna", album: "Talk That Talk", ...extra });
  const seen: string[] = [];
  const fetcher = (async (input: string | URL) => {
    const url = new URL(String(input)); seen.push(url.pathname);
    if (url.pathname === "/v1/search") return Response.json({ mode: "hybrid", results: [row(id), row(id),
      { ...row("not-a-uuid"), source: "spotify" }, row(randomUUID(), { artist: "" })] });
    return Response.json({ entity: row(id), annotations: { duration_ms: 217_400 } });
  }) as typeof fetch;
  const items = await catalogRecordingMetadata("rhianna", { catalog: { env, fetcher } });
  assert.deepEqual(items, [{ id, title: "Red Lipstick", artist: "Rihanna", album: "Talk That Talk", durationSec: 217 }]);
  assert.equal(seen.filter((path) => path === "/v1/search").length, 1);
  assert.equal(await catalogRecordingMetadata("rhianna", { catalog: { env: {}, fetcher } }), null, "unconfigured catalog defers to MusicBrainz");
  const empty = (async () => Response.json({ mode: "hybrid", results: [] })) as typeof fetch;
  const answer = await searchCatalogRecordings("owner", "rhianna", { catalog: { env, fetcher: empty }, cache: false,
    fetcher: async () => new Response(null, { status: 503 }) });
  assert.deepEqual({ items: answer.items, artists: answer.artists }, { items: [], artists: [] }, "an empty catalog answer survives a busy MusicBrainz");
  await assert.rejects(searchCatalogRecordings("owner", "rhianna", { catalog: { env, fetcher: async () => new Response(null, { status: 500 }) },
    cache: false, fetcher: async () => new Response(null, { status: 503 }) }), /busy/, "both unavailable still reports the outage");
});

test("catalog search collapses duplicate recordings of one song onto its own-album version", async () => {
  const env = { MINT_CATALOG_URL: "http://catalog.test" };
  const [mix, album, single, introA, introB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const song = (id: string, title: string, artist: string) => ({ key: `musicbrainz:global:song:${id}`, source: "musicbrainz", kind: "song",
    provider_id: id, title, artist, album: "" });
  const albumRow = (key: string, title: string, artist: string) => ({ key, source: "musicbrainz", kind: "album", provider_id: key, title, artist, album: "" });
  const albums: Record<string, ReturnType<typeof albumRow>> = {
    "mb:album:mix": albumRow("mb:album:mix", "Big Tree Energy Radio, Vol. 1", "Disclosure"),
    "mb:album:lost": albumRow("mb:album:lost", "The Lost Boy", "YBN Cordae"),
    "mb:album:single": albumRow("mb:album:single", "RNP", "YBN Cordae feat. Anderson .Paak"),
    "mb:album:first": albumRow("mb:album:first", "First Album", "Mint Fixture"),
    "mb:album:second": albumRow("mb:album:second", "Second Album", "Mint Fixture"),
  };
  const songs = [song(mix, "RNP", "Cordae feat. Anderson .Paak"), song(single, "RNP", "YBN Cordae feat. Anderson .Paak"),
    song(album, "RNP", "YBN Cordae feat. Anderson .Paak"), song(introA, "Intro", "Mint Fixture"), song(introB, "Intro", "Mint Fixture")];
  const links: Record<string, { artists: string[]; albums: string[]; ms?: number }> = {
    [mix]: { artists: ["a:cordae", "a:paak"], albums: ["mb:album:mix"], ms: 166_000 },
    [single]: { artists: ["a:cordae", "a:paak"], albums: ["mb:album:single", "mb:album:lost"] },
    [album]: { artists: ["a:cordae", "a:paak"], albums: ["mb:album:lost"], ms: 176_000 },
    [introA]: { artists: ["a:mint"], albums: ["mb:album:first"] },
    [introB]: { artists: ["a:mint"], albums: ["mb:album:second"] },
  };
  const fetcher = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/search") return Response.json({ mode: "hybrid", results: songs });
    const key = decodeURIComponent(url.pathname.slice("/v1/entities/".length));
    if (albums[key]) return Response.json({ entity: albums[key] });
    const entity = songs.find((item) => item.key === key)!, link = links[entity.provider_id]!;
    return Response.json({ entity, annotations: link.ms ? { duration_ms: link.ms } : {}, edges: [
      ...link.artists.map((target) => ({ source: key, target, relation: "artist" })),
      ...link.albums.map((target) => ({ source: key, target, relation: "album" }))] });
  }) as typeof fetch;
  const items = await catalogRecordingMetadata("rnp", { catalog: { env, fetcher } });
  assert.deepEqual(items?.map((item) => [item.id, item.album]), [[single, "The Lost Boy"], [introA, "First Album"], [introB, "Second Album"]],
    "the DJ-mix and album cuts fold into the own-album version; same-title songs on different albums stay apart");
});

test("pinned recording sources fail closed before any database write when metadata or audio safety is missing", async () => {
  const previous = process.env.MINT_SIGNING_SECRET, savedFlag = process.env.YOUTUBE_SCRAPE_AUTHORIZED;
  process.env.MINT_SIGNING_SECRET = "music-request-fixture-secret-at-least-32-characters";
  try {
    const item = { id: randomUUID(), title: "First Light", artist: "Mint Fixture", album: null, durationSec: 181 };
    const token = signToken("music-request", { userId: "owner", recording: item }, 60000);
    const video = { id: "fixture0001", title: "Mint Fixture - First Light (Official Audio)", channel: "Mint Fixture", durationSec: 176, rank: 0 };
    const run = (sourceReader: Parameters<typeof requestRecording>[4]) =>
      requestRecording("owner", token, "https://youtu.be/fixture0001", undefined, sourceReader);
    process.env.YOUTUBE_SCRAPE_AUTHORIZED = "false";
    await assert.rejects(run(async () => null), /Link YouTube/);
    process.env.YOUTUBE_SCRAPE_AUTHORIZED = "true";
    await assert.rejects(run(async () => null), (error: Error) =>
      /metadata is unavailable/.test(error.message) && !/Link YouTube/.test(error.message));
    await assert.rejects(run(async () => ({ ...video, title: "Mint Fixture - First Light (Official Music Video)", durationSec: 181 })), /music videos are not allowed/);
    await assert.rejects(run(async () => ({ ...video, durationSec: 242 })), /duration mismatch/);
    await assert.rejects(run(async () => ({ ...video, durationSec: null })), /missing length evidence/);
    await assert.rejects(run(async () => ({ ...video, title: "Mint Fixture - First Light", channel: "Unrelated Channel" })), /duration mismatch/);
    await assert.rejects(run(async () => ({ ...video, title: "Other Artist - Other Song (Official Audio)", channel: "Fictional Label" })), /identity mismatch/);
    await assert.rejects(run(async () => { throw new Error("YouTube transient provider failure"); }), /transient provider failure/);
  } finally {
    if (previous === undefined) delete process.env.MINT_SIGNING_SECRET; else process.env.MINT_SIGNING_SECRET = previous;
    if (savedFlag === undefined) delete process.env.YOUTUBE_SCRAPE_AUTHORIZED; else process.env.YOUTUBE_SCRAPE_AUTHORIZED = savedFlag;
  }
});

test("recording metadata prefers the validated mirror and keeps queries bounded and escaped", async () => {
  const fixture = catalogFixture();
  const calls: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const target = new URL(String(input)); calls.push(target);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.ok(new Headers(init?.headers).get("user-agent")?.startsWith("Mint/"));
    assert.equal(new Headers(init?.headers).get("accept"), "application/json");
    assert.equal(target.searchParams.get("limit"), "10");
    assert.equal(target.searchParams.get("fmt"), "json");
    return Response.json(fixture);
  };
  const items = await searchRecordingMetadata('  First "Light"*  ', fetcher, undefined, { mirrorUrl: "http://mirror.test:5000/ws/2/" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.href.split("?")[0], "http://mirror.test:5000/ws/2/recording");
  assert.equal(calls[0]!.searchParams.get("query"), 'First \\"Light\\"\\*');
  assert.equal(items[0]!.durationSec, 90);
  assert.equal(items[0]!.artist, "Mint Fixture");
  assert.equal("token" in items[0]!, false);
  assert.equal("existing" in items[0]!, false);
  await searchRecordingMetadata("fixture", fetcher, "US-ABC-12-34567", { mirrorUrl: "" });
  assert.equal(calls[1]!.searchParams.get("query"), "isrc:USABC1234567");
  for (const query of ["a", " ".repeat(10), "x".repeat(101)]) await assert.rejects(searchRecordingMetadata(query, fetcher));
  assert.equal(calls.length, 2, "invalid queries must never reach a provider");
});

test("web recording search reads the server mirror configuration", async () => {
  const previous = process.env.MUSICBRAINZ_MIRROR_URL;
  process.env.MUSICBRAINZ_MIRROR_URL = "https://mirror.test/ws/2";
  try {
    await searchRecordingMetadata("fixture", async (input) => {
      assert.equal(new URL(String(input)).origin, "https://mirror.test");
      return Response.json(catalogFixture());
    });
  } finally {
    if (previous === undefined) delete process.env.MUSICBRAINZ_MIRROR_URL; else process.env.MUSICBRAINZ_MIRROR_URL = previous;
  }
});

test("catalog video recordings and unrepresented editions never become signed audio duration evidence", async () => {
  const base = catalogFixture().recordings[0]!;
  const items = await searchRecordingMetadata("fixture", async () => Response.json({ recordings: [
    base,
    { ...base, id: randomUUID(), video: true, length: 244000 },
    { ...base, id: randomUUID(), disambiguation: "live at the fixture hall", length: 260000 },
    { ...base, id: randomUUID(), disambiguation: "cover", length: 185000 },
    { ...base, id: randomUUID(), disambiguation: "album version", video: false },
  ] }), undefined, { mirrorUrl: "" });
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.durationSec === 90));
  assert.ok(items.every((item) => !("video" in item) && !("disambiguation" in item)), "public DTO stays unchanged");
});

test("invalid mirror bases never receive a fetch and fall back to canonical public search", async () => {
  for (const mirrorUrl of ["not a URL", "ftp://mirror.test/ws/2", "https://user:secret@mirror.test/ws/2",
    "https://mirror.test/ws/2?query=other", "https://mirror.test/ws/2#fragment", "https://mirror.test/arbitrary",
    "https://mirror.test/prefix/ws/2", "https://musicbrainz.org/ws/2"]) {
    let calls = 0;
    await searchRecordingMetadata("fixture", async (input) => {
      calls++;
      assert.equal(new URL(String(input)).origin, "https://musicbrainz.org");
      assert.equal(new URL(String(input)).pathname, "/ws/2/recording");
      return Response.json(catalogFixture());
    }, undefined, { mirrorUrl });
    assert.equal(calls, 1);
  }
});

test("unavailable, malformed and oversized mirror responses fall back without hiding public failures", async () => {
  const badMirrors = [
    () => { throw new Error("offline"); },
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: "http://other.test/" } }),
    () => new Response("not JSON"),
    () => Response.json({ error: "unavailable", recordings: [] }),
    () => Response.json({ recordings: [{}] }),
    () => Response.json({ recordings: [{ ...catalogFixture().recordings[0], length: -1 }] }),
    () => Response.json({ recordings: [{ ...catalogFixture().recordings[0], "artist-credit": [] }] }),
    () => Response.json({ recordings: Array.from({ length: 11 }, () => catalogFixture().recordings[0]) }),
    () => new Response("x".repeat(1_000_001)),
  ];
  for (const bad of badMirrors) {
    const calls: string[] = [];
    const results = await searchRecordingMetadata("fixture", async (input) => {
      const host = new URL(String(input)).hostname; calls.push(host);
      return host === "mirror.test" ? bad() : Response.json(catalogFixture());
    }, undefined, { mirrorUrl: "https://mirror.test/ws/2" });
    assert.equal(results.length, 1);
    assert.deepEqual(calls, ["mirror.test", "musicbrainz.org"]);
  }
  for (const status of [429, 503]) await assert.rejects(searchRecordingMetadata("fixture", async () => new Response(null, { status }), undefined, { mirrorUrl: "" }), /busy/);
  await assert.rejects(searchRecordingMetadata("fixture", async () => new Response("x".repeat(1_000_001)), undefined, { mirrorUrl: "" }), /too large/);
  await assert.rejects(searchRecordingMetadata("fixture", async () => Response.json({ recordings: [{}] }), undefined, { mirrorUrl: "" }), /invalid response/);
  assert.deepEqual(await searchRecordingMetadata("fixture", async () => Response.json({ recordings: [] }), undefined, { mirrorUrl: "" }), []);
});

test("client cancellation stops mirror fallback, body reads and cached responses", async () => {
  const before = new AbortController(); before.abort();
  let calls = 0;
  await assert.rejects(searchRecordingMetadata("fixture", async () => { calls++; return Response.json(catalogFixture()); }, undefined, { signal: before.signal }));
  assert.equal(calls, 0);
  const during = new AbortController();
  await assert.rejects(searchRecordingMetadata("fixture", async (_input, init) => {
    calls++;
    during.abort();
    assert.equal(init?.signal?.aborted, true);
    throw during.signal.reason;
  }, undefined, { mirrorUrl: "https://mirror.test/ws/2", signal: during.signal }), { name: "AbortError" });
  assert.equal(calls, 1, "an aborted mirror request must not fall back");
  for (const highWaterMark of [0, 1]) {
    const bodyAbort = new AbortController();
    let cancelled = false;
    await assert.rejects(searchRecordingMetadata("fixture", async () => new Response(new ReadableStream({
      pull() { bodyAbort.abort(); },
      cancel() { cancelled = true; },
    }, { highWaterMark })), undefined, { mirrorUrl: "", signal: bodyAbort.signal }), { name: "AbortError" });
    assert.equal(cancelled, true);
  }
});

test("metadata cache is bounded, expires, isolates configuration and never stores failed responses", async () => {
  let calls = 0, now = Date.now();
  const store = publicCacheFixture(() => now);
  const fixture = catalogFixture();
  const fetcher: typeof fetch = async () => { calls++; return Response.json(fixture); };
  const options = { mirrorUrl: "", cache: true, cacheStore: store.cache };
  const first = await searchRecordingMetadata("fixture", fetcher, undefined, options);
  first[0]!.title = "changed";
  assert.equal((await searchRecordingMetadata("fixture", fetcher, undefined, options))[0]!.title, "First Light");
  assert.equal(calls, 1, "cached results are defensive metadata copies");
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(searchRecordingMetadata("fixture", fetcher, undefined, { ...options, signal: cancelled.signal }));
  assert.equal(calls, 1);
  now += 3601_000;
  await searchRecordingMetadata("fixture", fetcher, undefined, options);
  assert.equal(calls, 2);
  for (let i = 0; i < 128; i++) {
    now += 2100;
    await searchRecordingMetadata(`fixture ${i}`, fetcher, undefined, options);
  }
  await searchRecordingMetadata("fixture", fetcher, undefined, options);
  assert.equal(calls, 130, "hot-memory eviction retains public entries in the shared store");
  now += 2100;
  await searchRecordingMetadata("fixture", fetcher, undefined, { ...options, mirrorUrl: "https://mirror.test/ws/2" });
  assert.equal(calls, 131);
  let failures = 0;
  const failing: typeof fetch = async () => { failures++; return new Response(null, { status: 503 }); };
  const failed = publicCacheFixture(() => now);
  for (let i = 0; i < 2; i++) await assert.rejects(searchRecordingMetadata("fixture", failing, undefined,
    { ...options, cacheStore: failed.instance() }), /busy/);
  assert.equal(failures, 1, "provider cooldown prevents retries for identical or different failed reads");
});
test("public recording searches coalesce across stores and do not share signed/local account outputs", async () => {
  const fixture = publicCacheFixture(), raw = catalogFixture();
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls++; assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json(raw);
  };
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => searchRecordingMetadata("First Light", fetcher,
    undefined, { mirrorUrl: "", cacheStore: index % 2 ? fixture.cache : fixture.instance() })));
  assert.ok(results.every((rows) => rows[0]!.id === raw.recordings[0]!.id)); assert.equal(calls, 1);
  await searchRecordingMetadata("First Light", fetcher, undefined, { mirrorUrl: "", cacheStore: fixture.instance() });
  assert.equal(calls, 1, "31 searches use one public provider call");
  const values = [...fixture.entries.values()].map((entry) => entry.value).join("");
  assert.ok(!values.includes('"token"')); assert.ok(!values.includes('"existing"'));
});

test("cached metadata still resolves local status and signs for each searching account without acquiring tracks", async () => {
  const fixture = catalogFixture(), globalDb = globalThis as unknown as { __mintDb?: unknown };
  const previous = globalDb.__mintDb, secret = process.env.MINT_SIGNING_SECRET;
  let local: Array<{ id: string; recordingId: string; stage: "ready"; error: null; detail: null; playable: boolean }> = [];
  let reads = 0, fetches = 0;
  globalDb.__mintDb = { db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => { reads++; return local; } }) }) }),
  } };
  process.env.MINT_SIGNING_SECRET = "music-request-fixture-secret-at-least-32-characters";
  try {
    const fetcher: typeof fetch = async () => { fetches++; return Response.json(fixture); };
    const options = { mirrorUrl: "", cache: true, cacheStore: publicCacheFixture().cache };
    const first = await searchRecordings("owner", "fixture", fetcher, undefined, options);
    assert.equal(first[0]!.existing, null);
    assert.equal(readRequestRecording("owner", first[0]!.token).id, fixture.recordings[0]!.id);
    local = [{ id: randomUUID(), recordingId: fixture.recordings[0]!.id, stage: "ready", error: null, detail: null, playable: false }];
    const second = await searchRecordings("other", "fixture", fetcher, undefined, options);
    assert.equal(second[0]!.existing?.playable, false);
    assert.equal(readRequestRecording("other", second[0]!.token).id, fixture.recordings[0]!.id);
    assert.throws(() => readRequestRecording("owner", second[0]!.token), /expired/);
    local = [{ ...local[0]!, playable: true }];
    assert.equal((await searchRecordings("owner", "fixture", fetcher, undefined, options))[0]!.existing?.playable, true);
    assert.equal(fetches, 1); assert.equal(reads, 3);
  } finally {
    globalDb.__mintDb = previous;
    if (secret === undefined) delete process.env.MINT_SIGNING_SECRET; else process.env.MINT_SIGNING_SECRET = secret;
  }
});

test("manual sources accept only HTTPS video identities", () => {
  assert.equal(youtubeSource("https://music.youtube.com/watch?v=abcdefghijk&list=example"), "abcdefghijk");
  assert.equal(youtubeSource("https://youtu.be/abcdefghijk?t=12"), "abcdefghijk");
  assert.equal(youtubeSource(""), null);
  for (const value of ["http://youtube.com/watch?v=abcdefghijk", "https://youtube.com.evil.test/watch?v=abcdefghijk",
    "https://youtube.com@evil.test/watch?v=abcdefghijk", "https://youtube.com/playlist?list=abcdefghijk", "https://youtu.be/short"]) {
    assert.throws(() => youtubeSource(value), /YouTube/);
  }
});

const url = process.env.MUSIC_TEST_DATABASE_URL;
test("signed recording requests are account-bound, duplicate-safe, retriable and separate from YouTube likes", { skip: !url && "Set MUSIC_TEST_DATABASE_URL" }, async () => {
  const namespace = `requests_${randomUUID().replaceAll("-", "")}`, admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema "${namespace}"`);
  const pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${namespace},public` });
  const db = drizzle(pool, { schema }), globalDb = globalThis as unknown as { __mintDb?: { db: typeof db; pool: pg.Pool } };
  const previous = globalDb.__mintDb, secret = process.env.MINT_SIGNING_SECRET;
  globalDb.__mintDb = { db, pool }; process.env.MINT_SIGNING_SECRET = "music-request-fixture-secret-at-least-32-characters";
  try {
    for (const name of ["0000_init", "0001_workers", "0002_drop_previews", "0003_track_artwork_url", "0004_existing_library", "0009_playback_scale", "0019_source_choices"]) {
      const source = await readFile(new URL(`../../../packages/core/migrations/${name}.sql`, import.meta.url), "utf8");
      for (const statement of source.replaceAll('"public".', `"${namespace}".`).split("--> statement-breakpoint")) if (statement.trim()) await pool.query(statement);
    }
    const [owner, other] = await db.insert(schema.users).values(["owner", "other"].map((name) =>
      ({ email: `${name}@requests.test`, name, status: "active" as const, passwordHash: "fixture" }))).returning();
    const id = randomUUID(), item = { id, title: "First Light", artist: "Mint Fixture", album: "Browser Sessions", durationSec: 90 };
    let catalogCalls = 0;
    const cacheStore = publicCacheFixture().cache;
    const fetcher: typeof fetch = async (input, init) => {
      catalogCalls++;
      assert.equal(new URL(String(input)).hostname, "musicbrainz.org");
      assert.ok(new Headers(init?.headers).get("user-agent")?.startsWith("Mint/"));
      return Response.json({ recordings: [{ id, title: item.title, length: 90000, "artist-credit": [{ name: item.artist }], releases: [{ title: item.album }] }] });
    };
    const results = await searchRecordings(owner!.id, "first light", fetcher, undefined, { mirrorUrl: "", cache: true, cacheStore });
    assert.equal(results.length, 1); assert.equal(results[0]!.existing, null);
    assert.equal(await db.$count(schema.tracks), 0, "metadata search must not create library tracks");
    assert.equal(await db.$count(schema.userTracks), 0, "metadata search must not grant ownership");
    const token = results[0]!.token;
    await assert.rejects(requestRecording(other!.id, token), /expired/);
    await assert.rejects(requestRecording(owner!.id, `${token}broken`), /expired/);
    await assert.rejects(requestRecording(owner!.id, signToken("music-request", { userId: owner!.id, recording: item }, -1000)), /expired/);
    const requested = await Promise.all(Array.from({ length: 4 }, () => requestRecording(owner!.id, token)));
    assert.equal(new Set(requested.map((result) => result.trackId)).size, 1);
    assert.ok(requested.every((result) => result.stage === "queued" && result.needsQueue));
    const trackId = requested[0]!.trackId;
    assert.equal(await db.$count(schema.tracks), 1);
    assert.equal((await db.select().from(schema.userTracks))[0]!.origin, "request");
    await db.delete(schema.userTracks).where(and(eq(schema.userTracks.userId, owner!.id), eq(schema.userTracks.origin, "youtube")));
    assert.equal(await db.$count(schema.userTracks), 1, "YouTube reconciliation must not remove explicit requests");
    await db.update(schema.tracks).set({ stage: "failed", error: "No linked source" }).where(eq(schema.tracks.id, trackId));
    const sourceReader = async () => ({ id: "abcdefghijk", title: "Mint Fixture - First Light (Official Audio)", channel: "Mint Fixture", durationSec: 90, rank: 0 });
    await assert.rejects(requestRecording(owner!.id, token, "https://youtu.be/abcdefghijk", undefined, async () => null), /metadata is unavailable/);
    await assert.rejects(requestRecording(owner!.id, token, "https://youtu.be/abcdefghijk", undefined, async () =>
      ({ ...await sourceReader(), title: "Mint Fixture - First Light (Official Music Video)" })), /music videos are not allowed/);
    const retried = await requestRecording(owner!.id, token, "https://youtu.be/abcdefghijk", undefined, sourceReader);
    assert.equal(retried.stage, "queued"); assert.equal(retried.needsQueue, true);
    const [stored] = await db.select().from(schema.tracks).where(eq(schema.tracks.id, trackId));
    assert.equal(stored!.youtubeVideoId, "abcdefghijk"); assert.equal(stored!.error, null);
    await db.update(schema.tracks).set({ stage: "ready" }).where(eq(schema.tracks.id, trackId));
    const readyWithoutFile = await searchRecordings(other!.id, "first light", fetcher, undefined, { mirrorUrl: "", cache: true, cacheStore });
    assert.equal(readyWithoutFile[0]!.existing?.playable, false, "a ready-looking stage is not proof of playable audio");
    assert.equal(readRequestRecording(other!.id, readyWithoutFile[0]!.token).id, id);
    assert.throws(() => readRequestRecording(owner!.id, readyWithoutFile[0]!.token), /expired/);
    assert.equal(await db.$count(schema.userTracks), 1, "cached metadata does not become owned by the searching account");
    await db.update(schema.tracks).set({ filePath: "/fixture/audio.flac" }).where(eq(schema.tracks.id, trackId));
    assert.equal((await searchRecordings(owner!.id, "first light", fetcher, undefined, { mirrorUrl: "", cache: true, cacheStore }))[0]!.existing?.playable, true);
    assert.equal(catalogCalls, 1, "local playability and signing are refreshed independently of cached metadata");
    const secondToken = signToken("music-request", { userId: other!.id, recording: item }, 60000);
    assert.equal((await requestRecording(other!.id, secondToken)).needsQueue, false);
    const wrongRecording = signToken("music-request", { userId: owner!.id, recording: { ...item, id: randomUUID(), title: "Other Recording" } }, 60000);
    await assert.rejects(requestRecording(owner!.id, wrongRecording, "https://youtu.be/abcdefghijk", undefined, sourceReader), /identity mismatch/);
    await assert.rejects(searchRecordings(owner!.id, "fixture", async () => new Response(null, { status: 429 })), /busy/);
    await assert.rejects(searchRecordings(owner!.id, "fixture", async () => new Response("x".repeat(1_000_001))), /too large/);
  } finally {
    globalDb.__mintDb = previous;
    if (secret === undefined) delete process.env.MINT_SIGNING_SECRET; else process.env.MINT_SIGNING_SECRET = secret;
    await pool.end(); await admin.query(`drop schema "${namespace}" cascade`); await admin.end();
  }
});
