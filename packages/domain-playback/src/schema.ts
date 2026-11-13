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
