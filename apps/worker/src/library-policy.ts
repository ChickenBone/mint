import path from "node:path";

const LOSSLESS = new Set(["flac", "alac", "wavpack", "ape", "tta", "truehd"]);
const LOSSY = new Set(["mp3", "aac", "opus", "vorbis", "mp2", "ac3", "eac3", "wma", "wmav2"]);
export function codecQuality(codec: string | null | undefined): "lossless" | "lossy" | "unknown" {
  const c = codec?.toLowerCase() ?? "";
  return LOSSLESS.has(c) || c.startsWith("pcm_") ? "lossless" : LOSSY.has(c) ? "lossy" : "unknown";
}

export function libraryMatchKey(artist: string, title: string) {
  const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `${normalize(artist)}|${normalize(title)}`;
}

export interface LibraryIdentity {
  title: string;
  artist: string;
  album: string | null;
  durationSec: number | null;
  codec: string | null;
}

export function sameRecording(a: LibraryIdentity, b: LibraryIdentity) {
  if (libraryMatchKey(a.artist, a.title) !== libraryMatchKey(b.artist, b.title)) return false;
  if (!a.durationSec || !b.durationSec || Math.abs(a.durationSec - b.durationSec) > 5) return false;
  if (a.album && b.album && a.album.trim().toLowerCase() !== b.album.trim().toLowerCase()) return false;
  return true;
}

export function isLosslessUpgrade(originalCodec: string | null, candidateCodec: string | null) {
  return codecQuality(originalCodec) === "lossy" && codecQuality(candidateCodec) === "lossless";
}

export function mapLibraryPath(file: string, plexRoot: string, localRoot: string) {
  const relative = path.posix.relative(plexRoot.replace(/\\/g, "/"), file.replace(/\\/g, "/"));
  if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error("Plex file is outside the configured existing library root");
  }
  return path.resolve(localRoot, relative);
}
