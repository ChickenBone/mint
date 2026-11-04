import { boolean, index, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { tracks, users } from "./schema";

export const playbackQueues = pgTable("playback_queues", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(1),
  shuffled: boolean("shuffled").notNull().default(false),
  total: integer("total").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [index("playback_queues_user_idx").on(table.userId, table.createdAt), index("playback_queues_expiry_idx").on(table.expiresAt)]);
export const playbackQueueEntries = pgTable("playback_queue_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  queueId: uuid("queue_id").notNull().references(() => playbackQueues.id, { onDelete: "cascade" }),
  trackId: uuid("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  originalPosition: integer("original_position").notNull(),
  sourceOccurrenceId: uuid("source_occurrence_id"),
}, (table) => [index("playback_queue_entries_page_idx").on(table.queueId, table.position, table.id), index("playback_queue_entries_track_idx").on(table.queueId, table.trackId)]);
