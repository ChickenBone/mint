/**
 * Mint hub: the only home-server HTTP surface besides the WebSocket gateway.
 *  - PUT  /ingest/:trackId   volunteer workers upload finished audio (signed, lease-bound token)
 *  - GET  /media/preview/:id.mp3, /media/art/:id.jpg   public 30s previews and cover art
 * It holds no Plex/Lidarr/TorBox credentials and only mounts the staging (rw) and preview (ro) volumes.
 */
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CHANNEL, jobId, publish, toWorkerView, type UploadTokenPayload } from "@mint/core";
import { verifyToken } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { and, eq, sql } from "drizzle-orm";
import { config } from "./config";
import { ensureDir } from "./files";
import { log } from "./log";
import { containerFor, probe } from "./media";
import { queues } from "./queues";
import { updateTrack } from "./track-state";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONCURRENT_UPLOADS = Number(process.env.HUB_MAX_UPLOADS ?? 8);
let uploading = 0;

class HttpFail extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

// ---------- media ----------

async function serveMedia(req: http.IncomingMessage, res: http.ServerResponse, rel: string, type: string) {
  const root = path.resolve(config.previewDir);
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return json(res, 404, { error: "not found" });
  const info = await fs.stat(file).catch(() => null);
  if (!info?.isFile()) return json(res, 404, { error: "not found" });

  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
    "x-content-type-options": "nosniff",
    etag,
    "last-modified": info.mtime.toUTCString(),
  };
  if (req.headers["if-none-match"] === etag) return res.writeHead(304, headers).end();

  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : info.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : info.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, info.size - 1);
    if (start > end) return res.writeHead(416, { "content-range": `bytes */${info.size}` }).end();
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": String(end - start + 1) });
    if (req.method === "HEAD") return res.end();
    return void pipeline(createReadStream(file, { start, end }), res).catch(() => undefined);
  }
  res.writeHead(200, { ...headers, "content-length": String(info.size) });
  if (req.method === "HEAD") return res.end();
  return void pipeline(createReadStream(file), res).catch(() => undefined);
}

// ---------- ingest ----------

async function ingest(req: http.IncomingMessage, trackId: string) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claim = verifyToken<UploadTokenPayload>("upload", auth);
  if (!claim || claim.trackId !== trackId) throw new HttpFail(401, "invalid or expired upload token");

  const declared = Number(req.headers["content-length"]);
  if (declared > config.maxUploadBytes) throw new HttpFail(413, "file too large");

  const db = getDb();
  const t = schema.tracks;
  const track = await db.query.tracks.findFirst({ where: eq(t.id, trackId) });
  if (!track || track.leaseId !== claim.leaseId || track.leaseWorkerId !== claim.workerId) {
    throw new HttpFail(409, "lease no longer held");
  }

  await ensureDir(config.stagingDir);
  const tmp = path.join(config.stagingDir, `${trackId}.${claim.leaseId}.upload`);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > config.maxUploadBytes) return cb(new HttpFail(413, "file too large"));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limit, createWriteStream(tmp));
    if (bytes < 64 * 1024) throw new HttpFail(422, "file too small to be a song");

    const info = await probe(tmp).catch(() => null);
    if (!info?.codec) throw new HttpFail(422, "not an audio file");
    if (info.durationSec !== null && info.durationSec < 10) throw new HttpFail(422, "audio is shorter than 10 seconds");
    if (track.durationSec && info.durationSec) {
      const tolerance = Math.max(20, track.durationSec * 0.15);
      if (Math.abs(info.durationSec - track.durationSec) > tolerance) {
        throw new HttpFail(422, `duration ${info.durationSec}s does not match expected ${track.durationSec}s`);
      }
    }

    const dest = path.join(config.stagingDir, `${trackId}.remote.${containerFor(info.codec).ext}`);
    // Release the lease atomically; a concurrent reaper or retry wins over a late upload.
    const [won] = await db
      .update(t)
      .set({ remoteAt: null, leaseId: null, leaseWorkerId: null, leaseExpiresAt: null, workerId: claim.workerId })
      .where(and(eq(t.id, trackId), eq(t.leaseId, claim.leaseId)))
      .returning({ id: t.id });
    if (!won) throw new HttpFail(409, "lease no longer held");
    await fs.rename(tmp, dest);

    const [worker] = await db
      .update(schema.workers)
      .set({ completed: sql`${schema.workers.completed} + 1`, bytes: sql`${schema.workers.bytes} + ${bytes}` })
      .where(eq(schema.workers.id, claim.workerId))
      .returning();
    await updateTrack(trackId, { stage: "importing", detail: "Received from a volunteer worker", progress: 1 }, `Uploaded by worker ${worker?.name ?? claim.workerId}`);

    try {
      await queues.finalize.remove(jobId.finalize(trackId)).catch(() => undefined);
      await queues.finalize.add(
        "finalize",
        { trackId, sourcePath: dest, source: "cobalt", inLibrary: false, workerId: claim.workerId },
        { jobId: jobId.finalize(trackId) },
      );
    } catch (err) {
      // The upload is already committed; surface it as a retryable failure rather than a silent stall.
      log.error({ err, trackId }, "could not queue finalize for an accepted upload");
      await updateTrack(trackId, { stage: "failed", error: "Upload received but could not be queued. Retry the track." }, "Finalize queue unavailable");
    }
    if (worker) {
      const view = toWorkerView(worker);
      const redis = getRedis();
      await Promise.all([publish(redis, CHANNEL.user(worker.userId), { type: "worker", data: view }), publish(redis, CHANNEL.admin, { type: "worker", data: view })]);
    }
    log.info({ trackId, workerId: claim.workerId, bytes, codec: info.codec }, "ingested remote upload");
    return { ok: true, bytes, codec: info.codec, durationSec: info.durationSec };
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

// ---------- server ----------

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://hub");
  const p = url.pathname;

  if (p === "/healthz") return json(res, 200, { ok: true, uploading });

  if (req.method === "GET" || req.method === "HEAD") {
    const preview = /^\/media\/preview\/([0-9a-f-]{36})\.mp3$/i.exec(p);
    if (preview && UUID.test(preview[1]!)) return void serveMedia(req, res, `${preview[1]!.toLowerCase()}.mp3`, "audio/mpeg");
    const art = /^\/media\/art\/([0-9a-f-]{36})\.jpg$/i.exec(p);
    if (art && UUID.test(art[1]!)) return void serveMedia(req, res, `art/${art[1]!.toLowerCase()}.jpg`, "image/jpeg");
    return json(res, 404, { error: "not found" });
  }

  const up = /^\/ingest\/([0-9a-f-]{36})$/i.exec(p);
  if (req.method === "PUT" && up && UUID.test(up[1]!)) {
    if (uploading >= MAX_CONCURRENT_UPLOADS) {
      res.setHeader("retry-after", "30");
      req.resume();
      return json(res, 503, { error: "hub busy, retry shortly" });
    }
    uploading++;
    ingest(req, up[1]!.toLowerCase())
      .then((body) => json(res, 201, body))
      .catch((err: unknown) => {
        const status = err instanceof HttpFail ? err.status : 500;
        if (status >= 500) log.error({ err, trackId: up[1] }, "ingest failed");
        else log.warn({ trackId: up[1], status, reason: (err as Error).message }, "ingest rejected");
        if (!req.complete) req.resume();
        json(res, status, { error: status >= 500 ? "internal error" : (err as Error).message });
      })
      .finally(() => uploading--);
    return;
  }

  json(res, 404, { error: "not found" });
});

server.requestTimeout = 60 * 60 * 1000;
server.listen(config.hubPort, () => log.info({ port: config.hubPort }, "mint hub listening"));

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 30_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
