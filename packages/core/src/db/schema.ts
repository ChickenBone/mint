import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  jsonb,
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
export const workerStatusEnum = pgEnum("worker_status", ["pending", "active", "disabled"]);

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

/** Volunteer download workers. Each authenticates with a bearer token whose sha256 is stored here. */
export const workers = pgTable(
  "workers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** First characters of the token, shown so owners can tell tokens apart. */
    tokenHint: text("token_hint").notNull(),
    status: workerStatusEnum("status").notNull().default("pending"),
    version: text("version"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastIp: text("last_ip"),
    activeJobs: integer("active_jobs").notNull().default(0),
    completed: integer("completed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("workers_token_idx").on(t.tokenHash), index("workers_user_idx").on(t.userId)],
);

export const tracks = pgTable(
  "tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    youtubeVideoId: text("youtube_video_id"),
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
    existingLibraryKey: text("existing_library_key"),
    existingFilePath: text("existing_file_path"),
    existingCodec: text("existing_codec"),
    existingDurationSec: integer("existing_duration_sec"),
    existingSonicAnalyzed: boolean("existing_sonic_analyzed").notNull().default(false),
    libraryMatchKey: text("library_match_key"),
    upgradeAttempted: boolean("upgrade_attempted").notNull().default(false),
    sonicAnalyzed: boolean("sonic_analyzed").notNull().default(false),
    /** Remote cover art (Cover Art Archive or YouTube thumbnail); also embedded into the file. */
    artworkUrl: text("artwork_url"),
    stage: stageEnum("stage").notNull().default("queued"),
    progress: real("progress").notNull().default(0),
    detail: text("detail"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    /** Volunteer worker that delivered the audio, if any. */
    workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
    /** Set while the track sits in the remote pool waiting for (or leased to) a volunteer worker. */
    remoteAt: timestamp("remote_at", { withTimezone: true }),
    leaseId: text("lease_id"),
    leaseWorkerId: uuid("lease_worker_id").references(() => workers.id, { onDelete: "set null" }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    remoteFailures: integer("remote_failures").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tracks_video_idx").on(t.youtubeVideoId),
    uniqueIndex("tracks_existing_library_idx").on(t.existingLibraryKey),
    index("tracks_library_match_idx").on(t.libraryMatchKey),
    index("tracks_remote_idx").on(t.remoteAt).where(sql`${t.remoteAt} is not null`),
    index("tracks_stage_idx").on(t.stage),
    index("tracks_ready_idx").on(t.readyAt),
    index("tracks_artist_idx").on(t.artist),
    index("tracks_chart_identity_idx").on(sql`mint_search_text(${t.artist})`, sql`mint_search_text(${t.title})`),
    index("tracks_recording_idx").on(t.mbRecordingId).where(sql`${t.mbRecordingId} is not null`),
  ],
);

export const artistMetadata = pgTable(
  "artist_metadata",
  {
    artistName: text("artist_name").primaryKey(),
    musicBrainzArtistId: text("musicbrainz_artist_id"),
    status: text("status").$type<"queued" | "fetching" | "ready" | "not_found" | "ambiguous" | "failed">().notNull().default("queued"),
    profile: jsonb("profile").$type<{
      artistType: string | null;
      area: string | null;
      biography: string | null;
      biographyUrl: string | null;
      relatedArtists: Array<{ name: string; musicBrainzArtistId: string; source: "listenbrainz" | "musicbrainz" }>;
      listenCount: number | null;
      listenerCount: number | null;
      unavailableSources: string[];
    } | null>(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("artist_metadata_status_idx").on(t.status, t.nextAttemptAt),
    index("artist_metadata_mbid_idx").on(t.musicBrainzArtistId),
  ],
);

export const chartEntryLinks = pgTable("chart_entry_links", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  entryId: text("entry_id").notNull(),
  identity: text("identity").notNull(),
  trackId: uuid("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.userId, t.provider, t.entryId] })]);

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
    origin: text("origin").notNull().default("youtube"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.trackId] }), index("user_tracks_track_idx").on(t.trackId)],
);

export const trackVideos = pgTable("track_videos", {
  videoId: text("video_id").primaryKey(),
  trackId: uuid("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
});

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

/** Member-submitted problem reports, reviewed by admins in the admin portal. */
export const issueReports = pgTable(
  "issue_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").$type<"playback" | "lyrics" | "music-info" | "app" | "other">().notNull(),
    message: text("message").notNull(),
    /** Optional human-readable context the member saw and chose to send, e.g. "Song — Artist". */
    context: text("context"),
    status: text("status").$type<"open" | "resolved">().notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("issue_reports_status_idx").on(t.status, t.createdAt),
    index("issue_reports_user_idx").on(t.userId, t.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type Track = typeof tracks.$inferSelect;
export type Playlist = typeof playlists.$inferSelect;
export type YoutubeAccount = typeof youtubeAccounts.$inferSelect;
export type Worker = typeof workers.$inferSelect;
export type IssueReport = typeof issueReports.$inferSelect;
