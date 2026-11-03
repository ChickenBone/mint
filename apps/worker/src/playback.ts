import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { constants } from "node:fs";
import { verifyToken } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { activePlaybackSession, PLAYABLE, UUID, type PlaybackClaim } from "@mint/core/playback";
import { and, eq, inArray } from "drizzle-orm";
import { config } from "./config";
import { log } from "./log";
import { sonicNeighbors } from "./services/plex";

const TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".mp4": "audio/mp4",
  ".aac": "audio/aac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".wave": "audio/wav",
};

export async function serveSonic(req: IncomingMessage, res: ServerResponse, trackId: string) {
  const reply = (status: number, body: object) => res.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" }).end(JSON.stringify(body));
  const claim = verifyToken<PlaybackClaim>("sonic", req.headers.authorization?.replace(/^Bearer /, ""));
  if (!UUID.test(trackId) || !claim || claim.trackId !== trackId || !await activePlaybackSession(claim.sessionHash, claim.userId)) {
    return reply(401, { error: "Approved membership required" });
  }
  const track = await getDb().query.tracks.findFirst({ where: and(eq(schema.tracks.id, trackId), PLAYABLE) });
  if (!track?.plexRatingKey || !(track.sonicAnalyzed || track.existingSonicAnalyzed)) {
    return reply(409, { error: "This track needs a Plex identity and completed sonic analysis. Finish the Plex scan and re-index existing music." });
  }
  if (!config.plexEnabled) return reply(503, { error: "Plex is not configured on the playback worker." });
  try {
    const keys = await sonicNeighbors(track.plexRatingKey);
    if (!keys.length) return reply(200, { ids: [] });
    const rows = await getDb().select({ id: schema.tracks.id, key: schema.tracks.plexRatingKey }).from(schema.tracks)
      .where(and(PLAYABLE, inArray(schema.tracks.plexRatingKey, keys)));
    const byKey = new Map(rows.map((row) => [row.key, row.id]));
    return reply(200, { ids: [...new Set(keys.map((key) => byKey.get(key)).filter((id): id is string => Boolean(id && id !== trackId)))] });
  } catch (error) {
    log.warn({ err: error, trackId }, "sonic recommendations failed");
    return reply(503, { error: "Plex sonic recommendations are unavailable. Check Plex Pass, completed sonic analysis and the worker's Plex connection." });
  }
}

export function byteRange(header: string | undefined, size: number) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end, partial: true };
}

export async function confinedMedia(file: string, roots: string[]) {
  const resolved = await realpath(file);
  for (const root of roots) {
    const lexical = path.relative(path.resolve(root), path.resolve(file));
    if (!lexical || lexical === ".." || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) continue;
    const base = await realpath(root);
    const relative = path.relative(base, resolved);
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return resolved;
  }
  throw new Error("Indexed media is outside configured library folders");
}

export async function servePlayback(req: IncomingMessage, res: ServerResponse, trackId: string) {
  res.setHeader("cache-control", "private, no-store");
  const claim = verifyToken<PlaybackClaim>("playback", req.headers.authorization?.replace(/^Bearer /, ""));
  if (!UUID.test(trackId) || !claim || claim.trackId !== trackId ||
      !await activePlaybackSession(claim.sessionHash, claim.userId)) {
    res.writeHead(401).end("Approved membership required");
    return;
  }
  const track = await getDb().query.tracks.findFirst({ where: and(eq(schema.tracks.id, trackId), PLAYABLE) });
  const file = track?.filePath ?? track?.existingFilePath;
  if (!file) return void res.writeHead(404).end("Track is not available");
  let handle;
  try {
    const resolved = await confinedMedia(file, [config.musicDir, config.existingMusicDir]);
    const type = TYPES[path.extname(resolved).toLowerCase()];
    if (!type) return void res.writeHead(415).end("This audio format is not supported by the browser MVP");
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (process.platform === "linux") {
      await confinedMedia(await realpath(`/proc/self/fd/${handle.fd}`), [config.musicDir, config.existingMusicDir]);
    }
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return void res.writeHead(404).end("Audio file is unavailable");
    const range = byteRange(req.headers.range, stat.size);
    if (!range) return void res.writeHead(416, { "content-range": `bytes */${stat.size}` }).end();
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-type", type);
    res.setHeader("content-length", range.end - range.start + 1);
    res.setHeader("x-content-type-options", "nosniff");
    if (range.partial) res.setHeader("content-range", `bytes ${range.start}-${range.end}/${stat.size}`);
    res.writeHead(range.partial ? 206 : 200);
    if (req.method === "HEAD") return void res.end();
    const stream = handle.createReadStream({ start: range.start, end: range.end, autoClose: false });
    const timer = setInterval(() => {
      void activePlaybackSession(claim.sessionHash, claim.userId).then((session) => {
        if (!session) stream.destroy(new Error("Playback membership revoked"));
      }).catch((err: unknown) => stream.destroy(err instanceof Error ? err : new Error("Session validation failed")));
    }, 5000);
    try { await pipeline(stream, res); } finally { clearInterval(timer); }
  } catch (err) {
    log.warn({ err, trackId }, "browser playback failed");
    if (!res.headersSent) res.writeHead(503).end("Audio is unavailable; check worker folder mappings and permissions");
    else res.destroy();
  } finally {
    await handle?.close();
  }
}
