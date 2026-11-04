import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { activePlaybackSession, type PlaybackClaim } from "@mint/core/playback";
import { config } from "./config";
import { log } from "./log";

const running = new Map<string, Promise<string>>();
const MAX_FILE = 512 * 1024 ** 2, MAX_CACHE = 2 * 1024 ** 3;
export function transcodeKey(trackId: string, file: { size: number; mtimeMs: number; ino: number }) {
  return createHash("sha256").update(`mp3-192-v1:${trackId}:${file.size}:${file.mtimeMs}:${file.ino}`).digest("hex");
}

async function prune(directory: string, keep: string) {
  const files = await readdir(directory);
  const entries = await Promise.all(files.filter((file) => /^[a-f0-9]{64}\.mp3$/.test(file)).map(async (file) => ({ file, ...await stat(path.join(directory, file)) })));
  let bytes = entries.reduce((sum, file) => sum + file.size, 0), count = entries.length;
  for (const file of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (bytes <= MAX_CACHE && count <= 32) break;
    if (file.file === keep) continue;
    await unlink(path.join(directory, file.file)); bytes -= file.size; count--;
  }
}

export async function compatibleAudio(trackId: string, input: FileHandle, claim: PlaybackClaim): Promise<string> {
  const info = await input.stat(), key = transcodeKey(trackId, info);
  const directory = path.join(config.stagingDir, "playback-cache"), file = `${key}.mp3`, destination = path.join(directory, file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const cached = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if ((await cached.stat()).size > 0) return destination; } finally { await cached.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const existing = running.get(key);
  if (existing) return existing;
  if (running.size >= 2) throw new Error("Compatibility conversion is busy. Wait for another song to finish, then retry.");
  const work = (async () => {
    const temporary = path.join(directory, `${key}-${randomUUID()}.tmp`);
    const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-threads", "1",
          "-i", process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3",
          "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-threads", "1", "-filter_threads", "1",
          "-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "pipe:4"],
        { stdio: ["ignore", "ignore", "pipe", input.fd, output.fd] });
        let stderr = "", failure: Error | undefined, checking = false;
        const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
        const timeout = setTimeout(() => stop(new Error("Compatibility conversion timed out after two minutes.")), 120_000);
        const check = setInterval(() => {
          if (checking) return;
          checking = true;
          void Promise.all([output.stat(), activePlaybackSession(claim.sessionHash, claim.userId)]).then(([file, session]) => {
            if (!session) stop(new Error("Playback membership revoked."));
            if (file.size > MAX_FILE) stop(new Error("Compatibility file exceeded its 512 MB limit."));
          }).catch((error: unknown) => stop(error instanceof Error ? error : new Error("Compatibility validation failed."))).finally(() => { checking = false; });
        }, 2000);
        child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
        child.on("error", (error) => { failure = error; });
        child.on("close", (code) => {
          clearTimeout(timeout); clearInterval(check);
          if (failure) reject(failure);
          else if (code !== 0) { log.warn({ trackId, code, stderr }, "compatibility conversion failed"); reject(new Error("The audio format could not convert. Check worker diagnostics.")); }
          else resolve();
        });
      });
      const after = await input.stat(), size = (await output.stat()).size;
      if (transcodeKey(trackId, after) !== key) throw new Error("The original changed during conversion. Retry.");
      if (!size || size > MAX_FILE) throw new Error("Compatibility conversion produced an invalid file size.");
      await output.sync(); await output.close();
      await rename(temporary, destination);
      await prune(directory, file);
      return destination;
    } finally {
      await output.close();
      try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn({ err: error }, "compatibility temporary cleanup failed"); }
    }
  })();
  running.set(key, work);
  try { return await work; } finally { running.delete(key); }
}
