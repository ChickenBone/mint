import type {
  PlaybackQueueEdit,
  PlaybackQueueOpenInput,
  PlaybackQueuePage,
  PlaybackQueueSelection,
} from "@mint/contracts";
import { recordings } from "@mint/domain-catalog";
import { mediaFiles } from "@mint/domain-library";
import { users } from "@mint/domain-accounts";
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { queueEntries, queueSnapshots } from "./schema";

type PlaybackQueueSchema = {
  queueSnapshots: typeof queueSnapshots;
  queueEntries: typeof queueEntries;
  mediaFiles: typeof mediaFiles;
  recordings: typeof recordings;
  users: typeof users;
};
type QueueStore = Pick<NodePgDatabase<PlaybackQueueSchema>, "select" | "insert" | "update" | "delete" | "execute">;

export type PlaybackQueueErrorCode = "NOT_FOUND" | "CONFLICT" | "INVALID_SELECTION" | "EMPTY_SELECTION";

export class PlaybackQueueError extends Error {
  constructor(readonly code: PlaybackQueueErrorCode, message: string) {
    super(message);
    this.name = "PlaybackQueueError";
  }
}

export interface PlaybackQueueRepository {
  open(userId: string, input: PlaybackQueueOpenInput): Promise<PlaybackQueuePage>;
  page(userId: string, queueId: string, position: number): Promise<PlaybackQueuePage>;
  edit(userId: string, queueId: string, input: {
    revision: number;
    currentEntryId: string;
    edit: PlaybackQueueEdit;
  }): Promise<PlaybackQueuePage>;
}

const filename = sql<string>`regexp_replace(${mediaFiles.relativePath}, '^.*/', '')`;
const title = sql<string>`coalesce(
  nullif(btrim(${mediaFiles.importedTitle}), ''),
  nullif(btrim(${recordings.title}), ''),
  nullif(${filename}, ''),
  'Unknown title'
)`;
const artist = sql<string>`coalesce(nullif(btrim(${mediaFiles.importedArtist}), ''), 'Unknown artist')`;
const album = sql<string>`coalesce(nullif(btrim(${mediaFiles.importedAlbum}), ''), 'Unknown album')`;
const version = sql<string | null>`coalesce(
  nullif(btrim(${mediaFiles.importedVersion}), ''),
  nullif(btrim(${recordings.version}), '')
)`;
const durationMs = sql<number | null>`coalesce(${mediaFiles.durationMs}, ${recordings.durationMs})`;

function normalizedSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}

function sourceFor(selection: PlaybackQueueSelection): SQL {
  if (selection.source === "items") {
    const items = selection.items.map((item, originalPosition) => ({
      media_file_id: item.mediaFileId,
      source_occurrence_id: item.occurrenceId ?? null,
      original_position: originalPosition,
    }));
    return sql`select item.media_file_id, item.source_occurrence_id, item.original_position
      from jsonb_to_recordset(${JSON.stringify(items)}::jsonb) as item(
        media_file_id uuid, source_occurrence_id uuid, original_position int
      )
      where exists (
        select 1 from library.media_files verified_file
        where verified_file.id = item.media_file_id and verified_file.availability = 'verified'
      )`;
  }

  const search = normalizedSearch(selection.search ?? "");
  const searchable = sql`lower(regexp_replace(normalize(concat_ws(' ',
    ${title}, ${mediaFiles.importedArtist}, ${mediaFiles.importedAlbum}, ${version}, ${filename}
  ), NFD), U&'[\\0300-\\036f]', '', 'g'))`;
  const terms = search.split(" ").filter(Boolean);
  const filters = terms.map((term) =>
    sql`${searchable} LIKE ${`%${term.replace(/[\\%_]/g, "\\$&")}%`}`);
  return sql`select ${mediaFiles.id} as media_file_id, null::uuid as source_occurrence_id,
      (row_number() over(order by ${mediaFiles.id}) - 1)::int as original_position
    from ${mediaFiles}
    left join ${recordings} on ${recordings.id} = ${mediaFiles.recordingId}
    where ${mediaFiles.availability} = 'verified' ${filters.length ? sql`and ${sql.join(filters, sql` and `)}` : sql``}`;
}

function requireUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new PlaybackQueueError("INVALID_SELECTION", "Queue identifiers must be UUIDs.");
  }
}

async function ownedQueue(db: QueueStore, userId: string, queueId: string, now: Date) {
  const [queue] = await db.select().from(queueSnapshots).where(and(
    eq(queueSnapshots.id, queueId),
    eq(queueSnapshots.userId, userId),
    gt(queueSnapshots.expiresAt, now),
  )).limit(1);
  if (!queue) {
    throw new PlaybackQueueError("NOT_FOUND", "This listening queue expired or belongs to another account.");
  }
  return queue;
}

async function readQueuePage(
  db: QueueStore,
  userId: string,
  queueId: string,
  position: number,
  now: Date,
): Promise<PlaybackQueuePage> {
  const queue = await ownedQueue(db, userId, queueId, now);
  const current = queue.total === 0 ? 0 : Math.max(0, Math.min(position, queue.total - 1));
  const offset = Math.max(0, current - 20);
  const rows = await db.select({
    entry: {
      id: queueEntries.id,
      position: queueEntries.position,
      occurrenceId: queueEntries.sourceOccurrenceId,
    },
    item: {
      id: mediaFiles.id,
      recordingId: mediaFiles.recordingId,
      title,
      artist,
      album,
      version,
      durationMs,
    },
  }).from(queueEntries)
    .innerJoin(mediaFiles, eq(mediaFiles.id, queueEntries.mediaFileId))
    .leftJoin(recordings, eq(recordings.id, mediaFiles.recordingId))
    .where(and(
      eq(queueEntries.queueId, queueId),
      gt(queueEntries.position, offset - 1),
      eq(mediaFiles.availability, "verified"),
    ))
    .orderBy(asc(queueEntries.position), asc(queueEntries.id))
    .limit(100);

  const expected = Math.min(100, Math.max(0, queue.total - offset));
  if (rows.length !== expected || rows.some((row, index) => row.entry.position !== offset + index)) {
    throw new PlaybackQueueError("CONFLICT", "A song in this queue is no longer verified. Select the library items again.");
  }
  return {
    context: {
      id: queueId,
      revision: queue.revision,
      total: queue.total,
      shuffle: queue.shuffled,
      offset,
      position: current,
    },
    items: rows.map(({ entry, item }) => ({
      ...item,
      queueId: entry.id,
      ...(entry.occurrenceId ? { occurrenceId: entry.occurrenceId } : {}),
    })),
  };
}

async function insertEntries(
  db: QueueStore,
  queueId: string,
  selection: PlaybackQueueSelection,
  shuffle: boolean,
  offset: number,
  originalOffset: number,
): Promise<number> {
  const source = sourceFor(selection);
  await db.execute(sql`with source as materialized (${source}),
    ordered as (
      select source.*,
        (row_number() over(order by ${shuffle ? sql`random()` : sql`source.original_position`}) - 1)::int as queue_offset,
        (row_number() over(order by source.original_position) - 1)::int as source_offset
      from source
    )
    insert into playback.queue_entries(queue_id, media_file_id, position, original_position, source_occurrence_id)
    select ${queueId}::uuid, ordered.media_file_id,
      ${offset} + ordered.queue_offset,
      ${originalOffset} + ordered.source_offset,
      ordered.source_occurrence_id
    from ordered`);
  const [count] = await db.select({ total: sql<number>`count(*)::int` })
    .from(queueEntries).where(eq(queueEntries.queueId, queueId));
  return count?.total ?? 0;
}

async function appendEntries(
  db: QueueStore,
  queueId: string,
  selection: PlaybackQueueSelection,
  position: number,
  originalPosition: number,
): Promise<void> {
  const source = sourceFor(selection);
  await db.execute(sql`with source as materialized (${source}),
    ordered as materialized (
      select source.*,
        (row_number() over(order by source.original_position) - 1)::int as source_offset
      from source
    ),
    capacity as materialized (select count(*)::int as total from ordered),
    shifted as (
      update playback.queue_entries set position = position + (select total from capacity)
      where queue_id = ${queueId}::uuid and position >= ${position}
      returning id
    )
    insert into playback.queue_entries(queue_id, media_file_id, position, original_position, source_occurrence_id)
    select ${queueId}::uuid, ordered.media_file_id,
      ${position} + ordered.source_offset,
      ${originalPosition} + ordered.source_offset,
      ordered.source_occurrence_id
    from ordered`);
}

export function createPlaybackQueueRepository(
  db: NodePgDatabase<PlaybackQueueSchema>,
  now: () => Date = () => new Date(),
): PlaybackQueueRepository {
  return {
    async open(userId, input) {
      requireUuid(userId);
      const createdAt = now();
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 782))`);
        await tx.delete(queueSnapshots).where(and(
          eq(queueSnapshots.userId, userId),
          sql`${queueSnapshots.expiresAt} <= ${createdAt}`,
        ));
        const old = await tx.select({ id: queueSnapshots.id }).from(queueSnapshots)
          .where(eq(queueSnapshots.userId, userId))
          .orderBy(desc(queueSnapshots.createdAt), desc(queueSnapshots.id))
          .offset(9);
        if (old.length) {
          await tx.delete(queueSnapshots).where(inArray(queueSnapshots.id, old.map((row) => row.id)));
        }

        const [created] = await tx.insert(queueSnapshots).values({
          userId,
          shuffled: input.shuffle,
          expiresAt: new Date(createdAt.getTime() + 7 * 86_400_000),
        }).returning({ id: queueSnapshots.id });
        if (!created) throw new Error("Queue snapshot was not created.");
        const total = await insertEntries(tx, created.id, input.selection, input.shuffle, 0, 0);
        if (total === 0) {
          throw new PlaybackQueueError("EMPTY_SELECTION", "No verified songs are available for this selection.");
        }
        if (input.selection.source === "items" && total !== input.selection.items.length) {
          throw new PlaybackQueueError("CONFLICT", "One or more selected songs are no longer verified.");
        }
        await tx.update(queueSnapshots).set({ total }).where(eq(queueSnapshots.id, created.id));

        let position = 0;
        if (input.current) {
          const [selected] = await tx.select({ position: queueEntries.position }).from(queueEntries)
            .where(and(
              eq(queueEntries.queueId, created.id),
              eq(queueEntries.mediaFileId, input.current.mediaFileId),
              input.current.occurrenceId
                ? eq(queueEntries.sourceOccurrenceId, input.current.occurrenceId)
                : undefined,
            ))
            .orderBy(asc(queueEntries.position), asc(queueEntries.id))
            .limit(1);
          if (!selected) {
            throw new PlaybackQueueError("CONFLICT", "The current song is no longer in the verified selection.");
          }
          position = selected.position;
        }
        return readQueuePage(tx, userId, created.id, position, createdAt);
      });
    },

    async page(userId, queueId, position) {
      requireUuid(userId);
      requireUuid(queueId);
      if (!Number.isInteger(position) || position < 0 || position > 2_147_483_647) {
        throw new PlaybackQueueError("INVALID_SELECTION", "Queue position must be a nonnegative integer.");
      }
      return readQueuePage(db, userId, queueId, position, now());
    },

    async edit(userId, queueId, input) {
      requireUuid(userId);
      requireUuid(queueId);
      requireUuid(input.currentEntryId);
      if (!Number.isInteger(input.revision) || input.revision < 1) {
        throw new PlaybackQueueError("INVALID_SELECTION", "Queue revision must be a positive integer.");
      }
      return db.transaction(async (tx) => {
        const [locked] = await tx.select({ revision: queueSnapshots.revision }).from(queueSnapshots)
          .where(and(eq(queueSnapshots.id, queueId), eq(queueSnapshots.userId, userId)))
          .for("update");
        const queue = await ownedQueue(tx, userId, queueId, now());
        if (!locked || queue.revision !== input.revision) {
          throw new PlaybackQueueError("CONFLICT", "This queue changed on another device. Reload it before editing.");
        }
        const [current] = await tx.select({
          id: queueEntries.id,
          position: queueEntries.position,
        }).from(queueEntries)
          .innerJoin(mediaFiles, and(
            eq(mediaFiles.id, queueEntries.mediaFileId),
            eq(mediaFiles.availability, "verified"),
          ))
          .where(and(eq(queueEntries.queueId, queueId), eq(queueEntries.id, input.currentEntryId)))
          .limit(1);
        if (!current) {
          throw new PlaybackQueueError("CONFLICT", "The current queue entry is no longer available.");
        }

        let nextPosition = current.position;
        const edit = input.edit;
        if (edit.action === "append") {
          const at = edit.next ? current.position + 1 : queue.total;
          const [last] = await tx.select({
            position: sql<number>`coalesce(max(${queueEntries.originalPosition}), -1)::int`,
          }).from(queueEntries).where(eq(queueEntries.queueId, queueId));
          const before = queue.total;
          await appendEntries(tx, queueId, edit.selection, at, (last?.position ?? -1) + 1);
          const [after] = await tx.select({ total: sql<number>`count(*)::int` })
            .from(queueEntries).where(eq(queueEntries.queueId, queueId));
          if (!after || after.total === before) {
            throw new PlaybackQueueError("EMPTY_SELECTION", "No verified songs are available to add.");
          }
          const expected = edit.selection.source === "items" ? edit.selection.items.length : undefined;
          if (expected !== undefined && after.total - before !== expected) {
            throw new PlaybackQueueError("CONFLICT", "One or more selected songs are no longer verified.");
          }
        } else if (edit.action === "remove") {
          const [removed] = await tx.delete(queueEntries).where(and(
            eq(queueEntries.queueId, queueId),
            eq(queueEntries.id, edit.entryId),
            gt(queueEntries.position, current.position),
          )).returning({ position: queueEntries.position });
          if (!removed) {
            throw new PlaybackQueueError("CONFLICT", "Only an upcoming queue entry can be removed.");
          }
          await tx.update(queueEntries).set({ position: sql`${queueEntries.position} - 1` })
            .where(and(eq(queueEntries.queueId, queueId), gt(queueEntries.position, removed.position)));
        } else if (edit.action === "clear") {
          await tx.delete(queueEntries).where(and(
            eq(queueEntries.queueId, queueId),
            gt(queueEntries.position, current.position),
          ));
        } else if (edit.action === "shuffle") {
          await tx.execute(sql`with ordering as (
            select id,
              (row_number() over(order by ${edit.enabled
                ? sql`case when position <= ${current.position} then 0 else 1 end,
                    case when position <= ${current.position} then position end, random()`
                : sql`original_position`}) - 1)::int as next_position
            from playback.queue_entries where queue_id = ${queueId}::uuid
          )
          update playback.queue_entries entry set position = ordering.next_position
          from ordering where entry.id = ordering.id`);
          await tx.update(queueSnapshots).set({ shuffled: edit.enabled })
            .where(eq(queueSnapshots.id, queueId));
          const [selected] = await tx.select({ position: queueEntries.position }).from(queueEntries)
            .where(eq(queueEntries.id, current.id)).limit(1);
          if (!selected) throw new PlaybackQueueError("CONFLICT", "The current queue entry disappeared.");
          nextPosition = selected.position;
        } else if (edit.action === "move") {
          const targets = await tx.select({
            id: queueEntries.id,
            position: queueEntries.position,
          }).from(queueEntries).where(and(
            eq(queueEntries.queueId, queueId),
            inArray(queueEntries.id, [edit.entryId, edit.before]),
          ));
          const from = targets.find((row) => row.id === edit.entryId);
          const to = targets.find((row) => row.id === edit.before);
          if (!from || !to || from.position <= current.position || to.position <= current.position) {
            throw new PlaybackQueueError("CONFLICT", "Only upcoming queue entries can be moved.");
          }
          if (from.id !== to.id) {
            const destination = from.position < to.position ? to.position - 1 : to.position;
            await tx.execute(sql`update playback.queue_entries set position = case
              when id = ${from.id}::uuid then ${destination}
              when ${from.position} < ${to.position} and position > ${from.position} and position < ${to.position} then position - 1
              when ${from.position} > ${to.position} and position >= ${to.position} and position < ${from.position} then position + 1
              else position end where queue_id = ${queueId}::uuid`);
            await tx.execute(sql`update playback.queue_entries
              set original_position = position where queue_id = ${queueId}::uuid`);
          }
        }

        const [updated] = await tx.select({ total: sql<number>`count(*)::int` })
          .from(queueEntries).where(eq(queueEntries.queueId, queueId));
        if (!updated) throw new Error("Queue entry count was not returned.");
        await tx.update(queueSnapshots).set({
          revision: queue.revision + 1,
          total: updated.total,
          expiresAt: new Date(now().getTime() + 7 * 86_400_000),
        }).where(eq(queueSnapshots.id, queueId));
        return readQueuePage(tx, userId, queueId, Math.max(0, Math.min(nextPosition, updated.total - 1)), now());
      });
    },
  };
}
