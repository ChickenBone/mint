import { users } from "@mint/domain-accounts";
import { mediaFiles } from "@mint/domain-library";
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgSchema, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const playbackSchema = pgSchema("playback");

export const historyPreferences = playbackSchema.table("history_preferences", {
  userId: uuid("user_id").primaryKey(),
  privateSession: boolean("private_session").notNull().default(false),
  historyAfter: timestamp("history_after", { withTimezone: true }),
}, (table) => [
  foreignKey({
    name: "history_preferences_user_fk",
    columns: [table.userId],
    foreignColumns: [users.id],
  }).onDelete("cascade"),
]);

export const listeningHistory = playbackSchema.table("listening_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull(),
  eventId: uuid("event_id").notNull(),
  mediaFileId: uuid("media_file_id").notNull(),
  listenedMs: integer("listened_ms").notNull(),
  completed: boolean("completed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "listening_history_user_fk",
    columns: [table.userId],
    foreignColumns: [users.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "listening_history_media_file_fk",
    columns: [table.mediaFileId],
    foreignColumns: [mediaFiles.id],
  }).onDelete("cascade"),
  unique("listening_history_user_event_uidx").on(table.userId, table.eventId),
  check("listening_history_duration_bounds", sql`${table.listenedMs} BETWEEN 0 AND 86400000`),
  index("listening_history_user_time_idx").on(table.userId, table.createdAt, table.id),
  index("listening_history_media_file_idx").on(table.mediaFileId),
]);

export const queueSnapshots = playbackSchema.table("queue_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull(),
  revision: integer("revision").notNull().default(1),
  shuffled: boolean("shuffled").notNull().default(false),
  total: integer("total").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  foreignKey({
    name: "queue_snapshots_user_fk",
    columns: [table.userId],
    foreignColumns: [users.id],
  }).onDelete("cascade"),
  check("queue_snapshots_revision_positive", sql`${table.revision} > 0`),
  check("queue_snapshots_total_nonnegative", sql`${table.total} >= 0`),
  index("queue_snapshots_user_created_idx").on(table.userId, table.createdAt, table.id),
  index("queue_snapshots_expiry_idx").on(table.expiresAt),
]);

export const queueEntries = playbackSchema.table("queue_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  queueId: uuid("queue_id").notNull(),
  mediaFileId: uuid("media_file_id").notNull(),
  position: integer("position").notNull(),
  originalPosition: integer("original_position").notNull(),
  sourceOccurrenceId: uuid("source_occurrence_id"),
}, (table) => [
  foreignKey({
    name: "queue_entries_queue_fk",
    columns: [table.queueId],
    foreignColumns: [queueSnapshots.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "queue_entries_media_file_fk",
    columns: [table.mediaFileId],
    foreignColumns: [mediaFiles.id],
  }).onDelete("cascade"),
  check("queue_entries_position_nonnegative", sql`${table.position} >= 0`),
  check("queue_entries_original_position_nonnegative", sql`${table.originalPosition} >= 0`),
  index("queue_entries_page_idx").on(table.queueId, table.position, table.id),
  index("queue_entries_media_file_idx").on(table.queueId, table.mediaFileId),
]);
