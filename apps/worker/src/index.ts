import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { QUEUE } from "@mint/core";
import { closeDb, getDb, schema } from "@mint/core/db";
import { runMigrations } from "@mint/core/db/migrate";
import { getRedis } from "@mint/core/redis";
import { hash } from "@node-rs/argon2";
import { Worker, type Processor } from "bullmq";
import { sql } from "drizzle-orm";
import { config } from "./config";
import { ensureDir } from "./files";
import { wireIntegrations } from "./integrations";
import { libraryIndexEnabled } from "./library-index";
import { keepExisting } from "./existing-track";
import { eq } from "drizzle-orm";
import { processAcquire, onAcquireFailed } from "./jobs/acquire";
import { processFinalize } from "./jobs/finalize";
import { processMaintenance } from "./jobs/maintenance";
import { processSonic } from "./jobs/sonic";
import { processSync } from "./jobs/sync";
import { processTorboxDownload } from "./jobs/torbox-bridge";
import { log } from "./log";
import { connection, queues } from "./queues";
import { updateTrack } from "./track-state";

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || "admin@mint.local";
  const password =
    process.env.ADMIN_PASSWORD ||
    (await readFile(path.join(process.env.MINT_SECRETS_DIR ?? "/secrets", "admin_password"), "utf8").then((s) => s.trim(), () => ""));
  if (!password) return;
  const db = getDb();
  const existing = await db.query.users.findFirst({ where: sql`lower(${schema.users.email}) = ${email.toLowerCase()}` });
  if (existing) return;
  await db.insert(schema.users).values({
    email,
    name: process.env.ADMIN_NAME ?? "Admin",
    passwordHash: await hash(password),
    role: "admin",
    status: "active",
    approvedAt: new Date(),
  });
  log.info({ email }, "seeded admin account");
}

async function main() {
  await runMigrations(process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations"));
  await seedAdmin();
  await ensureDir(config.stagingDir);
  for (const note of await wireIntegrations()) log.warn(note);

  const acquireWorker = new Worker(QUEUE.acquire, processAcquire as Processor, { connection, concurrency: config.concurrency.acquire });
  const finalizeWorker = new Worker(QUEUE.finalize, processFinalize, { connection, concurrency: config.concurrency.finalize });
  const sonicWorker = new Worker(QUEUE.sonic, processSonic as Processor, { connection, concurrency: 10 });
  const workers: Worker[] = [
    new Worker(QUEUE.sync, processSync, { connection, concurrency: 2 }),
    acquireWorker,
    finalizeWorker,
    sonicWorker,
    new Worker(QUEUE.torbox, processTorboxDownload, { connection, concurrency: config.concurrency.torbox }),
    new Worker(QUEUE.maintenance, processMaintenance, { connection, concurrency: 4 }),
  ];

  acquireWorker.on("failed", (job, err) => void onAcquireFailed(job, err).catch((error) => log.error({ err: error }, "could not record acquisition failure")));
  for (const w of [finalizeWorker, sonicWorker] as Worker<{ trackId: string }>[]) {
    w.on("failed", (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void (async () => {
          const track = await getDb().query.tracks.findFirst({ where: eq(schema.tracks.id, job.data.trackId) });
          if (track?.existingFilePath) await keepExisting(track, `Upgrade failed: ${err.message.slice(0, 200)}`);
          else await updateTrack(job.data.trackId, { stage: "failed", error: err.message.slice(0, 500), detail: `${w.name} failed` }, err.message);
        })().catch((error) => log.error({ err: error }, "could not record final job failure"));
      }
    });
  }
  for (const w of workers) w.on("error", (err) => log.error({ err, queue: w.name }, "worker error"));

  const m = queues.maintenance;
  await m.add("health", { kind: "health" });
  await m.add("artwork", { kind: "artwork" });
  await m.upsertJobScheduler("artwork", { every: 30_000 }, { name: "artwork", data: { kind: "artwork" } });
  await m.upsertJobScheduler("stats", { every: 5_000 }, { name: "stats", data: { kind: "stats" } });
  await m.upsertJobScheduler("leases", { every: 30_000 }, { name: "leases", data: { kind: "leases" } });
  await m.upsertJobScheduler("health", { every: 30_000 }, { name: "health", data: { kind: "health" } });
  await m.upsertJobScheduler("torbox-tick", { every: 15_000 }, { name: "torbox-tick", data: { kind: "torbox-tick" } });
  await m.upsertJobScheduler("schedule-sync", { every: config.syncIntervalMin * 60_000 }, { name: "schedule-sync", data: { kind: "schedule-sync" } });
  if (libraryIndexEnabled()) {
    await m.add("library-index", { kind: "library-index" }, { jobId: `library-index-start-${Date.now()}` });
    await m.upsertJobScheduler("library-index", { every: 6 * 3_600_000 }, { name: "library-index", data: { kind: "library-index" } });
  }

  const server = http.createServer(async (req, res) => {
    if (req.url !== "/healthz") return res.writeHead(404).end();
    try {
      await getRedis().ping();
      await getDb().execute(sql`select 1`);
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    } catch {
      res.writeHead(503).end('{"ok":false}');
    }
  });
  server.listen(Number(process.env.HEALTH_PORT ?? 8080));
  log.info("mint worker running");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    server.close();
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled(Object.values(queues).map((q) => q.close()));
    await connection.quit().catch(() => undefined);
    await getRedis().quit().catch(() => undefined);
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.fatal({ err }, "worker failed to start");
  process.exit(1);
});
