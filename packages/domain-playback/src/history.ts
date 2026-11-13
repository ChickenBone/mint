import {
  type ListeningHistoryDeleteInput, type ListeningHistoryListInput,
  type ListeningHistoryPage, type ListeningHistoryRecord,
} from "@mint/contracts";
import { recordings } from "@mint/domain-catalog";
import { mediaFiles } from "@mint/domain-library";
import { users } from "@mint/domain-accounts";
import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { historyPreferences, listeningHistory } from "./schema";
import { acceptsListeningEvent } from "./history-policy";

export class ListeningHistoryMediaUnavailableError extends Error {
  constructor() {
    super("Playable song not found.");
    this.name = "ListeningHistoryMediaUnavailableError";
  }
}

export interface ListeningHistoryRepository {
  record(userId: string, input: ListeningHistoryRecord): Promise<{ recorded: boolean }>;
  list(userId: string, input?: ListeningHistoryListInput): Promise<ListeningHistoryPage>;
  delete(userId: string, input?: ListeningHistoryDeleteInput): Promise<void>;
  privateSession(userId: string): Promise<boolean>;
  setPrivateSession(userId: string, privateSession: boolean): Promise<void>;
}

const filename = sql<string>`regexp_replace(${mediaFiles.relativePath}, '^.*/', '')`;
const displayTitle = sql<string>`coalesce(
  nullif(btrim(${mediaFiles.importedTitle}), ''),
  nullif(btrim(${recordings.title}), ''),
  nullif(${filename}, ''),
  'Unknown title'
)`;
const displayArtist = sql<string>`coalesce(nullif(btrim(${mediaFiles.importedArtist}), ''), 'Unknown artist')`;
const displayAlbum = sql<string>`coalesce(nullif(btrim(${mediaFiles.importedAlbum}), ''), 'Unknown album')`;
const displayVersion = sql<string | null>`coalesce(
  nullif(btrim(${mediaFiles.importedVersion}), ''),
  nullif(btrim(${recordings.version}), '')
)`;
const displayDuration = sql<number | null>`coalesce(${mediaFiles.durationMs}, ${recordings.durationMs})`;

export function createListeningHistoryRepository(
  db: NodePgDatabase<{
    historyPreferences: typeof historyPreferences;
    listeningHistory: typeof listeningHistory;
    mediaFiles: typeof mediaFiles;
    recordings: typeof recordings;
    users: typeof users;
  }>,
  now: () => Date = () => new Date(),
): ListeningHistoryRepository {
  return {
    async record(userId, input) {
      return db.transaction(async (tx) => {
        await tx.insert(historyPreferences).values({ userId }).onConflictDoNothing();
        const [pref] = await tx.select({
          privateSession: historyPreferences.privateSession,
          historyAfter: historyPreferences.historyAfter,
        }).from(historyPreferences)
          .where(eq(historyPreferences.userId, userId))
          .for("update");
        if (!acceptsListeningEvent({
          privateSession: pref?.privateSession ?? false,
          listenedMs: input.listenedMs,
          startedAt: input.startedAt,
          historyAfter: pref?.historyAfter ?? null,
          now: now(),
        })) {
          return { recorded: false };
        }
        const [file] = await tx.select({ durationMs: displayDuration })
          .from(mediaFiles)
          .leftJoin(recordings, eq(recordings.id, mediaFiles.recordingId))
          .where(and(eq(mediaFiles.id, input.mediaFileId), eq(mediaFiles.availability, "verified")))
          .limit(1);
        if (!file) throw new ListeningHistoryMediaUnavailableError();
        const durationMs = file.durationMs ?? 86_400_000;
        const inserted = await tx.insert(listeningHistory).values({
          userId,
          eventId: input.eventId,
          mediaFileId: input.mediaFileId,
          listenedMs: Math.min(input.listenedMs, durationMs),
          completed: input.completed && input.listenedMs >= durationMs * 0.8,
        }).onConflictDoNothing({
          target: [listeningHistory.userId, listeningHistory.eventId],
        }).returning({ id: listeningHistory.id });
        return { recorded: inserted.length > 0 };
      });
    },
    async list(userId, input = {}) {
      const page = input.page ?? 0;
      const rows = await db.select({
        event: {
          id: listeningHistory.id,
          createdAt: listeningHistory.createdAt,
          listenedMs: listeningHistory.listenedMs,
          completed: listeningHistory.completed,
        },
        track: {
          id: mediaFiles.id,
          recordingId: mediaFiles.recordingId,
          title: displayTitle,
          artist: displayArtist,
          album: displayAlbum,
          version: displayVersion,
          durationMs: displayDuration,
        },
      }).from(listeningHistory)
        .innerJoin(mediaFiles, eq(mediaFiles.id, listeningHistory.mediaFileId))
        .leftJoin(recordings, eq(recordings.id, mediaFiles.recordingId))
        .where(eq(listeningHistory.userId, userId))
        .orderBy(desc(listeningHistory.createdAt), desc(listeningHistory.id))
        .limit(101)
        .offset(page * 100);
      return {
        entries: rows.map((row) => ({
          event: { ...row.event, createdAt: row.event.createdAt.toISOString() },
          track: row.track,
        })),
      };
    },
    async delete(userId, input) {
      await db.transaction(async (tx) => {
        const boundary = now();
        await tx.insert(historyPreferences).values({ userId, historyAfter: boundary })
          .onConflictDoUpdate({
            target: historyPreferences.userId,
            set: { historyAfter: boundary },
          });
        await tx.delete(listeningHistory).where(and(
          eq(listeningHistory.userId, userId),
          input?.entryId ? eq(listeningHistory.id, input.entryId) : undefined,
        ));
      });
    },
    async privateSession(userId) {
      const [pref] = await db.select({ privateSession: historyPreferences.privateSession })
        .from(historyPreferences)
        .where(eq(historyPreferences.userId, userId))
        .limit(1);
      return pref?.privateSession ?? false;
    },
    async setPrivateSession(userId, privateSession) {
      const boundary = now();
      await db.insert(historyPreferences).values({ userId, privateSession, historyAfter: boundary })
        .onConflictDoUpdate({
          target: historyPreferences.userId,
          set: { privateSession, historyAfter: boundary },
        });
    },
  };
}
