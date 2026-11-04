/**
 * mint-agent: a volunteer download worker.
 * Claims YouTube rips from the Mint web API, downloads audio through a local Cobalt,
 * and uploads the file to the home-server hub. Outbound HTTPS only; it never sees Plex,
 * Lidarr, TorBox, the database, or member accounts.
 */
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { connectionFailure, loopbackUrl, mintUrl } from "./connection";
import {
  AGENT_PROTOCOL_VERSION,
  type ClaimedJob,
  type FailRequest,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type ProgressRequest,
} from "@mint/core/agent-protocol";

declare const AGENT_VERSION: string;
const VERSION = typeof AGENT_VERSION === "string" ? AGENT_VERSION : "dev";

// ---------- config ----------

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    console.error(`[mint-agent] missing required environment variable ${name}`);
    process.exit(78);
  }
  return v;
}

const cfg = {
  url: mintUrl(env("MINT_URL", "https://mint.chickenbone.dev")),
  token: env("MINT_WORKER_TOKEN"),
  cobalt: env("COBALT_URL", "http://cobalt:9000").replace(/\/$/, ""),
  cobaltKey: process.env.COBALT_API_KEY,
  audioFormat: process.env.COBALT_AUDIO_FORMAT || "best",
  audioBitrate: process.env.COBALT_AUDIO_BITRATE || "320",
  concurrency: Math.max(1, Math.min(4, Number(process.env.AGENT_CONCURRENCY ?? 2) || 2)),
  workDir: process.env.AGENT_WORK_DIR || "/work",
};

// ---------- logging ----------

type Level = "info" | "warn" | "error";
function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  (level === "error" ? console.error : console.log)(line);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
const jitter = (ms: number) => ms * (0.8 + Math.random() * 0.4);

// ---------- Mint API ----------

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

async function api<T>(route: string, body: unknown): Promise<T | null> {
  const res = await fetch(`${cfg.url}/api/agent/v1${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", "user-agent": `mint-agent/${VERSION}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* not JSON */
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ApiError(res.status, message || `HTTP ${res.status}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
  }
  return (await res.json()) as T;
}

// ---------- state ----------

const state = {
  status: "unknown" as HeartbeatResponse["worker"]["status"] | "unknown" | "rejected",
  name: "",
  pollMs: 15_000,
  heartbeatMs: 30_000,
  active: new Map<string, { job: ClaimedJob; abort: AbortController }>(),
};
const shutdown = new AbortController();

async function heartbeat() {
  const body: HeartbeatRequest = {
    version: VERSION,
    protocol: AGENT_PROTOCOL_VERSION,
    activeJobs: state.active.size,
    capabilities: { cobalt: await cobaltReachable(), concurrency: cfg.concurrency },
  };
  try {
    const res = await api<HeartbeatResponse>("/heartbeat", body);
    if (!res) return;
    if (res.worker.status !== state.status) {
      const note = { active: "receiving jobs", pending: "connected; waiting for an admin to approve this worker", disabled: "disabled by an admin" }[res.worker.status];
      log(res.worker.status === "active" ? "info" : "warn", `worker "${res.worker.name}" ${note}`);
    }
    state.status = res.worker.status;
    state.name = res.worker.name;
    state.pollMs = res.pollMs;
    state.heartbeatMs = res.heartbeatMs;
    await fs.writeFile(path.join(cfg.workDir, ".heartbeat"), new Date().toISOString()).catch(() => undefined);
  } catch (err) {
    if (err instanceof ApiError && err.status === 426) {
      log("error", err.message);
      process.exit(1);
    }
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      if (state.status !== "rejected") log("error", `Mint rejected this worker: ${err.message}. Check MINT_WORKER_TOKEN or create a new token.`);
      state.status = "rejected";
      return;
    }
    log("warn", "heartbeat failed; check MINT_URL, DNS and outbound HTTPS access", { mint: cfg.url, ...connectionFailure(err) });
  }
}

async function heartbeatLoop() {
  while (!shutdown.signal.aborted) {
    await heartbeat();
    await sleep(state.status === "rejected" ? 5 * 60_000 : jitter(state.heartbeatMs), shutdown.signal);
  }
}

// ---------- Cobalt ----------

let cobaltOk: { at: number; ok: boolean } | null = null;
async function cobaltReachable() {
  if (cobaltOk && Date.now() - cobaltOk.at < 60_000) return cobaltOk.ok;
  const ok = await fetch(`${cfg.cobalt}/`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (cobaltOk && cobaltOk.ok !== ok) log(ok ? "info" : "warn", ok ? "Cobalt is reachable again" : `Cobalt at ${cfg.cobalt} is not reachable`);
  cobaltOk = { at: Date.now(), ok };
  return ok;
}

type CobaltResponse =
  | { status: "tunnel" | "redirect"; url: string; filename: string }
  | { status: "error"; error: { code: string } }
  | { status: string };

async function cobaltAudio(videoId: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(`${cfg.cobalt}/`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(cfg.cobaltKey ? { authorization: `Api-Key ${cfg.cobaltKey}` } : {}),
    },
    body: JSON.stringify({
      url: `https://music.youtube.com/watch?v=${videoId}`,
      downloadMode: "audio",
      audioFormat: cfg.audioFormat,
      audioBitrate: cfg.audioBitrate,
      filenameStyle: "basic",
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  const data = (await res.json().catch(() => ({ status: "error", error: { code: `http ${res.status}` } }))) as CobaltResponse;
  if ((data.status === "tunnel" || data.status === "redirect") && "url" in data) return data.url;
  if (data.status === "error" && "error" in data) throw new Error(`Cobalt: ${data.error.code}`);
  throw new Error(`Cobalt returned an unsupported response (${data.status})`);
}

// ---------- job ----------

function meter(onBytes: (n: number) => void) {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      onBytes(n);
      cb(null, chunk);
    },
  });
}

/** Throttled progress reporter; aborts the job if Mint says the lease is gone. */
function reporter(job: ClaimedJob, abort: AbortController) {
  let last = 0;
  let inflight = false;
  return (phase: ProgressRequest["phase"], progress: number | null, force = false) => {
    const now = Date.now();
    if (inflight || (!force && now - last < 3000)) return;
    last = now;
    inflight = true;
    const body: ProgressRequest = { leaseId: job.leaseId, phase, progress };
    api("/jobs/" + job.trackId + "/progress", body)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 409) abort.abort(new Error("lease lost"));
      })
      .finally(() => (inflight = false));
  };
}

async function download(job: ClaimedJob, dest: string, abort: AbortController, report: ReturnType<typeof reporter>) {
  const url = await cobaltAudio(job.youtubeVideoId, abort.signal);
  const res = await fetch(url, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60 * 60_000)]) });
  if (!res.ok || !res.body) throw new Error(`audio stream returned HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (total > job.upload.maxBytes) throw new Error("audio is larger than the upload limit");
  await pipeline(
    Readable.fromWeb(res.body as never),
    meter((n) => {
      if (n > job.upload.maxBytes) abort.abort(new Error("audio is larger than the upload limit"));
      report("downloading", total ? n / total : null);
    }),
    createWriteStream(dest),
    { signal: abort.signal },
  );
}

async function upload(job: ClaimedJob, file: string, abort: AbortController, report: ReturnType<typeof reporter>) {
  const { size } = await fs.stat(file);
  for (let attempt = 1; ; attempt++) {
    report("uploading", 0, true);
    const body = Readable.toWeb(createReadStream(file).pipe(meter((n) => report("uploading", n / size)))) as ReadableStream;
    const res = await fetch(job.upload.url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${job.upload.token}`,
        "content-type": "application/octet-stream",
        "content-length": String(size),
        "user-agent": `mint-agent/${VERSION}`,
      },
      body,
      duplex: "half",
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60 * 60_000)]),
    } as RequestInit & { duplex: "half" });
    if (res.status === 201) return;
    const reason = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
    if (res.status === 409) throw Object.assign(new Error(`hub: ${reason}`), { leaseLost: true });
    if ((res.status === 503 || res.status >= 500) && attempt < 4) {
      const wait = (Number(res.headers.get("retry-after")) || 15) * 1000 * attempt;
      log("warn", "hub busy, retrying upload", { trackId: job.trackId, attempt, waitMs: wait });
      await sleep(wait, abort.signal);
      continue;
    }
    throw new Error(`hub rejected upload: ${reason}`);
  }
}

async function runJob(job: ClaimedJob) {
  const abort = new AbortController();
  const onShutdown = () => abort.abort(new Error("shutting down"));
  shutdown.signal.addEventListener("abort", onShutdown, { once: true });
  state.active.set(job.trackId, { job, abort });
  const file = path.join(cfg.workDir, `${job.trackId}.${job.leaseId}.audio`);
  const report = reporter(job, abort);
  const started = Date.now();
  log("info", "claimed", { trackId: job.trackId, artist: job.artist, title: job.title });
  try {
    report("downloading", 0, true);
    await download(job, file, abort, report);
    await upload(job, file, abort, report);
    log("info", "delivered", { trackId: job.trackId, title: job.title, seconds: Math.round((Date.now() - started) / 1000) });
  } catch (err) {
    const reason = abort.signal.reason instanceof Error ? abort.signal.reason.message : (err as Error).message;
    const leaseLost = reason === "lease lost" || (err as { leaseLost?: boolean }).leaseLost;
    if (leaseLost) {
      log("warn", "job was reassigned; dropping it", { trackId: job.trackId });
    } else {
      const release = shutdown.signal.aborted;
      log(release ? "info" : "warn", release ? "releasing job for shutdown" : "job failed", { trackId: job.trackId, error: reason });
      const body: FailRequest = { leaseId: job.leaseId, error: reason.slice(0, 480), release };
      await api(`/jobs/${job.trackId}/fail`, body).catch((e) => log("warn", "could not report failure", { error: (e as Error).message }));
    }
  } finally {
    shutdown.signal.removeEventListener("abort", onShutdown);
    state.active.delete(job.trackId);
    await fs.unlink(file).catch(() => undefined);
  }
}

async function slot(id: number) {
  let idle = 0;
  while (!shutdown.signal.aborted) {
    if (state.status !== "active" || !(await cobaltReachable())) {
      await sleep(jitter(15_000), shutdown.signal);
      continue;
    }
    try {
      const res = await api<{ job: ClaimedJob }>("/claim", {});
      if (!res) {
        idle = Math.min(idle + 1, 4);
        await sleep(jitter(state.pollMs * idle), shutdown.signal);
        continue;
      }
      idle = 0;
      await runJob(res.job);
    } catch (err) {
      const wait = err instanceof ApiError && err.retryAfterMs ? err.retryAfterMs : 30_000;
      if (err instanceof ApiError && err.status === 403) state.status = "pending";
      log("warn", "claim failed", { slot: id, error: (err as Error).message });
      await sleep(jitter(wait), shutdown.signal);
    }
  }
}

// ---------- main ----------

async function main() {
  await fs.mkdir(cfg.workDir, { recursive: true });
  // Leftovers from a crash are useless: their leases have been or will be reclaimed.
  for (const f of await fs.readdir(cfg.workDir)) if (f.endsWith(".audio")) await fs.unlink(path.join(cfg.workDir, f)).catch(() => undefined);

  log("info", `mint-agent ${VERSION} starting`, { mint: cfg.url, cobalt: cfg.cobalt, concurrency: cfg.concurrency });
  if (loopbackUrl(cfg.url)) log("warn", "MINT_URL points to this container. For a remote worker, set MINT_URL to your public Mint HTTPS origin in Compose environment.");
  await heartbeat();
  const loops = [heartbeatLoop(), ...Array.from({ length: cfg.concurrency }, (_, i) => slot(i))];

  const stop = async (signal: string) => {
    if (shutdown.signal.aborted) return;
    log("info", `received ${signal}, returning ${state.active.size} job(s) to the pool`);
    shutdown.abort();
    const deadline = setTimeout(() => process.exit(0), 8_000);
    await Promise.allSettled(loops);
    clearTimeout(deadline);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((err) => {
  log("error", "agent crashed", { error: (err as Error).stack ?? String(err) });
  process.exit(1);
});
