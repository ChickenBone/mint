import "server-only";
import { computeStats, toTrackView, type Stats, type TrackView } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { and, asc, desc, eq, ilike, inArray, lt, notInArray, or, sql } from "drizzle-orm";

const db = () => getDb();
const t = schema.tracks;
const LIBRARY_STAGES = ["ready", "analyzing"] as const;

export async function getStats(): Promise<Stats> {
  const cached = await getRedis()
    .get("mint:stats")
    .catch(() => null);
  return cached ? (JSON.parse(cached) as Stats) : computeStats(db());
}

/** Tracks currently moving through the pipeline (public-safe). */
export async function getActiveTracks(limit = 60): Promise<TrackView[]> {
  const rows = await db()
    .select()
    .from(t)
    .where(notInArray(t.stage, ["ready", "failed"]))
    .orderBy(desc(t.updatedAt))
    .limit(limit);
  return rows.map(toTrackView);
}

export async function getRecentlyReady(limit = 18): Promise<TrackView[]> {
  const rows = await db()
    .select()
    .from(t)
    .where(and(inArray(t.stage, [...LIBRARY_STAGES]), eq(t.hasPreview, true)))
    .orderBy(desc(sql`coalesce(${t.readyAt}, ${t.updatedAt})`))
    .limit(limit);
  return rows.map(toTrackView);
}

export interface LibraryPage {
  tracks: TrackView[];
  nextCursor: string | null;
}

/** Keyset-paginated public library search over artist/title/album. */
export async function searchLibrary(opts: { q?: string; cursor?: string | null; limit?: number }): Promise<LibraryPage> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const q = opts.q?.trim().slice(0, 100);
  const conds = [inArray(t.stage, [...LIBRARY_STAGES]), eq(t.hasPreview, true)];
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    conds.push(or(ilike(t.title, like), ilike(t.artist, like), ilike(t.album, like))!);
  }
  if (opts.cursor) {
    const [artist, title, id] = JSON.parse(Buffer.from(opts.cursor, "base64url").toString()) as [string, string, string];
    conds.push(
      sql`(lower(${t.artist}), lower(${t.title}), ${t.id}) > (${artist}, ${title}, ${id}::uuid)`,
    );
  }
  const rows = await db()
    .select()
    .from(t)
    .where(and(...conds))
    .orderBy(asc(sql`lower(${t.artist})`), asc(sql`lower(${t.title})`), asc(t.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    tracks: page.map(toTrackView),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify([last.artist.toLowerCase(), last.title.toLowerCase(), last.id])).toString("base64url")
        : null,
  };
}

export async function getLikedTracks(userId: string): Promise<TrackView[]> {
  const rows = await db()
    .select({ track: t })
    .from(schema.userTracks)
    .innerJoin(t, eq(t.id, schema.userTracks.trackId))
    .where(eq(schema.userTracks.userId, userId))
    .orderBy(desc(schema.userTracks.likedAt));
  return rows.map((r) => toTrackView(r.track));
}

export async function getUserJobs(userId: string, opts: { failedOnly?: boolean } = {}): Promise<TrackView[]> {
  const rows = await db()
    .select({ track: t })
    .from(schema.userTracks)
    .innerJoin(t, eq(t.id, schema.userTracks.trackId))
    .where(
      and(
        eq(schema.userTracks.userId, userId),
        opts.failedOnly ? eq(t.stage, "failed") : notInArray(t.stage, ["ready"]),
      ),
    )
    .orderBy(desc(t.updatedAt))
    .limit(500);
  return rows.map((r) => toTrackView(r.track));
}

export async function getYoutubeAccount(userId: string) {
  return db().query.youtubeAccounts.findFirst({
    where: eq(schema.youtubeAccounts.userId, userId),
    columns: { accessTokenEnc: false, refreshTokenEnc: false },
  });
}

export async function getPlaylists(userId: string) {
  return db().query.playlists.findMany({
    where: eq(schema.playlists.userId, userId),
    orderBy: [desc(schema.playlists.syncEnabled), asc(schema.playlists.title)],
  });
}

export async function getPlaylist(userId: string, playlistId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(playlistId)) return null;
  const pl = await db().query.playlists.findFirst({
    where: and(eq(schema.playlists.id, playlistId), eq(schema.playlists.userId, userId)),
  });
  if (!pl) return null;
  const rows = await db()
    .select({ track: t })
    .from(schema.playlistTracks)
    .innerJoin(t, eq(t.id, schema.playlistTracks.trackId))
    .where(eq(schema.playlistTracks.playlistId, pl.id))
    .orderBy(asc(schema.playlistTracks.position));
  return { playlist: pl, tracks: rows.map((r) => toTrackView(r.track)) };
}

export async function getUserSummary(userId: string) {
  const { rows } = await db().execute<{ total: string; ready: string; active: string; failed: string; duration: string | null }>(sql`
    select count(*) as total,
      count(*) filter (where t.stage in ('ready','analyzing')) as ready,
      count(*) filter (where t.stage not in ('ready','analyzing','failed')) as active,
      count(*) filter (where t.stage = 'failed') as failed,
      sum(t.duration_sec) filter (where t.stage in ('ready','analyzing')) as duration
    from user_tracks ut join tracks t on t.id = ut.track_id
    where ut.user_id = ${userId}
  `);
  const r = rows[0]!;
  return {
    total: Number(r.total),
    ready: Number(r.ready),
    active: Number(r.active),
    failed: Number(r.failed),
    durationSec: Number(r.duration ?? 0),
  };
}

export async function getTrackTimeline(trackId: string) {
  return db()
    .select()
    .from(schema.trackEvents)
    .where(eq(schema.trackEvents.trackId, trackId))
    .orderBy(asc(schema.trackEvents.createdAt));
}

// ---------- admin ----------

export async function getAccessRequests() {
  return db().query.users.findMany({
    where: eq(schema.users.status, "pending"),
    orderBy: [asc(schema.users.createdAt)],
    columns: { passwordHash: false },
  });
}

export async function getMembers() {
  const { rows } = await db().execute<{
    id: string;
    email: string;
    name: string;
    role: "user" | "admin";
    status: string;
    created_at: string;
    tracks: string;
    linked: boolean;
    last_synced_at: string | null;
  }>(sql`
    select u.id, u.email, u.name, u.role, u.status, u.created_at,
      (select count(*) from user_tracks ut where ut.user_id = u.id) as tracks,
      (ya.user_id is not null) as linked, ya.last_synced_at
    from users u left join youtube_accounts ya on ya.user_id = u.id
    where u.status in ('active','disabled')
    order by u.created_at asc
  `);
  return rows;
}

export async function getFailedTracks(limit = 100): Promise<TrackView[]> {
  const rows = await db().select().from(t).where(eq(t.stage, "failed")).orderBy(desc(t.updatedAt)).limit(limit);
  return rows.map((r) => ({ ...toTrackView(r), detail: r.error ?? r.detail }));
}

export interface Health {
  services: Record<"lidarr" | "cobalt" | "plex" | "torbox", boolean | null>;
  queues: Record<string, { active: number; waiting: number; delayed: number; failed: number }>;
  checkedAt: string;
}

export async function getHealth(): Promise<Health | null> {
  const raw = await getRedis()
    .get("mint:health")
    .catch(() => null);
  return raw ? (JSON.parse(raw) as Health) : null;
}

export async function staleSyncingCount() {
  return db().$count(schema.tracks, and(notInArray(t.stage, ["ready", "failed"]), lt(t.updatedAt, new Date(Date.now() - 6 * 3_600_000))));
}

export async function getPendingCount() {
  return db().$count(schema.users, eq(schema.users.status, "pending"));
}

export function syncStateOf(acct: Awaited<ReturnType<typeof getYoutubeAccount>>) {
  return {
    status: acct?.syncStatus ?? "idle",
    message: acct?.syncError ?? null,
    lastSyncedAt: acct?.lastSyncedAt?.toISOString() ?? null,
  } as const;
}
