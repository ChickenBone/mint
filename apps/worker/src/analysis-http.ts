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

async function body(req: IncomingMessage) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 128_000) throw new Error("Analysis result too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function serveAnalysisWorker(req: IncomingMessage, res: ServerResponse) {
  const reply = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" }).end(JSON.stringify(data));
  if (!authorizedAnalysisWorker(req.headers.authorization)) return void reply(401, { error: "Analysis worker authentication required" });
  const url = new URL(req.url ?? "/", "http://worker");
  if (req.method === "POST" && url.pathname === "/analysis/lease") {
    const rawId = req.headers["x-mint-worker-id"];
    if (typeof rawId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(rawId)) return void reply(400, { error: "Invalid worker identity" });
    await analysisHeartbeat(rawId, "remote");
    const lease = await claimAnalysis();
    return void reply(200, lease ? { lease: { trackId: lease.trackId, leaseId: lease.leaseId, controls: lease.controls } } : { lease: null });
  }
  const match = /^\/analysis\/(input|lease|result)\/([a-f0-9-]+)$/.exec(url.pathname);
  if (!match || !UUID.test(match[2]!)) return void reply(404, { error: "Unknown analysis endpoint" });
  const kind = match[1]!, leaseId = match[2]!, lease = await activeAnalysisLease(leaseId);
  if (!lease) return void reply(409, { error: "Analysis lease no longer active" });
  const controls = await getAnalysisControls();
  if (req.method === "GET" && kind === "lease") {
    const active = controls.enabled && !controls.paused, rawId = req.headers["x-mint-worker-id"];
    if (typeof rawId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(rawId)) await analysisHeartbeat(rawId, "remote");
    if (!active) await releaseAnalysisLease(leaseId);
    return void reply(200, { active });
  }
  if (!controls.enabled || controls.paused) return void reply(409, { error: "Analysis is paused" });
  if (req.method === "POST" && kind === "result") {
    const result = z.union([
      z.object({ analysis: analysisSchema }).strict(),
      z.object({ error: z.enum(["resource-limit", "decode-failed", "cancelled"]) }).strict(),
    ]).safeParse(await body(req));
    if (!result.success) return void reply(400, { error: "Invalid measured analysis result" });
    const errors = {
      "resource-limit": "Remote analysis exceeded resource limits; increase the analysis time/duration budget and retry",
      "decode-failed": "Remote audio analysis failed; inspect remote worker logs, check ffmpeg and retry",
      cancelled: "Remote analysis was interrupted; retry this track",
    };
    if ("analysis" in result.data) {
      if (!lease.filePath) return void reply(409, { error: "Analysis source unavailable" });
      const file = await confinedMedia(lease.filePath, [config.musicDir, config.existingMusicDir]);
      const source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (process.platform === "linux") await confinedMedia(await realpath(`/proc/self/fd/${source.fd}`), [config.musicDir, config.existingMusicDir]);
        const stat = await source.stat(), fingerprint = result.data.analysis.fingerprint;
        if (stat.size !== fingerprint.bytes || stat.mtimeMs !== fingerprint.mtimeMs) {
          await finishAnalysis(leaseId, null, "Audio changed during remote analysis; retry when the file is stable");
          return void reply(409, { error: "Source fingerprint changed" });
        }
      } finally { await source.close(); }
    }
    const saved = "analysis" in result.data ? await finishAnalysis(leaseId, result.data.analysis) :
      result.data.error === "cancelled" ? await releaseAnalysisLease(leaseId) : await finishAnalysis(leaseId, null, errors[result.data.error]);
    return void reply(saved.length ? 200 : 409, { accepted: Boolean(saved.length) });
  }
  if (req.method !== "GET" || kind !== "input" || !lease.filePath) return void reply(405, { error: "Unsupported analysis request" });
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
