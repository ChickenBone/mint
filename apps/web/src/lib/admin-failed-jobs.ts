import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@mint/core/db";
import { toTrackView, type TrackView } from "@mint/core";

const REMOVAL_MESSAGE = "Removed failed attempt from the admin queue: ";
const selection = z.object({
  trackId: z.uuid(),
  failureVersion: z.string().regex(/^-?\d+\.\d{6}$/),
}).strict();

export type AdminFailedTrack = TrackView & { failureVersion: string };

const failureVersion = sql<string>`extract(epoch from ${schema.tracks.updatedAt})::text`;

export function adminFailedJobFilter() {
  const t = schema.tracks;
  return and(eq(t.stage, "failed"), sql`not exists (
    select 1 from ${schema.trackEvents} e
    where e.track_id = ${t.id} and e.stage = 'failed'
      and e.message = ${REMOVAL_MESSAGE} || ${failureVersion}
  )`);
}

export async function listAdminFailedJobs(db: Db, limit = 100): Promise<AdminFailedTrack[]> {
  const rows = await db.select({ track: schema.tracks, failureVersion })
    .from(schema.tracks).where(adminFailedJobFilter())
    .orderBy(desc(schema.tracks.updatedAt), schema.tracks.id).limit(limit);
  return rows.map(({ track, failureVersion }) => ({
    ...toTrackView(track), detail: track.error ?? track.detail, failureVersion,
  }));
}

export async function removeAdminFailedJobs(
  db: Db, cleanup: (trackId: string) => Promise<number>,
  input?: { trackId: string; failureVersion: string },
) {
  const target = input === undefined ? undefined : selection.parse(input);
  return db.transaction(async (tx) => {
    // Serialize admin dismissal/retry decisions; row locks also fence member retries and worker updates.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mint:admin-failed-jobs'))`);
    const { rows } = await tx.execute<{ id: string; failure_version: string }>(sql`
        select ${schema.tracks.id} as id, ${failureVersion} as failure_version
        from ${schema.tracks}
        where ${adminFailedJobFilter()}
          ${target ? sql`and ${schema.tracks.id} = ${target.trackId}
            and ${failureVersion} = ${target.failureVersion}` : sql``}
        order by ${schema.tracks.id}
        for update
    `);
    if (target && rows.length === 0) {
      throw new Error("This failed attempt changed or was already removed. Refresh the admin queue.");
    }
    let removed = 0, removedQueueJobs = 0, failed = 0;
    let failure: string | null = null;
    for (const row of rows) {
      try {
        removedQueueJobs += await cleanup(row.id);
      } catch (error) {
        if (target) {
          throw new Error("Cleanup could not finish; the failed attempt remains visible. " +
            "Some matching worker records may already have been removed. Refresh and retry. " +
            (error instanceof Error ? error.message : String(error)), { cause: error });
        }
        failed++;
        failure ??= error instanceof Error ? error.message : String(error);
        continue;
      }
      await tx.insert(schema.trackEvents).values({
        trackId: row.id, stage: "failed", message: REMOVAL_MESSAGE + row.failure_version,
      });
      removed++;
    }
    return { removed, removedQueueJobs, failed, failure };
  });
}

export async function claimAdminFailedRetry(db: Db, input: { trackId: string; failureVersion: string }) {
  const target = selection.parse(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mint:admin-failed-jobs'))`);
    const [row] = await tx.update(schema.tracks)
      .set({ stage: "queued", progress: 0, error: null, detail: "Retrying" })
      .where(and(eq(schema.tracks.id, target.trackId), sql`${failureVersion} = ${target.failureVersion}`,
        adminFailedJobFilter()))
      .returning({ id: schema.tracks.id });
    return row?.id ?? null;
  });
}
