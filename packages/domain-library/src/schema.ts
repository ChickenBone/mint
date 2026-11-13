import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { recordings } from "@mint/domain-catalog";

export const librarySchema = pgSchema("library");

// Persisted root metadata is not proof of mount access or path safety; validate before filesystem I/O.
export const roots = librarySchema.table(
  "roots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("roots_path_nonempty", sql`length(btrim(${table.path})) > 0`),
  ],
);

export const mediaFiles = librarySchema.table(
  "media_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rootId: uuid("root_id").notNull(),
    relativePath: text("relative_path").notNull(),
    recordingId: uuid("recording_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    availability: text("availability").$type<"unverified" | "verified" | "unavailable">().notNull().default("unverified"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    unavailableReason: text("unavailable_reason").$type<"missing" | "unreadable" | "invalid_audio">(),
    audioStreamIndex: integer("audio_stream_index"),
    audioCodec: text("audio_codec"),
    decodedSampleFrames: integer("decoded_sample_frames"),
    durationMs: integer("duration_ms"),
    importedTitle: text("imported_title"),
    importedArtist: text("imported_artist"),
    importedAlbum: text("imported_album"),
    importedVersion: text("imported_version"),
  },
  (table) => [
    check("media_files_relative_path_nonempty", sql`length(btrim(${table.relativePath})) > 0`),
    check("media_files_availability_valid", sql`${table.availability} IN ('unverified', 'verified', 'unavailable')`),
    check("media_files_verification_evidence", sql`
      ${table.availability} <> 'verified' OR (
        ${table.checkedAt} IS NOT NULL AND ${table.verifiedAt} IS NOT NULL
        AND ${table.audioStreamIndex} IS NOT NULL AND ${table.audioStreamIndex} >= 0
        AND ${table.audioCodec} IS NOT NULL AND length(btrim(${table.audioCodec})) > 0
        AND ${table.decodedSampleFrames} IS NOT NULL AND ${table.decodedSampleFrames} > 0
        AND ${table.unavailableReason} IS NULL
      )`),
    check("media_files_unavailable_reason", sql`
      (${table.availability} = 'unavailable' AND ${table.checkedAt} IS NOT NULL
        AND ${table.unavailableReason} IN ('missing', 'unreadable', 'invalid_audio')
        AND ${table.unavailableReason} IS NOT NULL)
      OR (${table.availability} <> 'unavailable' AND ${table.unavailableReason} IS NULL)`),
    check("media_files_duration_positive", sql`${table.durationMs} IS NULL OR ${table.durationMs} > 0`),
    foreignKey({
      name: "media_files_root_fk",
      columns: [table.rootId],
      foreignColumns: [roots.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "media_files_recording_fk",
      columns: [table.recordingId],
      foreignColumns: [recordings.id],
    }).onDelete("restrict"),
    uniqueIndex("media_files_root_id_relative_path_idx").on(table.rootId, table.relativePath),
    index("media_files_recording_id_idx").on(table.recordingId),
    index("media_files_verified_id_idx").on(table.id).where(sql`${table.availability} = 'verified'`),
  ],
);

// Private local-worker intent/checkpoints, not a listing or playback contract.
export const scanJobs = librarySchema.table("scan_jobs", {
  rootId: uuid("root_id").primaryKey(),
  status: text("status").$type<"pending" | "completed" | "partial" | "blocked" | "failed">().notNull().default("pending"),
  cursor: text("cursor"),
  hadIssues: boolean("had_issues").notNull().default(false),
  failures: integer("failures").notNull().default(0),
  lastResult: jsonb("last_result"),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ name: "scan_jobs_root_fk", columns: [table.rootId], foreignColumns: [roots.id] }).onDelete("restrict"),
  check("scan_jobs_status_check", sql`${table.status} IN ('pending', 'completed', 'partial', 'blocked', 'failed')`),
  check("scan_jobs_cursor_check", sql`${table.cursor} IS NULL OR octet_length(${table.cursor}) BETWEEN 1 AND 1048576`),
  check("scan_jobs_failures_check", sql`${table.failures} BETWEEN 0 AND 5`),
  check("scan_jobs_last_error_check", sql`${table.lastError} IN ('cursor-rejected', 'root-unavailable', 'no-progress', 'scan-failed')`),
  check("scan_jobs_terminal_cursor", sql`${table.status} NOT IN ('completed', 'partial') OR ${table.cursor} IS NULL`),
]);
