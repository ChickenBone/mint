import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { analysisSchema } from "@mint/core/analysis";
import { UUID } from "@mint/core/playback";
import { z } from "zod";
import { activeAnalysisLease, analysisHeartbeat, claimAnalysis, finishAnalysis, getAnalysisControls, releaseAnalysisLease } from "./analysis-jobs";
import { config } from "./config";
import { confinedMedia } from "./playback";

export function authorizedAnalysisWorker(header: string | undefined, secret = process.env.ANALYSIS_WORKER_TOKEN) {
  if (!secret || secret.length < 32 || !header?.startsWith("Bearer ") || header.length > 1024) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(secret));
}

const MAX_RESULT_BYTES = 1_048_576;

class PayloadOverflowError extends Error {
  constructor() { super("Analysis result exceeds 1 MiB limit"); }
}

async function body(req: IncomingMessage) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_RESULT_BYTES) throw new PayloadOverflowError();
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function parseWorkerTelemetryHeaders(req: IncomingMessage) {
  const rawId = req.headers["x-mint-worker-id"];
  const workerId = typeof rawId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(rawId) ? rawId : undefined;
  const rawEngine = req.headers["x-mint-engine-version"];
  const engineVersion = typeof rawEngine === "string" && rawEngine.length <= 64 ? rawEngine : undefined;
  const rawCaps = req.headers["x-mint-capabilities"];
  const capabilities = typeof rawCaps === "string"
    ? rawCaps.split(",").map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= 40).slice(0, 16)
    : undefined;
  const rawDuration = Number(req.headers["x-mint-analysis-duration-ms"]);
  const durationMs = Number.isFinite(rawDuration) && rawDuration >= 0 && rawDuration <= 3_600_000 ? Math.round(rawDuration) : undefined;
  return { workerId, engineVersion, capabilities, durationMs };
}

export async function serveAnalysisWorker(req: IncomingMessage, res: ServerResponse) {
  const reply = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" }).end(JSON.stringify(data));
  if (!authorizedAnalysisWorker(req.headers.authorization)) return void reply(401, { error: "Analysis worker authentication required", code: "unauthorized" });
  const url = new URL(req.url ?? "/", "http://worker");
  const { workerId, engineVersion, capabilities, durationMs } = parseWorkerTelemetryHeaders(req);
  if (req.method === "POST" && url.pathname === "/analysis/lease") {
    if (!workerId) return void reply(400, { error: "Invalid worker identity", code: "invalid-worker-id" });
    await analysisHeartbeat(workerId, "remote", null, { engineVersion, capabilities });
    const lease = await claimAnalysis("remote", workerId);
    return void reply(200, lease ? { lease: { trackId: lease.trackId, leaseId: lease.leaseId, controls: lease.controls } } : { lease: null });
  }
  const match = /^\/analysis\/(input|lease|result)\/([a-f0-9-]+)$/.exec(url.pathname);
  if (!match || !UUID.test(match[2]!)) return void reply(404, { error: "Unknown analysis endpoint", code: "not-found" });
  const kind = match[1]!, leaseId = match[2]!, lease = await activeAnalysisLease(leaseId);
  if (!lease) return void reply(409, { error: "Analysis lease no longer active", code: "lease-inactive" });
  const controls = await getAnalysisControls();
  if (req.method === "GET" && kind === "lease") {
    const active = controls.enabled && !controls.paused;
    if (workerId) await analysisHeartbeat(workerId, "remote", null, { engineVersion, capabilities, activeTrackId: active ? lease.trackId : null });
    if (!active) await releaseAnalysisLease(leaseId, workerId);
    return void reply(200, { active });
  }
  if (!controls.enabled || controls.paused) return void reply(409, { error: "Analysis is paused", code: "analysis-paused" });
  if (req.method === "POST" && kind === "result") {
    let rawBody: unknown;
    try {
      rawBody = await body(req);
    } catch (error) {
      if (error instanceof PayloadOverflowError) return void reply(413, { error: error.message, code: "payload-too-large" });
      return void reply(400, { error: "Malformed analysis result JSON", code: "invalid-json" });
    }
    const result = z.union([
      z.object({ analysis: analysisSchema }).strict(),
      z.object({ error: z.enum(["resource-limit", "decode-failed", "cancelled"]) }).strict(),
    ]).safeParse(rawBody);
    if (!result.success) {
      return void reply(400, {
        error: "Invalid measured analysis result",
        code: "schema-mismatch",
        issues: result.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`),
      });
    }
    const errors = {
      "resource-limit": "Remote analysis exceeded resource limits; increase the analysis time/duration budget and retry",
      "decode-failed": "Remote audio analysis failed; inspect remote worker logs, check ffmpeg and retry",
      cancelled: "Remote analysis was interrupted; retry this track",
    };
    if ("analysis" in result.data) {
      if (!lease.filePath) return void reply(409, { error: "Analysis source unavailable", code: "source-unavailable" });
      const file = await confinedMedia(lease.filePath, [config.musicDir, config.existingMusicDir]);
      const source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (process.platform === "linux") await confinedMedia(await realpath(`/proc/self/fd/${source.fd}`), [config.musicDir, config.existingMusicDir]);
        const stat = await source.stat(), fingerprint = result.data.analysis.fingerprint;
        if (stat.size !== fingerprint.bytes || stat.mtimeMs !== fingerprint.mtimeMs) {
          await finishAnalysis(leaseId, null, "Audio changed during remote analysis; retry when the file is stable", { workerId, durationMs, engineVersion });
          return void reply(409, { error: "Source fingerprint changed", code: "source-changed" });
        }
      } finally { await source.close(); }
    }
    const saved = "analysis" in result.data
      ? await finishAnalysis(leaseId, result.data.analysis, null, { workerId, durationMs, engineVersion: result.data.analysis.algorithm })
      : result.data.error === "cancelled"
        ? await releaseAnalysisLease(leaseId, workerId)
        : await finishAnalysis(leaseId, null, errors[result.data.error], { workerId, durationMs, engineVersion });
    return void reply(saved.length ? 200 : 409, saved.length ? { accepted: true } : { accepted: false, error: "Analysis lease expired or superseded", code: "lease-inactive" });
  }
  if (req.method !== "GET" || kind !== "input" || !lease.filePath) return void reply(405, { error: "Unsupported analysis request", code: "method-not-allowed" });
  const file = await confinedMedia(lease.filePath, [config.musicDir, config.existingMusicDir]);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (process.platform === "linux") await confinedMedia(await realpath(`/proc/self/fd/${handle.fd}`), [config.musicDir, config.existingMusicDir]);
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > 2 * 1024 ** 3) return void reply(413, { error: "Media exceeds analysis transfer limit" });
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": stat.size,
      "x-mint-analysis-mtime": String(stat.mtimeMs), "cache-control": "private, no-store" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), controls.timeoutSec * 1000);
    try { await pipeline(handle.createReadStream({ autoClose: false, start: 0 }), res, { signal: controller.signal }); }
    finally { clearTimeout(timer); }
  } finally { await handle.close(); }
}
