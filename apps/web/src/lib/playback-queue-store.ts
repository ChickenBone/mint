import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@mint/core/db";
import { playbackQueues as queues, playbackQueueEntries as entries } from "@mint/core/playback-queues-db";
import { PLAYABLE } from "@mint/core/playback";
import { toTrackView } from "@mint/core/views";
import { MusicError } from "@mint/core/music";
import { queueTrackSource } from "./player-catalog";
import { trackPlayerItem } from "./player-protocol";
import type { QueueEdit, QueuePage } from "./progressive-queue";
import type { z } from "zod";
import type { queueOpenSchema } from "./progressive-queue";

type Store = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;
async function owned(db: Store, userId: string, id: string) {
  const [queue] = await db.select().from(queues).where(and(eq(queues.id, id), eq(queues.userId, userId), gt(queues.expiresAt, new Date())));
  if (!queue) throw new MusicError("This listening queue expired or belongs to another account. Select the collection again.", 404);
  return queue;
}
export async function queuePage(db: Store, userId: string, id: string, position: number): Promise<QueuePage> {
  const queue = await owned(db, userId, id);
  const current = Math.max(0, Math.min(position, queue.total - 1)), offset = Math.max(0, current - 20);
  const rows = await db.select({ entry: entries, track: schema.tracks }).from(entries)
    .innerJoin(schema.tracks, eq(schema.tracks.id, entries.trackId))
    .where(and(eq(entries.queueId, id), sql`${entries.position} >= ${offset}`))
    .orderBy(asc(entries.position), asc(entries.id)).limit(100);
  if (rows.length !== Math.min(100, Math.max(0, queue.total - offset)) ||
      rows.some((row, i) => row.entry.position !== offset + i)) throw new MusicError("Songs in this queue were removed from the library. Select the collection again.", 409);
  return { context: { id, revision: queue.revision, total: queue.total, shuffle: queue.shuffled, offset, position: current },
    items: rows.map(({ entry, track }) => ({ ...trackPlayerItem(toTrackView(track)), queueId: entry.id,
      occurrenceId: entry.sourceOccurrenceId ?? undefined, duration: (track.durationSec ?? track.existingDurationSec ?? 0) * 1000 })) };
}
export async function openQueue(userId: string, input: z.infer<typeof queueOpenSchema>) {
  const db = getDb(), source = await queueTrackSource(input.collection, userId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 782))`);
    await tx.delete(queues).where(and(eq(queues.userId, userId), sql`${queues.expiresAt} <= now()`));
    const old = await tx.select({ id: queues.id }).from(queues).where(eq(queues.userId, userId)).orderBy(desc(queues.createdAt)).offset(9);
    if (old.length) await tx.delete(queues).where(inArray(queues.id, old.map((row) => row.id)));
    const id = randomUUID();
    await tx.insert(queues).values({ id, userId, shuffled: input.shuffle, expiresAt: new Date(Date.now() + 7 * 86400_000) });
    await tx.execute(sql`insert into playback_queue_entries(queue_id,track_id,position,original_position,source_occurrence_id)
      select ${id}::uuid, source.track_id,
        (row_number() over(order by ${input.shuffle ? sql`random()` : sql`source.original_position`}) - 1)::int,
        source.original_position,source.source_occurrence_id from (${source}) source`);
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(entries).where(eq(entries.queueId, id));
    if (!count?.total) throw new MusicError("No downloaded songs are available for this selection.");
    await tx.update(queues).set({ total: count.total }).where(eq(queues.id, id));
    let position = 0;
    if (input.trackId) {
      const [selected] = await tx.select({ position: entries.position }).from(entries)
        .where(and(eq(entries.queueId, id), eq(entries.trackId, input.trackId), input.occurrenceId ? eq(entries.sourceOccurrenceId, input.occurrenceId) : undefined))
        .orderBy(asc(entries.position)).limit(1);
      if (!selected) throw new MusicError("This song is no longer in the selected collection.", 409);
      position = selected.position;
    }
    return queuePage(tx, userId, id, position);
  });
}

export async function editQueue(userId: string, id: string, revision: number, currentId: string, edit: QueueEdit) {
  const source = edit.action === "append-collection" ? await queueTrackSource(edit.collection, userId) : undefined;
  return getDb().transaction(async (tx) => {
    const [locked] = await tx.select().from(queues).where(and(eq(queues.id, id), eq(queues.userId, userId))).for("update");
    const queue = await owned(tx, userId, id);
    if (!locked || queue.revision !== revision) throw new MusicError("This queue changed on another device. Reopen the collection before editing.", 409);
    const [current] = await tx.select().from(entries).where(and(eq(entries.queueId, id), eq(entries.id, currentId)));
    if (!current) throw new MusicError("The current queue entry no longer exists.", 409);
    let nextPosition = current.position;
    if (edit.action === "append") {
      const tracks = await tx.select({ id: schema.tracks.id }).from(schema.tracks).where(and(PLAYABLE, inArray(schema.tracks.id, [...new Set(edit.trackIds)])));
      if (tracks.length !== new Set(edit.trackIds).size) throw new MusicError("One of the selected songs is not available.");
      const at = edit.next ? current.position + 1 : queue.total;
      const [last] = await tx.select({ n: sql<number>`coalesce(max(${entries.originalPosition}),-1)::int` }).from(entries).where(eq(entries.queueId, id));
      await tx.update(entries).set({ position: sql`${entries.position} + ${edit.trackIds.length}` })
        .where(and(eq(entries.queueId, id), sql`${entries.position} >= ${at}`));
      await tx.insert(entries).values(edit.trackIds.map((trackId, index) => ({ queueId: id, trackId, position: at + index, originalPosition: last!.n + index + 1 })));
    } else if (edit.action === "append-collection") {
      const at = edit.next ? current.position + 1 : queue.total;
      const [last] = await tx.select({ n: sql<number>`coalesce(max(${entries.originalPosition}),-1)::int` }).from(entries).where(eq(entries.queueId, id));
      const inserted = await tx.execute(sql`with source as materialized (${source!}),
        capacity as (select count(*)::int as n from source),
        shifted as (update playback_queue_entries set position=position+(select n from capacity)
          where queue_id=${id}::uuid and position>=${at} returning id)
        insert into playback_queue_entries(queue_id,track_id,position,original_position,source_occurrence_id)
        select ${id}::uuid,source.track_id,
          ${at}+(row_number() over(order by source.original_position)-1)::int,
          ${last!.n}+(row_number() over(order by source.original_position))::int,
          source.source_occurrence_id from source`);
      if (!inserted.rowCount) throw new MusicError("No downloaded songs are available for this collection.");
    } else if (edit.action === "remove") {
      const [removed] = await tx.delete(entries).where(and(eq(entries.queueId, id), eq(entries.id, edit.entryId))).returning();
      if (!removed) throw new MusicError("This queue entry was already removed.", 409);
      await tx.update(entries).set({ position: sql`${entries.position} - 1` }).where(and(eq(entries.queueId, id), sql`${entries.position} > ${removed.position}`));
      if (removed.position < current.position) nextPosition--;
    } else if (edit.action === "clear") {
      await tx.delete(entries).where(and(eq(entries.queueId, id), sql`${entries.position} > ${current.position}`));
    } else if (edit.action === "shuffle") {
      await tx.execute(sql`with ordering as (
        select id,(row_number() over(order by ${edit.enabled
          ? sql`case when position <= ${current.position} then 0 else 1 end, case when position <= ${current.position} then position end, random()`
          : sql`original_position`})-1)::int as next_position from playback_queue_entries where queue_id=${id}::uuid)
        update playback_queue_entries e set position=o.next_position from ordering o where e.id=o.id`);
      await tx.update(queues).set({ shuffled: edit.enabled }).where(eq(queues.id, id));
      const [updated] = await tx.select({ position: entries.position }).from(entries).where(eq(entries.id, currentId));
      nextPosition = updated!.position;
    } else if (edit.action === "move") {
      const targets = await tx.select().from(entries).where(and(eq(entries.queueId, id), inArray(entries.id, [edit.entryId, edit.before])));
      const from = targets.find((row) => row.id === edit.entryId), to = targets.find((row) => row.id === edit.before);
      if (!from || !to || from.position <= current.position || to.position <= current.position) throw new MusicError("Only upcoming songs can be moved.");
      if (from.id !== to.id) {
        const destination = from.position < to.position ? to.position - 1 : to.position;
        await tx.execute(sql`update playback_queue_entries set position=case when id=${from.id}::uuid then ${destination}
          when ${from.position} < ${to.position} and position > ${from.position} and position < ${to.position} then position-1
          when ${from.position} > ${to.position} and position >= ${to.position} and position < ${from.position} then position+1 else position end where queue_id=${id}::uuid`);
        await tx.execute(sql`update playback_queue_entries set original_position=position where queue_id=${id}::uuid`);
      }
    }
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(entries).where(eq(entries.queueId, id));
    await tx.update(queues).set({ revision: queue.revision + 1, total: count!.total, expiresAt: new Date(Date.now() + 7 * 86400_000) }).where(eq(queues.id, id));
    return queuePage(tx, userId, id, Math.max(0, Math.min(nextPosition, count!.total - 1)));
  });
}
