import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import { schema } from "@mint/core/db";
import { DEFAULT_ANALYSIS_CONTROLS } from "@mint/core/analysis";
import { advanceAnalysisBackfill, analysisBackfills, analysisSettings, analysisWorkers, cancelAnalysis, enqueueAnalysis, similarAnalyzedTracks, startAnalysisBackfill, trackAnalysis } from "@mint/core/analysis-db";
import { analyzeAudio } from "./analysis-engine";
import { authorizedAnalysisWorker, serveAnalysisWorker } from "./analysis-http";
import { claimAnalysis, finishAnalysis, startAnalysisScheduler } from "./analysis-jobs";
import { runRemoteAnalysis } from "./analysis-worker";
import { config } from "./config";

function originalTone(frequency: number) {
  const rate = 48000, samples = rate * 2, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(10000 * Math.sin(i / rate * frequency * 2 * Math.PI)), 44 + i * 2);
  return bytes;
}

test("analysis worker authentication requires its own sufficiently long exact bearer secret", () => {
  const secret = "analysis-test-only-credential-at-least-32-characters";
  assert.equal(authorizedAnalysisWorker(`Bearer ${secret}`, secret), true);
  assert.equal(authorizedAnalysisWorker(`Bearer ${secret}x`, secret), false);
  assert.equal(authorizedAnalysisWorker(`Bearer ${secret}`, "short"), false);
  assert.equal(authorizedAnalysisWorker(undefined, secret), false);
});

const url = process.env.ANALYSIS_TEST_DATABASE_URL;
test("PostgreSQL jobs, resumable leases, controls and separately authenticated offload work end to end",
  { skip: !url && "Set ANALYSIS_TEST_DATABASE_URL for isolated PostgreSQL integration" }, async (suite) => {
    const namespace = `analysis_test_${randomUUID().replaceAll("-", "")}`, root = path.resolve(`.analysis-integration-${randomUUID()}`);
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`create schema "${namespace}"`);
    const pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${namespace}` });
    const db = drizzle(pool, { schema });
    const globals = globalThis as unknown as { __mintDb?: { db: typeof db; pool: pg.Pool } };
    const previousDb = globals.__mintDb, previousRoot = config.musicDir, previousExisting = config.existingMusicDir;
    const previousToken = process.env.ANALYSIS_WORKER_TOKEN;
    globals.__mintDb = { db, pool }; config.musicDir = root; config.existingMusicDir = root;
    await mkdir(root);
    try {
      for (const migration of ["0000_init", "0001_workers", "0002_drop_previews", "0003_track_artwork_url", "0004_existing_library", "0005_analysis", "0011_analysis_backfill"]) {
        const source = await readFile(new URL(`../../../packages/core/migrations/${migration}.sql`, import.meta.url), "utf8");
        for (const statement of source.replaceAll('"public".', `"${namespace}".`).split("--> statement-breakpoint")) if (statement.trim()) await pool.query(statement);
      }
      const toneFile = path.join(root, "first.wav"), bassFile = path.join(root, "second.wav"), toneBytes = originalTone(1000);
      await writeFile(toneFile, toneBytes); await writeFile(bassFile, originalTone(110));
      const [a, b, c] = await db.insert(schema.tracks).values([
        { title: "Original high", artist: "Synthetic only", stage: "ready" as const, filePath: toneFile },
        { title: "Original low", artist: "Synthetic only", stage: "ready" as const, existingFilePath: bassFile },
        { title: "Original high duplicate", artist: "Other metadata", stage: "ready" as const, filePath: toneFile },
      ]).returning();
      assert.ok(a && b && c);
      await db.insert(schema.tracks).values({ title: "Not available", artist: "Fixture", stage: "queued" });
      const controls = { ...DEFAULT_ANALYSIS_CONTROLS, intervalSec: 5, maxDurationSec: 10, timeoutSec: 30 };
      await db.insert(analysisSettings).values({ controls });
      const setControls = (patch: Partial<typeof controls>) => db.update(analysisSettings).set({ controls: { ...controls, ...patch } }).where(eq(analysisSettings.id, "global"));
      const result = await analyzeAudio(toneFile, controls), bass = await analyzeAudio(bassFile, controls);
      const row = async (id: string) => (await db.select().from(trackAnalysis).where(eq(trackAnalysis.trackId, id)))[0]!;
      await suite.test("backfill dedupes and concurrent workers respect a single global resource cap", async () => {
        assert.equal(await enqueueAnalysis(db), 3);
        assert.equal(await enqueueAnalysis(db), 0);
        const claimed = (await Promise.all(Array.from({ length: 8 }, () => claimAnalysis()))).filter((lease) => lease !== null);
        assert.equal(claimed.length, 1);
        assert.equal((await row(claimed[0]!.trackId)).attempts, 1);
        assert.equal((await finishAnalysis(claimed[0]!.leaseId, result)).length, 1);
        assert.equal((await finishAnalysis(claimed[0]!.leaseId, result)).length, 0);
        await assert.rejects(finishAnalysis(randomUUID(), null), /must contain measured data/);
      });
      await suite.test("expired leases resume and cancellation/retry rejects stale worker results", async () => {
        await setControls({ concurrency: 2 });
        const first = await claimAnalysis(), second = await claimAnalysis();
        assert.ok(first && second);
        assert.equal(await claimAnalysis(), null);
        await cancelAnalysis(db, first.trackId);
        assert.equal((await finishAnalysis(first.leaseId, result)).length, 0);
        assert.equal((await row(first.trackId)).status, "cancelled");
        await db.update(trackAnalysis).set({ leaseExpiresAt: new Date(0) }).where(eq(trackAnalysis.trackId, second.trackId));
        const resumed = await claimAnalysis();
        assert.ok(resumed);
        assert.equal(resumed.trackId, second.trackId);
        assert.notEqual(resumed.leaseId, second.leaseId);
        assert.equal((await row(resumed.trackId)).attempts, 2);
        assert.equal((await finishAnalysis(second.leaseId, result)).length, 0);
        await finishAnalysis(resumed.leaseId, result);
        assert.equal(await enqueueAnalysis(db, { trackId: first.trackId, refresh: true }), 1);
        const retry = await claimAnalysis(); assert.ok(retry);
        await finishAnalysis(retry.leaseId, result);
        await db.update(trackAnalysis).set({ status: "failed", error: "Fixture failure" }).where(eq(trackAnalysis.trackId, b.id));
        assert.equal(await enqueueAnalysis(db), 0);
        assert.equal(await enqueueAnalysis(db, { retryFailed: true }), 1);
      });
      await suite.test("pause, disable and UTC schedule prevent admission without losing queued jobs", async () => {
        for (const patch of [{ paused: true }, { enabled: false }, { startHourUtc: (new Date().getUTCHours() + 1) % 24, endHourUtc: (new Date().getUTCHours() + 2) % 24 }]) {
          await setControls(patch);
          assert.equal(await claimAnalysis(), null);
          assert.equal((await row(b.id)).status, "pending");
        }
        await setControls({});
      });
      await suite.test("repeatedly interrupted jobs stop after three attempts and allow explicit retry", async () => {
        await db.update(trackAnalysis).set({ status: "running", attempts: 3, leaseId: randomUUID(), leaseExpiresAt: new Date(0) }).where(eq(trackAnalysis.trackId, b.id));
        assert.equal(await claimAnalysis(), null);
        assert.equal((await row(b.id)).status, "failed");
        assert.match((await row(b.id)).error!, /lease expired/i);
        assert.equal(await enqueueAnalysis(db, { trackId: b.id, retryFailed: true }), 1);
        assert.equal((await row(b.id)).attempts, 0);
      });
      await suite.test("the NAS scheduler completes measured analysis from its persistent backlog", async () => {
        const scheduler = startAnalysisScheduler();
        try {
          const end = Date.now() + 15_000;
          while ((await row(b.id)).status !== "complete" && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100));
          assert.equal((await row(b.id)).status, "complete");
          assert.equal((await row(b.id)).result?.fingerprint.sha256, bass.fingerprint.sha256);
          assert.ok((await db.select().from(analysisWorkers)).some((worker) => worker.mode === "local"));
        } finally { await scheduler.close(); }
        assert.deepEqual(await readFile(toneFile), toneBytes);
      });
      await suite.test("similarity is derived from audio, excludes seeds and rejects incomplete tracks", async () => {
        await db.update(trackAnalysis).set({ status: "complete", result }).where(eq(trackAnalysis.trackId, a.id));
        await db.update(trackAnalysis).set({ status: "complete", result }).where(eq(trackAnalysis.trackId, c.id));
        await db.update(trackAnalysis).set({ status: "complete", result: bass }).where(eq(trackAnalysis.trackId, b.id));
        const nearest = await similarAnalyzedTracks(db, [a.id]);
        assert.equal(nearest[0]?.trackId, c.id);
        assert.equal(nearest[0]?.distance, 0);
        assert.ok(nearest[1]!.distance > 0.1);
        assert.equal(await similarAnalyzedTracks(db, []).then((rows) => rows.length), 0);
        await db.update(trackAnalysis).set({ status: "failed" }).where(eq(trackAnalysis.trackId, c.id));
        assert.equal((await similarAnalyzedTracks(db, [a.id])).some((item) => item.trackId === c.id), false);
      });
      await suite.test("optional HTTP worker authenticates separately, measures bytes and preserves source fingerprints", async () => {
        process.env.ANALYSIS_WORKER_TOKEN = "test-only-separate-analysis-token-at-least-32-characters";
        const server = http.createServer((request, response) => void serveAnalysisWorker(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(503).end(); else response.destroy();
        }));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address(); assert.ok(address && typeof address !== "string");
        const base = `http://127.0.0.1:${address.port}`, cacheDir = path.join(root, "remote-cache");
        try {
          assert.equal((await fetch(`${base}/analysis/lease`, { method: "POST" })).status, 401);
          assert.equal((await fetch(`${base}/analysis/lease`, { method: "POST", headers: { authorization: "Bearer wrong", "x-mint-worker-id": "fake" } })).status, 401);
          assert.equal(await enqueueAnalysis(db, { trackId: b.id, refresh: true }), 1);
          await runRemoteAnalysis({ server: base, token: process.env.ANALYSIS_WORKER_TOKEN, cacheDir, signal: new AbortController().signal, once: true });
          const measured = await row(b.id);
          assert.equal(measured.status, "complete");
          assert.equal(measured.result?.fingerprint.sha256, bass.fingerprint.sha256);
          assert.equal(measured.result?.fingerprint.mtimeMs, bass.fingerprint.mtimeMs);
          assert.deepEqual(await readdir(cacheDir), []);
          assert.ok((await db.select().from(analysisWorkers)).some((worker) => worker.mode === "remote"));
          assert.deepEqual(await readFile(toneFile), toneBytes);
          await enqueueAnalysis(db, { trackId: b.id, refresh: true });
          const lease = await claimAnalysis(); assert.ok(lease);
          await cancelAnalysis(db, b.id);
          assert.equal((await fetch(`${base}/analysis/result/${lease.leaseId}`, {
            method: "POST", headers: { authorization: `Bearer ${process.env.ANALYSIS_WORKER_TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ analysis: bass }),
          })).status, 409);
          assert.equal((await row(b.id)).status, "cancelled");
          await setControls({ concurrency: 2 });
          assert.equal(await enqueueAnalysis(db, { refresh: true, retryFailed: true }), 3);
          const workerId = `analysis-parallel-${randomUUID()}`;
          await Promise.all(Array.from({ length: 2 }, () => runRemoteAnalysis({
            server: base, token: process.env.ANALYSIS_WORKER_TOKEN!, cacheDir,
            signal: new AbortController().signal, once: true, workerId,
          })));
          assert.equal((await db.select().from(trackAnalysis)).filter((job) => job.status === "complete").length, 2);
          assert.equal((await db.select().from(trackAnalysis)).filter((job) => job.status === "pending").length, 1);
          assert.equal((await db.select().from(analysisWorkers).where(eq(analysisWorkers.id, workerId))).length, 1);
          assert.deepEqual(await readdir(cacheDir), []);
        } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
      });
      await suite.test("full-library scans exceed 500, resume atomically and never replace pending/running jobs", async () => {
        await setControls({ paused: true });
        const fixtures = await db.insert(schema.tracks).values(Array.from({ length: 1203 }, (_, i) => ({
          title: `Bulk original ${i}`, artist: "Synthetic only", stage: "ready" as const, filePath: toneFile,
        }))).returning({ id: schema.tracks.id });
        const protectedIds = fixtures.slice(0, 2).map((track) => track.id);
        const leaseId = randomUUID();
        await db.insert(trackAnalysis).values([
          { trackId: protectedIds[0]!, status: "running", attempts: 2, leaseId, leaseExpiresAt: new Date(Date.now() + 60_000) },
          { trackId: protectedIds[1]!, status: "pending", attempts: 2 },
          { trackId: fixtures[2]!.id, status: "failed", attempts: 3 },
          { trackId: fixtures[3]!.id, status: "cancelled", attempts: 1 },
        ]);
        assert.ok(await startAnalysisBackfill(db, "all"));
        assert.equal(await startAnalysisBackfill(db, "all"), null);
        const first = await advanceAnalysisBackfill(db);
        assert.equal(first?.scanned, 500);
        assert.equal(first?.status, "queuing");
        const [persisted] = await db.select().from(analysisBackfills);
        assert.equal(persisted?.cursor, first?.cursor);
        const concurrent = await Promise.all([advanceAnalysisBackfill(db), advanceAnalysisBackfill(db)]);
        assert.ok(concurrent.some((scan) => scan?.status === "queued"));
        const [finished] = await db.select().from(analysisBackfills);
        assert.equal(finished?.scanned, 1206);
        assert.equal(finished?.total, 1206);
        assert.equal((await row(protectedIds[0]!)).leaseId, leaseId);
        assert.equal((await row(protectedIds[0]!)).attempts, 2);
        assert.equal((await row(protectedIds[1]!)).attempts, 2);
        assert.equal((await row(fixtures[2]!.id)).status, "pending");
        assert.equal((await row(fixtures[3]!.id)).status, "pending");
        assert.equal(await claimAnalysis(), null, "bulk actions must not bypass pause");
        const before = (await db.select().from(trackAnalysis)).length;
        await advanceAnalysisBackfill(db);
        assert.equal((await db.select().from(trackAnalysis)).length, before);
        await startAnalysisBackfill(db, "all");
        await advanceAnalysisBackfill(db);
        await cancelAnalysis(db);
        assert.equal((await advanceAnalysisBackfill(db))?.status, "cancelled");
        assert.equal((await row(protectedIds[0]!)).status, "cancelled");
        const remoteOnly = process.env.ANALYSIS_REMOTE_ONLY;
        process.env.ANALYSIS_REMOTE_ONLY = "true";
        const scan = async () => (await db.select().from(analysisBackfills))[0]!;
        await startAnalysisBackfill(db, "all");
        let scheduler = startAnalysisScheduler();
        try {
          let deadline = Date.now() + 5000;
          while ((await scan()).scanned < 500 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal((await scan()).scanned, 500);
          await scheduler.close();
          scheduler = startAnalysisScheduler();
          deadline = Date.now() + 8000;
          while ((await scan()).status === "queuing" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal((await scan()).scanned, 1206);
          assert.equal((await scan()).status, "queued");
          assert.ok((await db.select().from(analysisWorkers)).some((worker) => worker.mode === "coordinator"));
          assert.equal(await claimAnalysis(), null, "paused remote-only scans queue without starting audio processing");
        } finally {
          await scheduler.close();
          if (remoteOnly === undefined) delete process.env.ANALYSIS_REMOTE_ONLY; else process.env.ANALYSIS_REMOTE_ONLY = remoteOnly;
        }
        await db.delete(trackAnalysis).where(inArray(trackAnalysis.trackId, fixtures.map((track) => track.id)));
        await db.delete(schema.tracks).where(inArray(schema.tracks.id, fixtures.map((track) => track.id)));
      });
      await suite.test("missing-only library scans preserve completed, failed and cancelled measurements", async () => {
        await db.update(trackAnalysis).set({ status: "complete", result }).where(eq(trackAnalysis.trackId, a.id));
        await db.update(trackAnalysis).set({ status: "failed" }).where(eq(trackAnalysis.trackId, b.id));
        await db.update(trackAnalysis).set({ status: "cancelled" }).where(eq(trackAnalysis.trackId, c.id));
        await startAnalysisBackfill(db, "missing");
        assert.equal((await advanceAnalysisBackfill(db))?.queued, 0);
        assert.equal((await row(a.id)).status, "complete");
        assert.equal((await row(b.id)).status, "failed");
        assert.equal((await row(c.id)).status, "cancelled");
        await db.update(trackAnalysis).set({ version: 0 }).where(eq(trackAnalysis.trackId, b.id));
        await startAnalysisBackfill(db, "missing");
        assert.equal((await advanceAnalysisBackfill(db))?.queued, 1);
        assert.equal((await row(b.id)).status, "pending");
        await db.delete(schema.tracks);
        assert.equal((await startAnalysisBackfill(db, "all"))?.status, "queued");
        assert.equal((await advanceAnalysisBackfill(db))?.total, 0);
      });
    } finally {
      globals.__mintDb = previousDb; config.musicDir = previousRoot; config.existingMusicDir = previousExisting;
      if (previousToken === undefined) delete process.env.ANALYSIS_WORKER_TOKEN; else process.env.ANALYSIS_WORKER_TOKEN = previousToken;
      await pool.end(); await admin.query(`drop schema "${namespace}" cascade`); await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  });
