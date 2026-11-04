import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { schema } from "@mint/core/db";
import { signToken } from "@mint/core/crypto";
import { requestRecording, searchRecordings, youtubeSource } from "../src/lib/music-requests";

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
    for (const name of ["0000_init", "0001_workers", "0002_drop_previews", "0003_track_artwork_url", "0004_existing_library", "0009_playback_scale"]) {
      const source = await readFile(new URL(`../../../packages/core/migrations/${name}.sql`, import.meta.url), "utf8");
      for (const statement of source.replaceAll('"public".', `"${namespace}".`).split("--> statement-breakpoint")) if (statement.trim()) await pool.query(statement);
    }
    const [owner, other] = await db.insert(schema.users).values(["owner", "other"].map((name) =>
      ({ email: `${name}@requests.test`, name, status: "active" as const, passwordHash: "fixture" }))).returning();
    const id = randomUUID(), item = { id, title: "First Light", artist: "Mint Fixture", album: "Browser Sessions", durationSec: 90 };
    const results = await searchRecordings(owner!.id, "first light", async (input, init) => {
      assert.equal(new URL(String(input)).hostname, "musicbrainz.org");
      assert.ok(new Headers(init?.headers).get("user-agent")?.startsWith("Mint/"));
      return Response.json({ recordings: [{ id, title: item.title, length: 90000, "artist-credit": [{ name: item.artist }], releases: [{ title: item.album }] }] });
    });
    assert.equal(results.length, 1); assert.equal(results[0]!.existing, null);
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
    const retried = await requestRecording(owner!.id, token, "https://youtu.be/abcdefghijk");
    assert.equal(retried.stage, "queued"); assert.equal(retried.needsQueue, true);
    const [stored] = await db.select().from(schema.tracks).where(eq(schema.tracks.id, trackId));
    assert.equal(stored!.youtubeVideoId, "abcdefghijk"); assert.equal(stored!.error, null);
    await db.update(schema.tracks).set({ stage: "ready", filePath: "/fixture/audio.flac" }).where(eq(schema.tracks.id, trackId));
    const secondToken = signToken("music-request", { userId: other!.id, recording: item }, 60000);
    assert.equal((await requestRecording(other!.id, secondToken)).needsQueue, false);
    const wrongRecording = signToken("music-request", { userId: owner!.id, recording: { ...item, id: randomUUID(), title: "Other Recording" } }, 60000);
    await assert.rejects(requestRecording(owner!.id, wrongRecording, "https://youtu.be/abcdefghijk"), /different recording/);
    await assert.rejects(searchRecordings(owner!.id, "fixture", async () => new Response(null, { status: 429 })), /busy/);
    await assert.rejects(searchRecordings(owner!.id, "fixture", async () => new Response("x".repeat(1_000_001))), /too large/);
  } finally {
    globalDb.__mintDb = previous;
    if (secret === undefined) delete process.env.MINT_SIGNING_SECRET; else process.env.MINT_SIGNING_SECRET = secret;
    await pool.end(); await admin.query(`drop schema "${namespace}" cascade`); await admin.end();
  }
});
