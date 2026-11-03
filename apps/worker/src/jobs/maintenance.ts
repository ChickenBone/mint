import { CHANNEL, computeStats, jobId, publish, type MaintenanceJob } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import type { Job } from "bullmq";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { config } from "../config";
import { log } from "../log";
import { queues } from "../queues";
import * as cobalt from "../services/cobalt";
import * as lidarr from "../services/lidarr";
import * as plex from "../services/plex";
import { torboxEnabled } from "../services/torbox";
import { torboxTick } from "./torbox-bridge";

let lastStats = "";

async function publishStats() {
  const stats = await computeStats(getDb());
  const { updatedAt: _ignored, ...rest } = stats;
  const sig = JSON.stringify(rest);
  const redis = getRedis();
  await redis.set("mint:stats", JSON.stringify(stats));
  if (sig === lastStats) return;
  lastStats = sig;
  await publish(redis, CHANNEL.public, { type: "stats", data: stats });
}

async function health() {
  const [lid, cob, plx] = await Promise.all([
    lidarr.lidarrEnabled() ? lidarr.ping() : Promise.resolve(null),
    process.env.COBALT_URL ? cobalt.ping() : Promise.resolve(null),
    config.plexEnabled ? plex.ping() : Promise.resolve(null),
  ]);
  const counts = await Promise.all(Object.entries(queues).map(async ([name, q]) => [name, await q.getJobCounts("active", "waiting", "delayed", "failed")] as const));
  const report = {
    services: { lidarr: lid, cobalt: cob, plex: plx, torbox: torboxEnabled() ? true : null },
    queues: Object.fromEntries(counts),
    checkedAt: new Date().toISOString(),
  };
  await getRedis().set("mint:health", JSON.stringify(report), "EX", 300);
}

async function plexPlaylists(userId: string) {
  if (!config.plexEnabled) return;
  const db = getDb();
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  const acct = await db.query.youtubeAccounts.findFirst({ where: eq(schema.youtubeAccounts.userId, userId) });
  if (!user || !acct) return;

  const liked = await db
    .select({ key: schema.tracks.plexRatingKey })
    .from(schema.userTracks)
    .innerJoin(schema.tracks, eq(schema.tracks.id, schema.userTracks.trackId))
    .where(and(eq(schema.userTracks.userId, userId), isNotNull(schema.tracks.plexRatingKey)))
    .orderBy(asc(schema.userTracks.likedAt));
  const likedKey = await plex.syncPlaylist(`Mint · ${user.name} · Liked`, liked.map((l) => l.key!), acct.plexPlaylistKey);
  if (likedKey !== acct.plexPlaylistKey) {
    await db.update(schema.youtubeAccounts).set({ plexPlaylistKey: likedKey }).where(eq(schema.youtubeAccounts.userId, userId));
  }

  const pls = await db.query.playlists.findMany({ where: and(eq(schema.playlists.userId, userId), eq(schema.playlists.syncEnabled, true)) });
  for (const pl of pls) {
    const items = await db
      .select({ key: schema.tracks.plexRatingKey })
      .from(schema.playlistTracks)
      .innerJoin(schema.tracks, eq(schema.tracks.id, schema.playlistTracks.trackId))
      .where(and(eq(schema.playlistTracks.playlistId, pl.id), isNotNull(schema.tracks.plexRatingKey)))
      .orderBy(asc(schema.playlistTracks.position));
    const key = await plex.syncPlaylist(`Mint · ${user.name} · ${pl.title}`, items.map((i) => i.key!), pl.plexPlaylistKey);
    if (key !== pl.plexPlaylistKey) await db.update(schema.playlists).set({ plexPlaylistKey: key }).where(eq(schema.playlists.id, pl.id));
  }
}

export async function processMaintenance(job: Job<MaintenanceJob>) {
  const data = job.data;
  switch (data.kind) {
    case "stats":
      return publishStats();
    case "health":
      return health();
    case "torbox-tick":
      return torboxTick();
    case "plex-playlists":
      return plexPlaylists(data.userId);
    case "schedule-sync": {
      const accts = await getDb().query.youtubeAccounts.findMany({ where: eq(schema.youtubeAccounts.autoSync, true), columns: { userId: true } });
      for (const a of accts) {
        await queues.sync.add("sync", { userId: a.userId, reason: "schedule" }, { jobId: jobId.sync(a.userId) });
      }
      log.info({ users: accts.length }, "scheduled sync");
      return;
    }
  }
}
