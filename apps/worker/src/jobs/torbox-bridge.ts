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
 * Lidarr is configured with a "Torrent Blackhole" download client. It drops .torrent/.magnet files into
 * BLACKHOLE_TORRENT_DIR; this bridge sends them to TorBox, then streams finished files into
 * BLACKHOLE_DOWNLOAD_DIR (Lidarr's watch folder), where Lidarr imports them.
 */

export interface BridgeRecord {
  torrentId: number;
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

export function normalizeName(name: string) {
  return name
    .toLowerCase()
    .replace(/\.(torrent|magnet)$/i, "")
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
  await ensureDir(config.blackholeTorrents);
  const processed = path.join(config.blackholeTorrents, ".mint-processed");
  await ensureDir(processed);
  const entries = await fs.readdir(config.blackholeTorrents, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile() || !/\.(torrent|magnet)$/i.test(e.name)) continue;
    const full = path.join(config.blackholeTorrents, e.name);
    const name = e.name.replace(/\.(torrent|magnet)$/i, "");
    if (await getRecord(name)) {
      await fs.rename(full, path.join(processed, e.name)).catch(() => undefined);
      continue;
    }
    try {
      const data = await fs.readFile(full);
      const added = /\.magnet$/i.test(e.name)
        ? await torbox.addTorrent({ magnet: data.toString("utf8").trim() }, name)
        : await torbox.addTorrent({ file: { name: e.name, data } }, name);
      await saveRecord({ torrentId: added.torrent_id, name, phase: "remote", remoteProgress: 0, localProgress: 0, state: "queued", createdAt: Date.now(), updatedAt: 0 });
      await fs.rename(full, path.join(processed, e.name));
      log.info({ name, torrentId: added.torrent_id }, "sent release to TorBox");
    } catch (err) {
      log.warn({ err, name }, "TorBox rejected release");
      await saveRecord({ torrentId: 0, name, phase: "error", remoteProgress: 0, localProgress: 0, state: "rejected", error: (err as Error).message, createdAt: Date.now(), updatedAt: 0 });
      await fs.rename(full, path.join(processed, `${e.name}.failed`)).catch(() => undefined);
    }
  }
}

async function pollActive() {
  const names = await getRedis().smembers(ACTIVE);
  for (const name of names) {
    const rec = await getRecord(name);
    if (!rec || rec.phase !== "remote") continue;
    const t = await torbox.getTorrent(rec.torrentId).catch(() => null);
    if (!t) continue;
    rec.remoteProgress = t.download_finished ? 1 : t.progress;
    rec.state = t.download_state;
    const failed = /error|failed/i.test(t.download_state);
    const stalled = /stalled/i.test(t.download_state) && Date.now() - rec.createdAt > 2 * 3_600_000;
    if (failed || stalled) {
      rec.phase = "error";
      rec.error = t.download_state;
    }
    if (t.download_finished && t.download_present) {
      rec.phase = "local";
      await queues.torbox.add("download", { torrentId: rec.torrentId, name: rec.name }, { jobId: jobId.torbox(rec.torrentId) });
    }
    await saveRecord(rec);
  }
}

export async function torboxTick() {
  if (!torbox.torboxEnabled()) return;
  await ingestNewFiles();
  await pollActive();
}

/** Streams every file of a finished TorBox torrent into Lidarr's watch folder. */
export async function processTorboxDownload(job: Job<TorboxJob>) {
  const rec = (await getRecord(job.data.name)) ?? {
    torrentId: job.data.torrentId,
    name: job.data.name,
    phase: "local" as const,
    remoteProgress: 1,
    localProgress: 0,
    state: "downloading",
    createdAt: Date.now(),
    updatedAt: 0,
  };
  const t = await torbox.getTorrent(job.data.torrentId);
  if (!t?.files?.length) throw new Error("TorBox torrent has no files");

  const partialRoot = path.join(config.blackholeDownloads, ".mint-partial", job.data.name);
  const finalRoot = path.join(config.blackholeDownloads, job.data.name);
  const total = t.files.reduce((n, f) => n + f.size, 0) || 1;
  let done = 0;
  for (const f of t.files) {
    // TorBox file names are "<torrent root>/<path>"; keep the inner structure under our own folder name.
    const rel = f.name.includes("/") ? f.name.split("/").slice(1).join("/") : f.short_name;
    const dest = path.join(partialRoot, rel);
    if (!dest.startsWith(partialRoot)) throw new Error(`Unsafe path in torrent: ${f.name}`);
    if (!(await exists(dest))) {
      const url = await torbox.fileLink(t.id, f.id);
      await downloadToFile(url, dest, async (_frac, bytes) => {
        rec.localProgress = Math.min(1, (done + bytes) / total);
        await saveRecord(rec);
      });
    }
    done += f.size;
  }
  await ensureDir(config.blackholeDownloads);
  await fs.rm(finalRoot, { recursive: true, force: true });
  await fs.rename(partialRoot, finalRoot);
  rec.phase = "done";
  rec.localProgress = 1;
  await saveRecord(rec);
  if (process.env.TORBOX_DELETE_AFTER_DOWNLOAD !== "false") await torbox.removeTorrent(t.id);
  log.info({ name: job.data.name }, "release handed to Lidarr");
}
