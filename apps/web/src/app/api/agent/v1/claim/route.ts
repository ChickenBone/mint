import { CHANNEL, LEASE_MS, publish, toTrackView, type ClaimedJob, type UploadTokenPayload } from "@mint/core";
import { randomToken, signToken } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { and, eq, gt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { MAX_WORKER_CONCURRENCY, agentError, authenticateAgent, hubUrl, limitWorker } from "@/lib/agent";
import { audioSourceRejection, sourceSelectionMessage } from "@mint/core/matching";
import { MusicError } from "@mint/core/music";
import { youtubeScrapingAuthorized } from "@mint/core/youtube-scrape";
import { linkedYouTubeVideo } from "@/lib/youtube-search";

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 200) * 1024 * 1024;
const noContent = () => new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });

export async function POST(req: Request) {
  const auth = await authenticateAgent(req);
  if ("response" in auth) return auth.response;
  const { worker } = auth;
  if (worker.status !== "active") return agentError(403, "worker is awaiting admin approval");
  const limited = await limitWorker(worker, "claim", 60);
  if (limited) return limited;

  const db = getDb();
  const scraping = youtubeScrapingAuthorized();
  const t = schema.tracks;
  const cap = Math.min(Number(worker.capabilities?.concurrency ?? 1), MAX_WORKER_CONCURRENCY);
  const held = await db.$count(t, and(eq(t.leaseWorkerId, worker.id), gt(t.leaseExpiresAt, new Date())));
  if (held >= cap) return noContent();

  const leaseId = randomToken(16);
  const expires = new Date(Date.now() + LEASE_MS);
  // Single statement so it is safe behind a transaction-mode pooler (Neon/pgbouncer).
  const { rows } = await db.execute<{ id: string }>(sql`
    update tracks set
      lease_id = ${leaseId},
      lease_worker_id = ${worker.id},
      lease_expires_at = ${expires},
      progress = 0,
      detail = 'Downloading on a volunteer worker',
      updated_at = now()
    where id = (
      select id from tracks
      where remote_at is not null
        and youtube_video_id is not null
        and existing_file_path is null
        and stage not in ('ready', 'failed')
        and (lease_expires_at is null or lease_expires_at < now())
      order by remote_at
      limit 1
      for update skip locked
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (!id) return noContent();

  const track = await db.query.tracks.findFirst({ where: eq(t.id, id) });
  if (!track?.youtubeVideoId) return noContent();
  // Old pending handoffs must satisfy the same policy as newly queued sources.
  const owners = db.select({ userId: schema.userTracks.userId }).from(schema.userTracks)
    .innerJoin(schema.users, and(eq(schema.users.id, schema.userTracks.userId), eq(schema.users.status, "active")));
  const [owner] = await (scraping ? owners : owners.innerJoin(schema.youtubeAccounts, eq(schema.youtubeAccounts.userId, schema.userTracks.userId)))
    .where(eq(schema.userTracks.trackId, track.id)).limit(1);
  let source;
  try {
    source = owner ? await linkedYouTubeVideo(owner.userId, track.youtubeVideoId) : null;
  } catch (error) {
    await db.update(t).set({ leaseId: null, leaseWorkerId: null, leaseExpiresAt: null, detail: "Source metadata unavailable; retrying verification" })
      .where(and(eq(t.id, id), eq(t.leaseId, leaseId)));
    if (error instanceof MusicError) return agentError(error.status, error.message);
    throw error;
  }
  if (!source || audioSourceRejection(track, source, true)) {
    const detail = source ? sourceSelectionMessage(track, [source], true) : scraping
      ? "Pinned source metadata unavailable or no approved member owns this request."
      : "Pinned source metadata unavailable. Reconnect the requesting member's YouTube account.";
    await db.update(t).set({ stage: "failed", error: detail, detail: "Pinned audio source rejected; no substitute selected",
      leaseId: null, leaseWorkerId: null, leaseExpiresAt: null, remoteAt: null }).where(and(eq(t.id, id), eq(t.leaseId, leaseId)));
    return noContent();
  }
  await db.update(schema.workers).set({ lastSeenAt: new Date() }).where(eq(schema.workers.id, worker.id));
  await publish(getRedis(), CHANNEL.public, { type: "track", data: toTrackView(track) }).catch(() => undefined);

  const upload: UploadTokenPayload = { trackId: track.id, workerId: worker.id, leaseId };
  const job: ClaimedJob = {
    trackId: track.id,
    leaseId,
    leaseExpiresAt: expires.toISOString(),
    youtubeVideoId: track.youtubeVideoId,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationSec: track.durationSec,
    // Generous TTL: the hub re-checks the lease, so a stale token can't overwrite a reassigned job.
    upload: { url: `${hubUrl()}/ingest/${track.id}`, token: signToken("upload", upload, 2 * 3_600_000), maxBytes: MAX_UPLOAD_BYTES },
  };
  return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
}
