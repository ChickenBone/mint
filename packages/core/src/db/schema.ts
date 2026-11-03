import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { SOURCES, STAGES } from "../stages";

export const roleEnum = pgEnum("role", ["user", "admin"]);
export const userStatusEnum = pgEnum("user_status", ["pending", "active", "denied", "disabled"]);
export const stageEnum = pgEnum("stage", STAGES);
export const sourceEnum = pgEnum("source", SOURCES);
export const syncStatusEnum = pgEnum("sync_status", ["idle", "syncing", "error"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: roleEnum("role").notNull().default("user"),
    status: userStatusEnum("status").notNull().default("pending"),
    requestNote: text("request_note"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_email_idx").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 of the opaque cookie token; the raw token is never stored. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const youtubeAccounts = pgTable("youtube_accounts", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  googleSub: text("google_sub").notNull(),
  email: text("email"),
  channelTitle: text("channel_title"),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scope: text("scope").notNull(),
  musicOnly: boolean("music_only").notNull().default(true),
  autoSync: boolean("auto_sync").notNull().default(true),
  plexPlaylistKey: text("plex_playlist_key"),
  syncStatus: syncStatusEnum("sync_status").notNull().default("idle"),
  syncError: text("sync_error"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  ...timestamps,
});

export const tracks = pgTable(
  "tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    youtubeVideoId: text("youtube_video_id").notNull(),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    album: text("album"),
    year: integer("year"),
    durationSec: integer("duration_sec"),
    mbRecordingId: text("mb_recording_id"),
    mbReleaseGroupId: text("mb_release_group_id"),
    mbArtistId: text("mb_artist_id"),
    source: sourceEnum("source"),
    filePath: text("file_path"),
    bytes: bigint("bytes", { mode: "number" }),
    codec: text("codec"),
    plexRatingKey: text("plex_rating_key"),
    sonicAnalyzed: boolean("sonic_analyzed").notNull().default(false),
    hasPreview: boolean("has_preview").notNull().default(false),
    hasArtwork: boolean("has_artwork").notNull().default(false),
    stage: stageEnum("stage").notNull().default("queued"),
    progress: real("progress").notNull().default(0),
    detail: text("detail"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tracks_video_idx").on(t.youtubeVideoId),
    index("tracks_stage_idx").on(t.stage),
    index("tracks_ready_idx").on(t.readyAt),
    index("tracks_artist_idx").on(t.artist),
  ],
);

export const userTracks = pgTable(
  "user_tracks",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    likedAt: timestamp("liked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.trackId] }), index("user_tracks_track_idx").on(t.trackId)],
);

export const playlists = pgTable(
  "playlists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    youtubePlaylistId: text("youtube_playlist_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    artworkUrl: text("artwork_url"),
    itemCount: integer("item_count").notNull().default(0),
    syncEnabled: boolean("sync_enabled").notNull().default(false),
    plexPlaylistKey: text("plex_playlist_key"),
    ...timestamps,
  },
  (t) => [uniqueIndex("playlists_user_yt_idx").on(t.userId, t.youtubePlaylistId)],
);

export const playlistTracks = pgTable(
  "playlist_tracks",
  {
    playlistId: uuid("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.playlistId, t.trackId] })],
);

/** Append-only audit of stage transitions; drives the activity feed and per-track timelines. */
export const trackEvents = pgTable(
  "track_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    stage: stageEnum("stage").notNull(),
    message: text("message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("track_events_track_idx").on(t.trackId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Track = typeof tracks.$inferSelect;
export type Playlist = typeof playlists.$inferSelect;
export type YoutubeAccount = typeof youtubeAccounts.$inferSelect;
