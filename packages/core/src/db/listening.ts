import { integer, jsonb, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { tracks, users } from "./schema";

export const lyricMatches = pgTable("lyric_matches", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  trackId: uuid("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
  lyrics: jsonb("lyrics").$type<{ id: number; instrumental: boolean; plainLyrics: string | null; syncedLyrics: string | null }>(),
  offsetMs: integer("offset_ms").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.userId, table.trackId] })]);
