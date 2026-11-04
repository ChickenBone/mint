import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { analysisControlsSchema } from "@mint/core/analysis";
import { analyzeAudio } from "./analysis-engine";

const leaseSchema = z.object({ lease: z.object({ trackId: z.uuid(), leaseId: z.uuid(), controls: analysisControlsSchema }).nullable() });

export async function runRemoteAnalysis(options: { server: string; token: string; cacheDir: string; signal: AbortSignal; once?: boolean; workerId?: string }) {
  const base = new URL(options.server);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Analysis server must be an HTTP(S) URL without embedded credentials");
  if (options.token.length < 32) throw new Error("ANALYSIS_WORKER_TOKEN must be at least 32 characters");
  await mkdir(options.cacheDir, { recursive: true, mode: 0o700 });
  const workerId = options.workerId ?? `analysis-${randomUUID()}`;
  const request = async (endpoint: string, init: RequestInit = {}) => {
    const response = await fetch(new URL(endpoint, base), { ...init, redirect: "error",
      signal: init.signal ?? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
      headers: { authorization: `Bearer ${options.token}`, "x-mint-worker-id": workerId, ...init.headers } });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Analysis server returned HTTP ${response.status}`); }
    return response;
  };
  while (!options.signal.aborted) {
    const response = await request("/analysis/lease", { method: "POST" });
    const text = await response.text();
    if (text.length > 8192) throw new Error("Analysis lease response too large");
    const { lease } = leaseSchema.parse(JSON.parse(text));
    if (!lease) { if (options.once) return; await sleep(5000, undefined, { signal: options.signal }); continue; }
    const file = path.join(path.resolve(options.cacheDir), `${lease.leaseId}.audio`);
    const controller = new AbortController(), signal = AbortSignal.any([options.signal, controller.signal, AbortSignal.timeout((lease.controls.timeoutSec + 60) * 1000)]);
    const poll = setInterval(() => {
      void request(`/analysis/lease/${lease.leaseId}`, { signal }).then(async (reply) => {
        const status = await reply.json() as { active?: boolean };
        if (status.active !== true) controller.abort();
      }).catch(() => controller.abort());
    }, 2000);
    let result: Awaited<ReturnType<typeof analyzeAudio>> | null = null, failure: "resource-limit" | "decode-failed" | "cancelled" = "decode-failed";
    try {
      const media = await request(`/analysis/input/${lease.leaseId}`, { signal });
      if (!media.body) throw new Error("Analysis media unavailable");
      const sourceMtime = Number(media.headers.get("x-mint-analysis-mtime"));
      if (!Number.isFinite(sourceMtime) || sourceMtime < 0) throw new Error("Analysis source fingerprint is missing");
      let bytes = 0;
      const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 2 * 1024 ** 3 ? new Error("Analysis transfer exceeds resource limit") : null, chunk);
      } });
      await pipeline(Readable.fromWeb(media.body as never), limiter, createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal });
      result = await analyzeAudio(file, { ...lease.controls, signal });
      result.fingerprint.mtimeMs = sourceMtime;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Analysis failed";
      failure = signal.aborted ? "cancelled" : /limit|exceeds|exceeded/.test(message) ? "resource-limit" : "decode-failed";
      console.error("Remote analysis failed", lease.trackId, message);
    } finally { clearInterval(poll); await rm(file, { force: true }); }
    // Cancelled leases reject late results. The persistent lease expiry handles a dead network.
    if (!options.signal.aborted) {
      await request(`/analysis/result/${lease.leaseId}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(result ? { analysis: result } : { error: failure }),
      }).then((reply) => reply.body?.cancel()).catch((error) => console.error("Analysis result not accepted", error instanceof Error ? error.message : "Unknown failure"));
    }
    if (options.once) return;
    await sleep(Math.max(5, lease.controls.intervalSec) * 1000, undefined, { signal: options.signal });
  }
}

async function main() {
  const server = process.env.ANALYSIS_SERVER_URL, token = process.env.ANALYSIS_WORKER_TOKEN;
  if (!server || !token) throw new Error("ANALYSIS_SERVER_URL and a separate ANALYSIS_WORKER_TOKEN are required");
  const concurrency = Number(process.env.ANALYSIS_CONCURRENCY ?? "1");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("ANALYSIS_CONCURRENCY must be an integer from 1 to 4");
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  const workerId = `analysis-${randomUUID()}`;
  console.log(`Mint analysis worker starting with ${concurrency} slot(s); global admin limits still apply.`);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!controller.signal.aborted) {
      try { await runRemoteAnalysis({ server, token, workerId, cacheDir: process.env.ANALYSIS_CACHE_DIR ?? ".mint-analysis", signal: controller.signal }); }
      catch (error) {
        if (controller.signal.aborted) return;
        console.error("Analysis worker connection failed; check the private/VPN server URL and separate analysis token", error instanceof Error ? error.message : "Unknown failure");
        await sleep(10_000, undefined, { signal: controller.signal }).catch(() => undefined);
      }
    }
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "Analysis worker failed"); process.exitCode = 1; });
}
