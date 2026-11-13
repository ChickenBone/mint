import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const catalogSchema = pgSchema("catalog");

export const recordings = catalogSchema.table(
  "recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    version: text("version"),
    durationMs: integer("duration_ms"),
    explicit: boolean("explicit"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("recordings_title_nonempty", sql`length(btrim(${table.title})) > 0`),
    check("recordings_duration_positive", sql`${table.durationMs} IS NULL OR ${table.durationMs} > 0`),
    index("recordings_title_fts_idx").using("gin", sql`to_tsvector('simple'::regconfig, ${table.title})`),
  ],
);
