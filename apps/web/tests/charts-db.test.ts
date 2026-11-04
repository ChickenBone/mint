import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { Redis } from "ioredis";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { schema } from "@mint/core/db";
import { signToken } from "@mint/core/crypto";
import { chartAcquisition, chartPage } from "../src/lib/chart-service";
import type { ChartEntry, ChartSnapshot } from "../src/lib/charts";

const database = process.env.MUSIC_TEST_DATABASE_URL, cache = process.env.CHART_TEST_REDIS_URL;
test("chart → exact local playback / explicit acquisition → progress → playable, with ownership and edition isolation", {
  skip: (!database || !cache) && "Set MUSIC_TEST_DATABASE_URL and CHART_TEST_REDIS_URL",
}, async (t) => {
  const namespace = `mint_charts_${randomUUID().replaceAll("-", "")}`, admin = new pg.Pool({ connectionString: database });
  await admin.query(`create database "${namespace}"`);
  const url = new URL(database!); url.pathname = `/${namespace}`;
  const pool = new pg.Pool({ connectionString: url.toString() }), db = drizzle(pool, { schema });
  const shared = globalThis as typeof globalThis & { __mintDb?: { db: typeof db; pool: pg.Pool }; __mintChartRedis?: Redis };
  const previous = shared.__mintDb, previousSecret = process.env.MINT_SIGNING_SECRET, previousRedis = process.env.REDIS_URL;
  shared.__mintDb = { db, pool };
  process.env.MINT_SIGNING_SECRET = "chart-integration-fixture-secret-at-least-32-characters";
  process.env.REDIS_URL = cache;
  const redis = new Redis(cache!);
  try {
    const root = new URL("../../../packages/core/migrations/", import.meta.url);
    const journal = JSON.parse(await readFile(new URL("meta/_journal.json", root), "utf8")) as { entries: { tag: string }[] };
    for (const migration of journal.entries) await pool.query(await readFile(new URL(`${migration.tag}.sql`, root), "utf8"));
    const [owner, other] = await db.insert(schema.users).values(["owner", "other"].map((name) =>
      ({ email: `${name}@charts.test`, name, status: "active" as const, passwordHash: "fixture" }))).returning();
    const recordingId = randomUUID(), entry: ChartEntry = { id: "missing", rank: 2, title: "Late Windows", artist: "Fictional Static",
      album: "Night Rooms", durationSec: 180, recordingId, isrc: "USFI12600001", artwork: null, genres: [], url: "https://musicbrainz.org/" };
    const [available] = await db.insert(schema.tracks).values({ title: "First Morning", artist: entry.artist, album: entry.album,
      durationSec: 180, stage: "ready", filePath: "/read-only-originals/first.flac", existingFilePath: "/read-only-originals/first.flac", plexRatingKey: "fixture" }).returning();
    const snapshot: ChartSnapshot = { entries: [{ ...entry, id: "available", rank: 1, title: available!.title, recordingId: null }, entry],
      period: "Fictional fixture period", fetchedAt: new Date().toISOString(), providerUpdatedAt: new Date().toISOString(), revision: "fixture", notice: null };
    await redis.set("mint:charts:v1:apple-us", JSON.stringify(snapshot), "EX", 3600);
    const publicPage = await chartPage("apple-us", null);
    assert.equal(publicPage.items[0]!.availability, "available"); assert.equal(publicPage.items[0]!.item, null);
    assert.equal(publicPage.items[1]!.availability, "missing");
    assert.ok(!JSON.stringify(publicPage).includes("/read-only-originals"));
    const privatePage = await chartPage("apple-us", owner!.id);
    assert.equal(privatePage.items[0]!.item!.id, available!.id);
    assert.equal((await chartPage("apple-us", owner!.id, 1, 1)).items[0]!.rank, 2);
    await assert.rejects(chartPage("apple-us", owner!.id, 1, 1, "changed"), /chart has changed/);
    t.mock.method(globalThis, "fetch", async (input: string) => {
      assert.equal(new URL(String(input)).hostname, "musicbrainz.org", "Only the recording identity is sent to MusicBrainz");
      assert.equal(new URL(String(input)).searchParams.get("query"), "isrc:USFI12600001", "Prefer the provider's recording identifier over a text search");
      return Response.json({ recordings: [{ id: recordingId, title: entry.title, length: 180000,
        "artist-credit": [{ name: entry.artist }], releases: [{ title: entry.album }], isrcs: [entry.isrc] }] });
    });
    const requests = await Promise.all(Array.from({ length: 4 }, () => chartAcquisition(owner!.id, { chart: "apple-us", entry: entry.id })));
    assert.ok(requests.every((result) => result.status === "requested"));
    const requested = requests[0]!;
    if (requested.status !== "requested") throw new Error("Expected an acquisition request");
    assert.equal(new Set(requests.flatMap((result) => result.status === "requested" ? [result.trackId] : [])).size, 1);
    assert.equal(await db.$count(schema.tracks), 2); assert.equal(await db.$count(schema.userTracks), 1);
    assert.equal((await chartPage("apple-us", owner!.id)).items[1]!.availability, "requested");
    await db.update(schema.tracks).set({ stage: "downloading", progress: .44 }).where(eq(schema.tracks.id, requested.trackId));
    const processing = (await chartPage("apple-us", owner!.id)).items[1]!;
    assert.equal(processing.availability, "processing"); assert.equal(processing.progress, 44);
    await db.update(schema.tracks).set({ stage: "ready", filePath: "/mint-downloads/fixture.flac", progress: 1 }).where(eq(schema.tracks.id, requested.trackId));
    const finished = (await chartPage("apple-us", owner!.id)).items[1]!;
    assert.equal(finished.availability, "available"); assert.equal(finished.item!.id, requested.trackId);
    assert.equal((await db.select().from(schema.tracks).where(eq(schema.tracks.id, available!.id)))[0]!.existingFilePath, "/read-only-originals/first.flac");
    const recording = { id: recordingId, title: entry.title, artist: entry.artist, album: entry.album, durationSec: 180 };
    const token = signToken("music-request", { userId: owner!.id, recording }, 60000);
    await db.update(schema.tracks).set({ stage: "failed", filePath: null }).where(eq(schema.tracks.id, requested.trackId));
    await assert.rejects(chartAcquisition(other!.id, { chart: "apple-us", entry: entry.id, token }), /expired/);
    await assert.rejects(chartAcquisition(owner!.id, { chart: "apple-us", entry: entry.id, token: `${token}invalid` }), /expired/);
    const wrong = signToken("music-request", { userId: owner!.id, recording: { ...recording, title: `${entry.title} (Live)` } }, 60000);
    await assert.rejects(chartAcquisition(owner!.id, { chart: "apple-us", entry: entry.id, token: wrong }), /differs/);
    const wrongIdentifier = signToken("music-request", { userId: owner!.id, recording: { ...recording, isrcs: ["USFI12600002"] } }, 60000);
    await assert.rejects(chartAcquisition(owner!.id, { chart: "apple-us", entry: entry.id, token: wrongIdentifier }), /differs/);
    assert.equal((await chartAcquisition(owner!.id, { chart: "apple-us", entry: entry.id, token })).status, "requested");
    assert.equal((await chartPage("apple-us", owner!.id)).items[1]!.availability, "requested");
    const duplicate = await db.insert(schema.tracks).values({ title: entry.title, artist: entry.artist, album: entry.album,
      durationSec: 180, mbRecordingId: recordingId, stage: "ready", filePath: "/another-edition.flac" }).returning();
    assert.equal((await chartAcquisition(other!.id, { chart: "apple-us", entry: entry.id })).status, "resolve");
    const otherToken = signToken("music-request", { userId: other!.id, recording }, 60000);
    await assert.rejects(chartAcquisition(other!.id, { chart: "apple-us", entry: entry.id, token: otherToken }), /Multiple library editions/);
    assert.equal((await chartPage("apple-us", other!.id)).items[1]!.availability, "ambiguous");
    assert.equal(await db.$count(schema.userTracks), 1, "Rejected ambiguity must not create request ownership");
    await db.delete(schema.tracks).where(eq(schema.tracks.id, duplicate[0]!.id));
    await db.update(schema.tracks).set({ title: `${entry.title} (Live)` }).where(eq(schema.tracks.id, requested.trackId));
    await assert.rejects(chartAcquisition(owner!.id, { chart: "apple-us", entry: entry.id, token }), /conflicting version/);
    await pool.query("set enable_seqscan = off");
    const plan = await pool.query("explain select id from tracks where mint_search_text(artist)=$1 and mint_search_text(title)=$2", ["fictional static", "late windows"]);
    assert.match(JSON.stringify(plan.rows), /tracks_chart_identity_idx/);
    process.env.MINT_CHARTS_ENABLED = "false";
    assert.equal((await chartPage("apple-us", null)).status, "error");
    delete process.env.MINT_CHARTS_ENABLED;
  } finally {
    shared.__mintDb = previous; shared.__mintChartRedis?.disconnect(); delete shared.__mintChartRedis;
    if (previousSecret === undefined) delete process.env.MINT_SIGNING_SECRET; else process.env.MINT_SIGNING_SECRET = previousSecret;
    if (previousRedis === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previousRedis;
    await redis.del("mint:charts:v1:apple-us"); redis.disconnect();
    await pool.end(); await admin.query(`drop database "${namespace}"`); await admin.end();
  }
});
