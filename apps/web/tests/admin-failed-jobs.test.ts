import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { schema } from "@mint/core/db";
import { claimAdminFailedRetry, listAdminFailedJobs, removeAdminFailedJobs } from "../src/lib/admin-failed-jobs";

const noWorkerRecords = async () => 0;

test("failed-job controls reject invalid attempt references before accessing the database", async () => {
  const db = drizzle.mock({ schema });
  for (const input of [
    { trackId: "not-a-uuid", failureVersion: "123.000000" },
    { trackId: randomUUID(), failureVersion: "123 OR true" },
    { trackId: randomUUID(), failureVersion: "" },
  ]) {
    await assert.rejects(removeAdminFailedJobs(db, noWorkerRecords, input), /Invalid/);
    await assert.rejects(claimAdminFailedRetry(db, input), /Invalid/);
  }
});

const database = process.env.MUSIC_TEST_DATABASE_URL;
test("admin queue removals preserve metadata and fence failed-attempt races", {
  skip: !database && "Set MUSIC_TEST_DATABASE_URL to a disposable PostgreSQL server",
}, async (suite) => {
  const namespace = `mint_failed_jobs_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: database });
  await admin.query(`create database "${namespace}"`);
  const url = new URL(database!); url.pathname = `/${namespace}`;
  const pool = new pg.Pool({ connectionString: url.toString() }), db = drizzle(pool, { schema });
  try {
    const root = new URL("../../../packages/core/migrations/", import.meta.url);
    const journal = JSON.parse(await readFile(new URL("meta/_journal.json", root), "utf8")) as {
      entries: { tag: string }[];
    };
    for (const migration of journal.entries) await pool.query(await readFile(new URL(`${migration.tag}.sql`, root), "utf8"));
    const [member] = await db.insert(schema.users).values({
      email: "queue@fixture.test", name: "Queue fixture", passwordHash: "fixture", status: "active",
    }).returning();
    const [playlist] = await db.insert(schema.playlists).values({
      userId: member!.id, youtubePlaylistId: "source-managed-fixture", title: "Source playlist",
    }).returning();
    const [failed, active, original] = await db.insert(schema.tracks).values([
      { title: "Failed import", artist: "Fixture", stage: "failed" as const, error: "Import failed",
        filePath: "/separate-downloads/fixture.flac" },
      { title: "Running import", artist: "Fixture", stage: "importing" as const },
      { title: "Original", artist: "Fixture", stage: "ready" as const, filePath: "/originals/fixture.flac" },
    ]).returning();
    await db.insert(schema.userTracks).values({ userId: member!.id, trackId: failed!.id, origin: "youtube" });
    await db.insert(schema.playlistTracks).values({ playlistId: playlist!.id, trackId: failed!.id, position: 0 });

    await suite.test("individual removal is persistent, leaves the track and source memberships intact, and rejects repeats", async () => {
      const [attempt] = await listAdminFailedJobs(db);
      assert.equal(attempt!.detail, "Import failed");
      const target = { trackId: attempt!.id, failureVersion: attempt!.failureVersion };
      assert.equal((await removeAdminFailedJobs(db, noWorkerRecords, target)).removed, 1);
      assert.deepEqual(await listAdminFailedJobs(db), []);
      assert.deepEqual((await db.select().from(schema.tracks).where(eq(schema.tracks.id, failed!.id)))[0], failed);
      assert.equal(await db.$count(schema.userTracks), 1);
      assert.equal(await db.$count(schema.playlistTracks), 1);
      assert.equal(await db.$count(schema.playlists), 1);
      assert.equal(await claimAdminFailedRetry(db, target), null, "Retry all must not resurrect a dismissed attempt");
      await assert.rejects(removeAdminFailedJobs(db, noWorkerRecords, target), /already removed/);
      assert.equal(await db.$count(schema.trackEvents), 1);
    });

    await suite.test("new failures reappear and stale removal cannot affect a retry or its later failure", async () => {
      await db.update(schema.tracks).set({ stage: "queued" }).where(eq(schema.tracks.id, failed!.id));
      await db.update(schema.tracks).set({ stage: "failed", error: "New failure" }).where(eq(schema.tracks.id, failed!.id));
      const [attempt] = await listAdminFailedJobs(db);
      assert.ok(attempt);
      assert.equal(attempt.detail, "New failure");
      const target = { trackId: attempt.id, failureVersion: attempt.failureVersion };
      assert.equal(await claimAdminFailedRetry(db, target), failed!.id);
      await assert.rejects(removeAdminFailedJobs(db, noWorkerRecords, target), /changed/);
      await db.update(schema.tracks).set({ stage: "failed", error: "Later failure",
        updatedAt: new Date(Date.now() + 1000) }).where(eq(schema.tracks.id, failed!.id));
      await assert.rejects(removeAdminFailedJobs(db, noWorkerRecords, target), /changed/);
      assert.equal((await listAdminFailedJobs(db))[0]!.detail, "Later failure");
    });

    await suite.test("clear all reaches beyond the 100-row view without touching active jobs or originals", async () => {
      await db.insert(schema.tracks).values(Array.from({ length: 105 }, (_, index) => ({
        title: `Failed ${index}`, artist: "Fixture", stage: "failed" as const,
      })));
      assert.equal((await listAdminFailedJobs(db)).length, 100);
      assert.equal((await removeAdminFailedJobs(db, noWorkerRecords)).removed, 106);
      assert.deepEqual(await listAdminFailedJobs(db), []);
      assert.equal((await removeAdminFailedJobs(db, noWorkerRecords)).removed, 0);
      assert.deepEqual((await db.select().from(schema.tracks).where(eq(schema.tracks.id, active!.id)))[0], active);
      assert.deepEqual((await db.select().from(schema.tracks).where(eq(schema.tracks.id, original!.id)))[0], original);
      assert.equal(await db.$count(schema.tracks), 108);
      assert.equal(await db.$count(schema.playlistTracks), 1);
    });

    await suite.test("a concurrent member retry wins its row lock and is not removed", async () => {
      const [track] = await db.insert(schema.tracks).values({
        title: "Concurrent retry", artist: "Fixture", stage: "failed",
      }).returning();
      const [attempt] = await listAdminFailedJobs(db);
      const member = await pool.connect();
      try {
        await member.query("begin");
        await member.query("update tracks set stage = 'queued', updated_at = now() where id = $1", [track!.id]);
        const removal = removeAdminFailedJobs(db, noWorkerRecords, { trackId: track!.id, failureVersion: attempt!.failureVersion });
        const outcome = assert.rejects(removal, /changed/);
        await member.query("commit");
        await outcome;
        assert.equal((await db.select().from(schema.tracks).where(eq(schema.tracks.id, track!.id)))[0]!.stage, "queued");
        assert.equal(await db.$count(schema.trackEvents, eq(schema.trackEvents.trackId, track!.id)), 0);
      } finally {
        await member.query("rollback");
        member.release();
      }
    });

    await suite.test("simultaneous admin removals append only one dismissal", async () => {
      const [track] = await db.insert(schema.tracks).values({
        title: "Concurrent removals", artist: "Fixture", stage: "failed",
      }).returning();
      const attempt = (await listAdminFailedJobs(db)).find((item) => item.id === track!.id)!;
      const input = { trackId: attempt.id, failureVersion: attempt.failureVersion };
      const results = await Promise.allSettled([
        removeAdminFailedJobs(db, noWorkerRecords, input), removeAdminFailedJobs(db, noWorkerRecords, input),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(await db.$count(schema.trackEvents, eq(schema.trackEvents.trackId, track!.id)), 1);
    });

    await suite.test("partial worker cleanup errors never hide failed attempts and can be retried", async () => {
      const [track] = await db.insert(schema.tracks).values({
        title: "Partial cleanup", artist: "Fixture", stage: "failed",
      }).returning();
      const result = await removeAdminFailedJobs(db, async () => { throw new Error("Redis unavailable"); });
      assert.equal(result.removed, 0);
      assert.equal(result.failed, 1);
      assert.equal(result.failure, "Redis unavailable");
      assert.equal((await listAdminFailedJobs(db))[0]!.id, track!.id);
      assert.equal(await db.$count(schema.trackEvents, eq(schema.trackEvents.trackId, track!.id)), 0);
      assert.equal((await removeAdminFailedJobs(db, noWorkerRecords)).removed, 1);
    });
  } finally {
    await pool.end(); await admin.query(`drop database "${namespace}"`); await admin.end();
  }
});
