import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ReadOnlyMediaFile } from "./index";

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;

const PROBE_ARGUMENTS = [
  "-v", "error",
  "-protocol_whitelist", "pipe",
  "-show_entries",
  "format=duration:format_tags=title,artist,album:stream=index,codec_type,codec_name,sample_rate,duration:stream_tags=title,artist,album",
  "-of", "json",
  "pipe:0",
] as const;

const DECODE_ARGUMENTS = [
  "-hide_banner",
  "-nostdin",
  "-v", "error",
  "-xerror",
  "-err_detect", "explode",
  "-threads", "1",
  "-filter_threads", "1",
  "-protocol_whitelist", "pipe",
  "-i", "pipe:0",
  "-map", "0:a:0",
  "-af", "asetnsamples=n=65536:p=0,astats=metadata=1:reset=0,ametadata=mode=print:key=lavfi.astats.Overall.Number_of_samples:file=pipe\\\\\\:1",
  "-map_metadata", "-1",
  "-vn",
  "-sn",
  "-dn",
  "-f", "null",
  "-",
] as const;

// Mapping every input stream in order preserves its input index in framehash headers.
// Drop packets so this fallback remains bounded independently of media duration.
const STREAM_ARGUMENTS = [
  "-hide_banner",
  "-nostdin",
  "-v", "error",
  "-protocol_whitelist", "pipe",
  "-i", "pipe:0",
  "-map", "0",
  "-c", "copy",
  "-bsf", "noise=drop=1",
  "-map_metadata", "-1",
  "-f", "framehash",
  "pipe:1",
] as const;

type ToolFailureCode =
  | "spawn-failed"
  | "process-failed"
  | "input-limit"
  | "output-limit"
  | "time-limit"
  | "cancelled"
  | "input-read-failed"
  | "incomplete-input"
  | "invalid-output";

export interface AudioProbeOptions {
  /** Absolute, operator-configured path to ffprobe. */
  readonly ffprobePath: string;
  /** Absolute, operator-configured path to ffmpeg. */
  readonly ffmpegPath: string;
  /** Maximum bytes supplied in the ffprobe pass; reaching the cap fails closed. */
  readonly maxProbeInputBytes: number;
  /** Maximum bytes supplied in the ffmpeg pass; reaching the cap fails closed. */
  readonly maxDecodeInputBytes: number;
  /** Maximum combined stdout and stderr bytes read per tool. */
  readonly maxOutputBytes: number;
  /** Wall-clock budget for the ffprobe pass, excluding caller-side close(). */
  readonly probeTimeoutMs: number;
  /** Wall-clock budget for the ffmpeg decode pass, excluding caller-side close(). */
  readonly decodeTimeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ImportedAudioMetadata {
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
}

export interface VerifiedAudioObservation {
  readonly streamIndex: number;
  readonly codec: string;
  readonly decodedSampleFrames: number;
  readonly durationMs?: number;
}

type ProbeStatus = { readonly status: "available" } | {
  readonly status: "unavailable";
  readonly reason: ToolFailureCode;
};

export type LibraryAudioProbeResult =
  | {
    readonly status: "verified";
    readonly availability: "available";
    readonly audioVerified: true;
    readonly checkedAt: Date;
    readonly probe: ProbeStatus;
    readonly audio: VerifiedAudioObservation;
    readonly tags: ImportedAudioMetadata;
  }
  | {
    readonly status: "not-audio";
    readonly availability: "unavailable";
    readonly audioVerified: false;
    readonly checkedAt: Date;
    readonly reason: "no-audio-stream";
  }
  | {
    readonly status: "unavailable";
    readonly availability: "unavailable";
    readonly audioVerified: false;
    readonly checkedAt: Date;
    readonly reason:
      | "resource-limit"
      | "time-limit"
      | "cancelled"
      | "input-read-failed"
      | "decode-failed"
      | "tool-infrastructure";
    readonly probe: ProbeStatus;
  };

interface ToolRunResult {
  readonly failure?: ToolFailureCode;
  readonly exitCode: number | null;
  readonly output: Buffer;
  readonly reachedEof: boolean;
  readonly decodedSampleFrames?: number;
}

interface ParsedProbe {
  readonly hasAudio: boolean;
  readonly streamIndex: number | null;
  readonly codec: string | null;
  readonly sampleRateHz?: number;
  readonly durationMs?: number;
  readonly tags: ImportedAudioMetadata;
}

export class AudioProbeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioProbeConfigurationError";
  }
}

function isBoundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validateOptions(options: AudioProbeOptions): void {
  for (const executablePath of [options.ffprobePath, options.ffmpegPath]) {
    if (
      typeof executablePath !== "string"
      || executablePath.length > 4096
      || executablePath.includes("\0")
      || !executablePath.startsWith("/")
    ) {
      throw new AudioProbeConfigurationError("Media tool paths must be absolute filesystem paths");
    }
  }
  if (
    !isBoundedInteger(options.maxProbeInputBytes, MAX_INPUT_BYTES)
    || !isBoundedInteger(options.maxDecodeInputBytes, MAX_INPUT_BYTES)
  ) {
    throw new AudioProbeConfigurationError("Media input budgets are outside supported bounds");
  }
  if (!isBoundedInteger(options.maxOutputBytes, MAX_OUTPUT_BYTES)) {
    throw new AudioProbeConfigurationError("Media output budget is outside supported bounds");
  }
  if (
    !isBoundedInteger(options.probeTimeoutMs, MAX_TIMEOUT_MS)
    || !isBoundedInteger(options.decodeTimeoutMs, MAX_TIMEOUT_MS)
  ) {
    throw new AudioProbeConfigurationError("Media tool time budgets are outside supported bounds");
  }
}

function killOwnedProcess(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function runTool(
  executablePath: string,
  arguments_: readonly string[],
  mediaFile: ReadOnlyMediaFile,
  maxInputBytes: number,
  maxOutputBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
  measureDecodedSampleFrames = false,
): Promise<ToolRunResult> {
  if (signal?.aborted) {
    return { failure: "cancelled", exitCode: null, output: Buffer.alloc(0), reachedEof: false };
  }

  let child: ChildProcess;
  try {
    child = spawn(executablePath, [...arguments_], {
      detached: true,
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin", NODE_ENV: "production" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return { failure: "spawn-failed", exitCode: null, output: Buffer.alloc(0), reachedEof: false };
  }

  let failure: ToolFailureCode | undefined;
  let processClosed = false;
  let reachedEof = false;
  let outputBytes = 0;
  let decodedSampleFrames = 0;
  let sampleCountSeen = false;
  let stdoutRemainder = "";
  const stdoutChunks: Buffer[] = [];

  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, closeSignal) => {
      processClosed = true;
      resolve({ code, signal: closeSignal });
    });
  });

  const stop = (reason: ToolFailureCode) => {
    if (failure || processClosed) return;
    failure = reason;
    killOwnedProcess(child);
  };

  const countOutput = (chunk: Buffer, isStdout: boolean) => {
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      stop("output-limit");
      return;
    }
    if (isStdout && !measureDecodedSampleFrames) {
      stdoutChunks.push(Buffer.from(chunk));
      return;
    }
    if (isStdout && measureDecodedSampleFrames) {
      stdoutRemainder += chunk.toString("utf8");
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^lavfi\.astats\.Overall\.Number_of_samples=(\d+)(?:\.0+)?$/.exec(line);
        if (!match) continue;
        const count = Number(match[1]);
        if (!Number.isSafeInteger(count) || count < 0) {
          stop("invalid-output");
          return;
        }
        decodedSampleFrames = Math.max(decodedSampleFrames, count);
        sampleCountSeen = true;
      }
      if (stdoutRemainder.length > 4096) stop("invalid-output");
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => countOutput(chunk, true));
  child.stderr?.on("data", (chunk: Buffer) => countOutput(chunk, false));
  child.once("error", () => stop("spawn-failed"));
  child.stdin?.on("error", () => {
    if (!processClosed && !failure) stop("input-read-failed");
  });

  const onAbort = () => stop("cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("time-limit"), timeoutMs);

  const pump = async () => {
    if (!child.stdin) {
      stop("spawn-failed");
      return;
    }
    let position = 0;
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    try {
      while (!processClosed && !failure) {
        const remaining = maxInputBytes - position;
        if (remaining <= 0) {
          stop("input-limit");
          return;
        }
        const requested = Math.min(buffer.length, remaining);
        const { bytesRead } = await mediaFile.read(buffer, 0, requested, position);
        if (processClosed || failure) return;
        if (bytesRead < 0 || bytesRead > requested) {
          stop("input-read-failed");
          return;
        }
        if (bytesRead === 0) {
          reachedEof = true;
          child.stdin.end();
          return;
        }
        position += bytesRead;
        if (!child.stdin.write(Buffer.from(buffer.subarray(0, bytesRead)))) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              child.stdin?.removeListener("drain", finish);
              child.removeListener("close", finish);
              resolve();
            };
            child.stdin?.once("drain", finish);
            child.once("close", finish);
          });
        }
        if (position >= maxInputBytes && !reachedEof) {
          stop("input-limit");
          return;
        }
      }
    } catch {
      if (!processClosed && !failure) stop("input-read-failed");
    }
  };

  const pumpPromise = pump();
  const closed = await closePromise;
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  await pumpPromise;
  if (measureDecodedSampleFrames && stdoutRemainder) failure ??= "invalid-output";

  if (failure) {
    return { failure, exitCode: closed.code, output: Buffer.concat(stdoutChunks), reachedEof };
  }
  if (closed.code !== 0 || closed.signal !== null) {
    return {
      failure: "process-failed",
      exitCode: closed.code,
      output: Buffer.concat(stdoutChunks),
      reachedEof,
    };
  }
  if (!reachedEof) {
    return {
      failure: "incomplete-input",
      exitCode: closed.code,
      output: Buffer.concat(stdoutChunks),
      reachedEof,
    };
  }
  if (measureDecodedSampleFrames && (!sampleCountSeen || decodedSampleFrames === 0)) {
    return {
      failure: "invalid-output",
      exitCode: closed.code,
      output: Buffer.concat(stdoutChunks),
      reachedEof,
    };
  }
  return {
    exitCode: closed.code,
    output: Buffer.concat(stdoutChunks),
    reachedEof,
    ...(measureDecodedSampleFrames ? { decodedSampleFrames } : {}),
  };
}

function safeTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (
    !cleaned
    || cleaned.length > 512
    || /(?:[a-z][a-z0-9+.-]*:\/\/|(?:^|[\s=(])\/[^/\s]|^[a-z]:[\\/])/i.test(cleaned)
    || /^Bearer\s+/i.test(cleaned)
    || /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(cleaned)
    || /^(?:gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9_-]{16,}$/i.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

function safeDuration(value: unknown): number | null {
  const duration = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function safeCodec(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : null;
}

function safeSampleRate(value: unknown): number | undefined {
  const rate = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(rate) && rate > 0 ? rate : undefined;
}

function parseStreamHeaders(output: Buffer): Pick<ParsedProbe, "streamIndex" | "codec" | "sampleRateHz"> | null {
  const streams = new Map<number, { type?: string; codec?: string; sampleRateHz?: number }>();
  for (const line of output.toString("utf8").split("\n")) {
    const match = /^#(media_type|codec_id|sample_rate) (\d+): ([^\r\n]+)$/.exec(line);
    if (!match) continue;
    const index = Number(match[2]);
    if (!Number.isSafeInteger(index) || index < 0) return null;
    const stream = streams.get(index) ?? {};
    if (match[1] === "media_type") {
      if (stream.type !== undefined) return null;
      stream.type = match[3];
    } else if (match[1] === "codec_id") {
      if (stream.codec !== undefined) return null;
      stream.codec = safeCodec(match[3]) ?? undefined;
    } else {
      if (stream.sampleRateHz !== undefined) return null;
      stream.sampleRateHz = safeSampleRate(match[3]);
    }
    streams.set(index, stream);
  }
  const ordered = [...streams.entries()].sort(([a], [b]) => a - b);
  if (ordered.some(([index, stream], position) => index !== position || !stream.type)) return null;
  const audio = ordered.find(([, stream]) => stream.type === "audio");
  if (!audio || !audio[1].codec) return null;
  return {
    streamIndex: audio[0],
    codec: audio[1].codec,
    sampleRateHz: audio[1].sampleRateHz,
  };
}

function readTags(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>);
  return Object.fromEntries(entries.map(([key, tag]) => [key.toLowerCase(), tag]));
}

function parseProbe(output: Buffer): ParsedProbe | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const result = parsed as Record<string, unknown>;
  if (!Array.isArray(result.streams)) return null;

  const streams = result.streams.filter(
    (stream): stream is Record<string, unknown> =>
      Boolean(stream) && typeof stream === "object" && !Array.isArray(stream),
  );
  const audioStream = streams.find((stream) => stream.codec_type === "audio");
  if (!audioStream) {
    return {
      hasAudio: false,
      streamIndex: null,
      codec: null,
      tags: emptyMetadata(),
    };
  }

  const format = result.format && typeof result.format === "object" && !Array.isArray(result.format)
    ? result.format as Record<string, unknown>
    : {};
  const formatTags = readTags(format.tags);
  const streamTags = readTags(audioStream.tags);
  const getTag = (key: string) => safeTag(formatTags[key] ?? streamTags[key]);
  const duration = safeDuration(format.duration) ?? safeDuration(audioStream.duration);
  const durationMs = duration === null ? null : Math.round(duration * 1000);
  return {
    hasAudio: true,
    streamIndex: typeof audioStream.index === "number"
      && Number.isSafeInteger(audioStream.index)
      && audioStream.index >= 0
      ? audioStream.index
      : null,
    codec: safeCodec(audioStream.codec_name),
    sampleRateHz: safeSampleRate(audioStream.sample_rate),
    ...(durationMs !== null && Number.isSafeInteger(durationMs) && durationMs > 0
      ? { durationMs }
      : {}),
    tags: {
      title: getTag("title"),
      artist: getTag("artist"),
      album: getTag("album"),
    },
  };
}

function emptyMetadata(): ImportedAudioMetadata {
  return { title: null, artist: null, album: null };
}

function unavailableFromDecodeFailure(
  failure: ToolFailureCode,
  probe: ProbeStatus,
): Extract<LibraryAudioProbeResult, { status: "unavailable" }> {
  const reason = failure === "input-limit" || failure === "output-limit"
    ? "resource-limit"
    : failure === "time-limit"
      ? "time-limit"
      : failure === "cancelled"
        ? "cancelled"
        : failure === "input-read-failed"
          ? "input-read-failed"
          : failure === "spawn-failed"
            ? "tool-infrastructure"
            : "decode-failed";
  return {
    status: "unavailable",
    availability: "unavailable",
    audioVerified: false,
    checkedAt: new Date(),
    reason,
    probe,
  };
}

/**
 * Verifies audio by probing and fully decoding stdin. The caller retains ownership
 * of the confined read-only handle and must close it after this call.
 */
export async function verifyLibraryAudio(
  mediaFile: ReadOnlyMediaFile,
  options: AudioProbeOptions,
): Promise<LibraryAudioProbeResult> {
  validateOptions(options);

  const probeRun = await runTool(
    options.ffprobePath,
    PROBE_ARGUMENTS,
    mediaFile,
    options.maxProbeInputBytes,
    options.maxOutputBytes,
    options.probeTimeoutMs,
    options.signal,
  );
  const parsedProbe = !probeRun.failure && probeRun.exitCode === 0
    ? parseProbe(probeRun.output)
    : null;
  const probeFailure = probeRun.failure ?? (parsedProbe ? undefined : "invalid-output");
  const probeStatus: ProbeStatus = probeFailure
    ? { status: "unavailable", reason: probeFailure }
    : { status: "available" };

  if (parsedProbe && !parsedProbe.hasAudio && probeRun.reachedEof) {
    return {
      status: "not-audio",
      availability: "unavailable",
      audioVerified: false,
      checkedAt: new Date(),
      reason: "no-audio-stream",
    };
  }

  if (options.signal?.aborted) {
    return unavailableFromDecodeFailure("cancelled", probeFailure
      ? probeStatus
      : { status: "unavailable", reason: "cancelled" });
  }

  const decodeRun = await runTool(
    options.ffmpegPath,
    DECODE_ARGUMENTS,
    mediaFile,
    options.maxDecodeInputBytes,
    options.maxOutputBytes,
    options.decodeTimeoutMs,
    options.signal,
    true,
  );
  if (decodeRun.failure) {
    return unavailableFromDecodeFailure(decodeRun.failure, probeStatus);
  }
  if (decodeRun.exitCode !== 0) {
    return unavailableFromDecodeFailure("process-failed", probeStatus);
  }
  let stream = parsedProbe?.hasAudio && parsedProbe.streamIndex !== null && parsedProbe.codec
    ? parsedProbe
    : null;
  if (!stream) {
    const streamRun = await runTool(
      options.ffmpegPath,
      STREAM_ARGUMENTS,
      mediaFile,
      options.maxDecodeInputBytes,
      options.maxOutputBytes,
      options.decodeTimeoutMs,
      options.signal,
    );
    if (streamRun.failure) return unavailableFromDecodeFailure(streamRun.failure, probeStatus);
    const headers = parseStreamHeaders(streamRun.output);
    if (headers) {
      stream = { hasAudio: true, ...headers, tags: emptyMetadata() };
    }
  }
  if (decodeRun.decodedSampleFrames === undefined || !stream || stream.streamIndex === null || !stream.codec) {
    return unavailableFromDecodeFailure("invalid-output", probeStatus);
  }

  const durationMs = parsedProbe?.durationMs ?? (
    stream.sampleRateHz
      ? Math.round(decodeRun.decodedSampleFrames * 1000 / stream.sampleRateHz)
      : undefined
  );
  return {
    status: "verified",
    availability: "available",
    audioVerified: true,
    checkedAt: new Date(),
    probe: probeStatus,
    audio: {
      streamIndex: stream.streamIndex,
      codec: stream.codec,
      decodedSampleFrames: decodeRun.decodedSampleFrames,
      ...(durationMs !== undefined && Number.isSafeInteger(durationMs) && durationMs > 0
        ? { durationMs }
        : {}),
    },
    tags: parsedProbe?.hasAudio ? parsedProbe.tags : emptyMetadata(),
  };
}
