import { spawn } from "node:child_process";
import path from "node:path";
import { ensureDir } from "./files";
import { codecQuality } from "./library-policy";

function run(cmd: string, args: string[], timeoutMs = 10 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`));
    });
  });
}

export interface Probe {
  durationSec: number | null;
  codec: string | null;
}

export async function probe(file: string): Promise<Probe> {
  const out = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-select_streams", "a:0", file], 60_000);
  const json = JSON.parse(out) as { format?: { duration?: string }; streams?: Array<{ codec_name?: string }> };
  const d = Number(json.format?.duration);
  return { durationSec: Number.isFinite(d) ? Math.round(d) : null, codec: json.streams?.[0]?.codec_name ?? null };
}

export async function probePlayableAudio(file: string): Promise<Probe> {
  const info = await probe(file);
  if (!info.codec) throw new Error("No audio stream found");
  return info;
}

const CONTAINER: Record<string, { ext: string; embedsArt: boolean }> = {
  opus: { ext: "opus", embedsArt: false },
  vorbis: { ext: "ogg", embedsArt: false },
  aac: { ext: "m4a", embedsArt: true },
  alac: { ext: "m4a", embedsArt: true },
  mp3: { ext: "mp3", embedsArt: true },
  flac: { ext: "flac", embedsArt: true },
};

export function containerFor(codec: string | null) {
  return CONTAINER[codec ?? ""] ?? (codecQuality(codec) === "lossless"
    ? { ext: "flac", embedsArt: true, transcodeLossless: true }
    : { ext: "m4a", embedsArt: true, transcode: true });
}

export interface TagMeta {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  year?: number | null;
  mbRecordingId?: string | null;
  mbReleaseGroupId?: string | null;
  mbArtistId?: string | null;
  youtubeVideoId: string;
}

/** Remuxes (or, for unknown codecs, transcodes to AAC) into a Plex-friendly container with tags and optional cover. */
export async function tagInto(src: string, destNoExt: string, meta: TagMeta, coverJpg: string | null): Promise<string> {
  const { codec } = await probe(src);
  const c = containerFor(codec);
  const dest = `${destNoExt}.${c.ext}`;
  await ensureDir(path.dirname(dest));
  const args = ["-y", "-v", "error", "-i", src];
  const withArt = Boolean(coverJpg && c.embedsArt);
  if (withArt) args.push("-i", coverJpg!);
  args.push("-map", "0:a:0");
  if (withArt) args.push("-map", "1:v:0", "-c:v", "mjpeg", "-disposition:v:0", "attached_pic");
  args.push("-c:a", "transcode" in c ? "aac" : "transcodeLossless" in c ? "flac" : "copy");
  if ("transcode" in c) args.push("-b:a", "256k");
  const tags: Record<string, string | undefined> = {
    title: meta.title,
    artist: meta.artist,
    album_artist: meta.albumArtist,
    album: meta.album,
    date: meta.year ? String(meta.year) : undefined,
    MUSICBRAINZ_TRACKID: meta.mbRecordingId ?? undefined,
    MUSICBRAINZ_RELEASEGROUPID: meta.mbReleaseGroupId ?? undefined,
    MUSICBRAINZ_ARTISTID: meta.mbArtistId ?? undefined,
    comment: `youtube:${meta.youtubeVideoId} via Mint`,
  };
  for (const [k, v] of Object.entries(tags)) if (v) args.push("-metadata", `${k}=${v}`);
  if (c.ext === "m4a") args.push("-movflags", "+faststart");
  args.push(`${dest}.tmp.${c.ext}`);
  await run("ffmpeg", args);
  const fs = await import("node:fs/promises");
  await fs.rename(`${dest}.tmp.${c.ext}`, dest);
  return dest;
}

/** Center-crops any image (URL or path) to a 600px square JPEG. */
export async function makeArtwork(input: string, dest: string) {
  await ensureDir(path.dirname(dest));
  await run("ffmpeg", [
    "-y", "-v", "error", "-i", input, "-frames:v", "1",
    "-vf", "crop='min(iw,ih)':'min(iw,ih)',scale=600:600:flags=lanczos", "-q:v", "3", `${dest}.tmp.jpg`,
  ], 60_000);
  const fs = await import("node:fs/promises");
  await fs.rename(`${dest}.tmp.jpg`, dest);
}
