import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { setPriority } from "node:os";
import { ANALYSIS_ALGORITHM, ANALYSIS_VERSION, analysisSchema, type TrackAnalysis } from "@mint/core/analysis";
import { MultichannelDescriptors, SAMPLE_RATE } from "./analysis-dsp";

interface Limits { maxDurationSec: number; timeoutSec: number; signal?: AbortSignal; maxBytes?: number; verifyOpened?: (fd: number) => Promise<void> }
export interface AudioInput { path: string; fd?: number }
const input = (source: AudioInput) => source.fd !== undefined && process.platform === "linux" ? "/proc/self/fd/3" : source.path;

export function audioProcess(command: string, args: string[], source: AudioInput, limits: Limits, onData?: (chunk: Buffer) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: source.fd !== undefined ? ["ignore", "pipe", "pipe", source.fd] : ["ignore", "pipe", "pipe"] });
    if (child.pid && process.platform !== "win32") {
      try { setPriority(child.pid, 10); } catch { /* Container CPU limits remain the hard resource boundary. */ }
    }
    let error: Error | undefined, output = "", stderr = "", bytes = 0, settled = false;
    const stop = (reason: Error) => { error ??= reason; child.kill("SIGKILL"); };
    const abort = () => stop(new Error("Analysis cancelled"));
    const timer = setTimeout(() => stop(new Error(`Audio subprocess exceeded ${limits.timeoutSec}s time limit`)), limits.timeoutSec * 1000);
    limits.signal?.addEventListener("abort", abort, { once: true });
    if (limits.signal?.aborted) abort();
    child.stdout!.on("data", (chunk: Buffer) => {
      if (error) return;
      try {
        if (onData) onData(chunk);
        else {
          bytes += chunk.length;
          if (bytes > 1_000_000) throw new Error("Audio probe output exceeded limit");
          output += chunk.toString("utf8");
        }
      } catch (reason) { stop(reason instanceof Error ? reason : new Error("Audio analysis failed")); }
    });
    let errorBytes = 0;
    child.stderr!.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
      if (errorBytes > 8_000_000) stop(new Error("Audio subprocess diagnostic output exceeded limit"));
    });
    const finish = (failure?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      limits.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve(onData ? stderr : output);
    };
    child.once("error", (reason) => finish(reason));
    child.once("close", (code) => {
      const failure = code === 0 ? undefined : Object.assign(
        new Error(`Audio decoder exited ${code}; verify the media format and worker ffmpeg installation`),
        { diagnostics: stderr.slice(-2000) },
      );
      finish(error ?? failure);
    });
  });
}

export function parseLoudness(log: string): { integratedLufs: number | null; truePeakDbtp: number | null; lraLu?: number | null; shortTermMaxLufs?: number | null } {
  const summaryIdx = log.lastIndexOf("Summary:");
  const summary = summaryIdx >= 0 ? log.slice(summaryIdx) : log;
  const integrated = /I:\s*(-?[\d.]+)\s*LUFS/.exec(summary);
  const truePeak = /True peak:[\s\S]*?Peak:\s*(-?[\d.]+)\s*dBFS/.exec(summary);
  const lra = /LRA:\s*(-?[\d.]+)\s*LU/.exec(summary);
  const integratedLufs = integrated ? Number(integrated[1]) : null;
  const truePeakDbtp = truePeak ? Number(truePeak[1]) : null;
  const lraLu = lra ? Number(lra[1]) : undefined;
  let shortTermMax: number | undefined;
  for (const match of log.matchAll(/\bS:\s*(-?[\d.]+)/g)) {
    const val = Number(match[1]);
    if (Number.isFinite(val) && val > -70 && (shortTermMax === undefined || val > shortTermMax)) shortTermMax = val;
  }
  // ebur128 reports -70 LUFS for digital silence; that is its gating floor, not a measurement.
  return {
    integratedLufs: integratedLufs !== null && integratedLufs > -70 ? integratedLufs : null,
    truePeakDbtp,
    ...(lraLu !== undefined && Number.isFinite(lraLu) && lraLu >= 0 ? { lraLu } : {}),
    ...(shortTermMax !== undefined ? { shortTermMaxLufs: Math.round(shortTermMax * 100) / 100 } : {}),
  };
}

function resolveAnalysisEngineName() {
  const modelDir = process.env.ANALYSIS_MODEL_DIR?.trim();
  if (modelDir && existsSync(modelDir)) {
    try {
      const hasModel = readdirSync(modelDir).some((entry) => entry.endsWith(".onnx") || entry.endsWith(".pb") || entry.endsWith(".json"));
      if (hasModel) return "ffmpeg+mint-dsp-v2+model";
    } catch { /* fallback to deterministic DSP */ }
  }
  return "ffmpeg+mint-dsp-v2";
}

export async function analyzeAudio(file: string, limits: Limits): Promise<TrackAnalysis> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const controller = new AbortController();
  const abort = () => controller.abort();
  limits.signal?.addEventListener("abort", abort, { once: true });
  if (limits.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, limits.timeoutSec * 1000);
  try {
    await limits.verifyOpened?.(handle.fd);
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size) throw new Error("Analysis requires a nonempty regular audio file");
    if (stat.size > (limits.maxBytes ?? 2 * 1024 ** 3)) throw new Error("Audio file exceeds 2 GiB analysis limit");
    const source = { path: file, fd: handle.fd }, bounded = { ...limits, signal: controller.signal };
    const probe = JSON.parse(await audioProcess(process.env.FFPROBE_PATH ?? "ffprobe", [
      "-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-select_streams", "a:0",
      "-show_entries", "format=duration:stream=codec_name,duration,channels", "-of", "json", input(source),
    ], source, bounded)) as { format?: { duration?: string }; streams?: { duration?: string; codec_name?: string; channels?: number }[] };
    const duration = Number(probe.format?.duration ?? probe.streams?.[0]?.duration);
    if (!probe.streams?.length || !Number.isFinite(duration) || duration <= 0) throw new Error("Audio duration is unavailable; repair its container before retrying analysis");
    if (duration > limits.maxDurationSec) throw new Error(`Track exceeds analysis duration limit (${limits.maxDurationSec}s)`);
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false, start: 0, signal: controller.signal });
    for await (const chunk of stream) hash.update(chunk);
    const descriptors = new MultichannelDescriptors(probe.streams[0]!.channels ?? 1, duration, limits.maxDurationSec);
    const log = await audioProcess(process.env.FFMPEG_PATH ?? "ffmpeg", [
      "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-threads", "1",
      "-filter_threads", "1", "-filter_complex_threads", "1", "-max_alloc", "67108864",
      "-protocol_whitelist", "file,pipe", "-i", input(source),
      "-filter_complex", `[0:a:0]asplit=2[a][b];[a]ebur128=peak=true:framelog=verbose[l];[b]aresample=${SAMPLE_RATE},aformat=sample_fmts=flt[p]`,
      "-map", "[l]", "-t", String(limits.maxDurationSec + 1), "-f", "null", "-",
      "-map", "[p]", "-t", String(limits.maxDurationSec + 1), "-f", "f32le", "pipe:1",
    ], source, bounded, (chunk) => descriptors.push(chunk));
    const after = await handle.stat();
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("Audio changed during analysis; retry when the file is stable");
    const measured = descriptors.finish();
    const loudness = parseLoudness(log);
    const engine = resolveAnalysisEngineName();
    return analysisSchema.parse({
      version: ANALYSIS_VERSION, algorithm: ANALYSIS_ALGORITHM,
      fingerprint: { sha256: hash.digest("hex"), bytes: stat.size, mtimeMs: stat.mtimeMs },
      measuredAt: new Date().toISOString(), ...measured,
      integratedLufs: loudness.integratedLufs,
      truePeakDbtp: loudness.truePeakDbtp,
      lraLu: loudness.lraLu ?? null,
      shortTermMaxLufs: loudness.shortTermMaxLufs ?? measured.shortTermMaxLufs ?? null,
      crestFactorDb: measured.crestFactorDb ?? null,
      provenance: { engine, sampleRate: SAMPLE_RATE, notes: [
        "Full-file SHA-256; EBU R128 integrated loudness, loudness range (LRA), short-term max, and oversampled true peak from ffmpeg.",
        `Silence threshold -60 dBFS; all-channel peak waveform, RMS energy, and MixRamp fade contours at ${SAMPLE_RATE} Hz.`,
        "Spectral/rhythm estimates use the strongest channel, avoiding phase-cancellation false silence.",
        "Tempo uses multi-band spectral flux onset autocorrelation with beatgrid phase alignment and stability scoring.",
        "Key uses harmonic-weighted HPCP correlation against Krumhansl-Kessler profiles with Camelot and Open Key notation.",
        "Timbre, 12-band Bark energy, 13 MFCCs, and genre/mood classification sample frames across intro, body, and outro.",
        ...(loudness.integratedLufs === null ? ["Integrated loudness unavailable or below EBU gating floor."] : []),
      ] },
    });
  } finally {
    clearTimeout(timer);
    limits.signal?.removeEventListener("abort", abort);
    await handle.close();
  }
}
