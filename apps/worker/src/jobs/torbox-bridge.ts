import fs from "node:fs/promises";
import path from "node:path";
import { jobId, type TorboxJob } from "@mint/core";
import { getRedis } from "@mint/core/redis";
import type { Job } from "bullmq";
import { config } from "../config";
import { downloadToFile, ensureDir, exists } from "../files";
import { log } from "../log";
import { queues } from "../queues";
import * as torbox from "../services/torbox";

/**
 * Lidarr drops torrents, magnets and NZBs into blackholes. TorBox fetches the release remotely;
 * this bridge streams completed files into Lidarr's import folder.
 */

export interface BridgeRecord {
  torrentId: number;
  protocol?: "torrent" | "usenet";
  name: string;
  phase: "remote" | "local" | "done" | "error";
  remoteProgress: number;
  localProgress: number;
  state: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const ACTIVE = "mint:torbox:active";
const key = (name: string) => `mint:torbox:${normalizeName(name)}`;
let ticking = false;

export function normalizeName(name: string) {
  return name
    .toLowerCase()
    .replace(/\.(torrent|magnet|nzb)$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export async function getRecord(name: string): Promise<BridgeRecord | null> {
  const raw = await getRedis().get(key(name));
  return raw ? (JSON.parse(raw) as BridgeRecord) : null;
}

async function saveRecord(rec: BridgeRecord) {
  const redis = getRedis();
  rec.updatedAt = Date.now();
  await redis.set(key(rec.name), JSON.stringify(rec), "EX", 7 * 24 * 3600);
  if (rec.phase === "remote" || rec.phase === "local") await redis.sadd(ACTIVE, rec.name);
  else await redis.srem(ACTIVE, rec.name);
}

export function bridgeProgress(rec: BridgeRecord) {
  return rec.remoteProgress * 0.6 + rec.localProgress * 0.4;
}

async function ingestNewFiles() {
  for (const [folder, protocol] of [[config.blackholeTorrents, "torrent"], [config.blackholeUsenet, "usenet"]] as const) {
    await ensureDir(folder);
    const processed = path.join(folder, ".mint-processed");
    await ensureDir(processed);
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !(protocol === "usenet" ? /\.nzb$/i : /\.(torrent|magnet)$/i).test(entry.name)) continue;
      const full = path.join(folder, entry.name);
      const name = entry.name.replace(/\.(torrent|magnet|nzb)$/i, "");
      const previous = await getRecord(name);
      if (previous && previous.phase !== "error") {
        await fs.rename(full, path.join(processed, entry.name));
        continue;
      }
      let id: number;
      try {
        const data = await fs.readFile(full);
        if (protocol === "usenet") {
          id = await torbox.addUsenet({ name: entry.name, data });
        } else {
          const added = /\.magnet$/i.test(entry.name)
            ? await torbox.addTorrent({ magnet: data.toString("utf8").trim() }, name)
            : await torbox.addTorrent({ file: { name: entry.name, data } }, name);
          id = added.torrent_id;
        }
      } catch (err) {
        log.warn({ err, name, protocol }, "TorBox rejected release");
        await saveRecord({ torrentId: 0, protocol, name, phase: "error", remoteProgress: 0, localProgress: 0, state: "rejected", error: err instanceof Error ? err.message : String(err), createdAt: Date.now(), updatedAt: 0 });
        await fs.rename(full, path.join(processed, `${entry.name}.failed`));
        continue;
      }
      await saveRecord({ torrentId: id, protocol, name, phase: "remote", remoteProgress: 0, localProgress: 0, state: "queued", createdAt: Date.now(), updatedAt: 0 });
      await fs.rename(full, path.join(processed, entry.name));
      log.info({ name, downloadId: id, protocol }, "sent release to TorBox");
    }
  }
}

async function enqueueDownload(rec: BridgeRecord) {
  const protocol = rec.protocol ?? "torrent";
  const id = jobId.torbox(rec.torrentId, protocol);
  const existing = await queues.torbox.getJob(id);
  if (existing && await existing.getState() === "failed") {
    rec.phase = "error";
    rec.error = existing.failedReason || "Local transfer failed";
    await saveRecord(rec);
    return;
  }
  await queues.torbox.add("download", { torrentId: rec.torrentId, name: rec.name, protocol }, { jobId: id });
}

async function pollActive() {
  const names = await getRedis().smembers(ACTIVE);
  for (const name of names) {
    const rec = await getRecord(name);
    if (!rec) {
      await getRedis().srem(ACTIVE, name);
      continue;
    }
    if (rec.phase === "local") {
      await enqueueDownload(rec);
      continue;
    }
    if (rec.phase !== "remote") continue;
    const protocol = rec.protocol ?? "torrent";
    const t = await (protocol === "usenet" ? torbox.getUsenet(rec.torrentId) : torbox.getTorrent(rec.torrentId)).catch((err) => {
      log.warn({ err, protocol, downloadId: rec.torrentId }, "could not poll TorBox download");
      return null;
    });
    if (!t) {
      rec.state = "TorBox download unavailable";
      await saveRecord(rec);
      continue;
    }
    rec.remoteProgress = t.download_finished ? 1 : t.progress;
    rec.state = t.download_state;
    const failed = /error|failed/i.test(t.download_state);
    const stalled = /stalled/i.test(t.download_state) && Date.now() - rec.createdAt > 2 * 3_600_000;
    if (failed || stalled) {
      rec.phase = "error";
      rec.error = t.download_state;
    }
    if (!failed && !stalled && t.download_finished && t.download_present) {
      rec.phase = "local";
      await saveRecord(rec);
      await enqueueDownload(rec);
      continue;
    }
    await saveRecord(rec);
  }
}

export async function torboxTick() {
  if (!torbox.torboxEnabled() || ticking) return;
  ticking = true;
  try {
    await ingestNewFiles();
    await pollActive();
  } finally {
    ticking = false;
  }
}

export function releasePaths(name: string, protocol: "torrent" | "usenet" = "torrent") {
  if (!name || path.basename(name) !== name || /[\\\0]/.test(name) || [".", ".."].includes(name)) throw new Error("Unsafe release directory name");
  const watchFolder = protocol === "usenet" ? config.blackholeUsenetDownloads : config.blackholeDownloads;
  return {
    partialRoot: path.join(watchFolder, ".mint-partial", name),
    finalRoot: path.join(watchFolder, name),
  };
}

export function downloadPath(root: string, fileName: string, commonRoot: string | null) {
  const segments = fileName.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\\\0]/.test(segment))) {
    throw new Error("Unsafe path in TorBox download");
  }
  const relative = commonRoot && segments.length > 1 && segments[0] === commonRoot ? segments.slice(1).join("/") : fileName;
  const dest = path.resolve(root, relative);
  const inside = path.relative(root, dest);
  if (!inside || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error("Unsafe path in TorBox download");
  return dest;
}

/** Streams a completed torrent or Usenet release into Lidarr's watch folder. */
export async function processTorboxDownload(job: Job<TorboxJob>) {
  const protocol = job.data.protocol ?? "torrent";
  const rec = (await getRecord(job.data.name)) ?? {
    torrentId: job.data.torrentId,
    protocol,
    name: job.data.name,
    phase: "local" as const,
    remoteProgress: 1,
    localProgress: 0,
    state: "downloading",
    createdAt: Date.now(),
    updatedAt: 0,
  };
  if (rec.phase === "done") return;
  if (rec.torrentId !== job.data.torrentId || (rec.protocol ?? "torrent") !== protocol) throw new Error("Release was superseded by another TorBox download");
  const { partialRoot, finalRoot } = releasePaths(job.data.name, protocol);
  if (await exists(finalRoot)) throw new Error("Lidarr destination already exists; refusing to overwrite an existing release");
  const t = await (protocol === "usenet" ? torbox.getUsenet(job.data.torrentId) : torbox.getTorrent(job.data.torrentId));
  if (!t?.files?.length) throw new Error("TorBox download has no files");
  if (!t.download_finished || !t.download_present) throw new Error("TorBox download is not ready");

  const firstRoot = t.files[0]!.name.split("/")[0]!;
  const commonRoot = t.files.every((file) => file.name.startsWith(`${firstRoot}/`)) ? firstRoot : null;
  const destinations = t.files.map((file) => downloadPath(partialRoot, file.name, commonRoot));
  if (new Set(destinations).size !== destinations.length) throw new Error("TorBox download contains duplicate file paths");
  const total = t.files.reduce((n, f) => n + f.size, 0) || 1;
  let done = 0;
  for (const [index, f] of t.files.entries()) {
    const dest = destinations[index]!;
    if (!(await exists(dest)) || (f.size > 0 && (await fs.stat(dest)).size !== f.size)) {
      const url = await (protocol === "usenet" ? torbox.usenetFileLink(t.id, f.id) : torbox.fileLink(t.id, f.id));
      const { bytes } = await downloadToFile(url, dest, async (_frac, bytes) => {
        rec.localProgress = Math.min(1, (done + bytes) / total);
        await saveRecord(rec);
      });
      if (f.size > 0 && bytes !== f.size) throw new Error("TorBox file size did not match; the partial release was not published");
    }
    done += f.size;
  }
  await ensureDir(path.dirname(finalRoot));
  await fs.rename(partialRoot, finalRoot);
  rec.phase = "done";
  rec.localProgress = 1;
  await saveRecord(rec);
  if (process.env.TORBOX_DELETE_AFTER_DOWNLOAD !== "false") {
    try {
      if (protocol === "usenet") await torbox.removeUsenet(t.id);
      else await torbox.removeTorrent(t.id);
    } catch (err) {
      log.warn({ err, protocol, downloadId: t.id }, "download imported but TorBox cleanup failed");
    }
  }
  log.info({ name: job.data.name }, "release handed to Lidarr");
}
