import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sessions, tracks, users } from "./schema";

export const spotifyAccounts = pgTable("spotify_accounts", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  providerAccountId: text("provider_account_id"),
  displayName: text("display_name").notNull(),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scope: text("scope").notNull(),
  autoSync: boolean("auto_sync").notNull().default(true),
  status: text("status").notNull().default("idle"),
  error: text("error"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  nextSyncAt: timestamp("next_sync_at", { withTimezone: true }).notNull().defaultNow(),
});

export const spotifyOauthStates = pgTable("spotify_oauth_states", {
  hash: text("hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionHash: text("session_hash").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  verifierEnc: text("verifier_enc").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const spotifyPlaylists = pgTable("spotify_playlists", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => spotifyAccounts.userId, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  providerUrl: text("provider_url").notNull(),
  ownerName: text("owner_name"),
  syncEnabled: boolean("sync_enabled").notNull().default(false),
  snapshotId: text("snapshot_id"),
  sourceTotal: integer("source_total").notNull().default(0),
  matchedTotal: integer("matched_total").notNull().default(0),
  status: text("status").notNull().default("not_synced"),
  error: text("error"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
}, (t) => [uniqueIndex("spotify_playlists_source_idx").on(t.userId, t.providerId)]);

export type SpotifyMatchStatus = "matched" | "missing" | "unavailable" | "ambiguous";
export const spotifyEntries = pgTable("spotify_entries", {
  id: uuid("id").primaryKey(),
  playlistId: uuid("playlist_id").notNull().references(() => spotifyPlaylists.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  providerId: text("provider_id"),
  providerUri: text("provider_uri"),
  title: text("title").notNull(),
  artists: jsonb("artists").$type<string[]>().notNull(),
  album: text("album"),
  durationMs: integer("duration_ms"),
  isrc: text("isrc"),
  addedAt: text("added_at"),
  addedBy: text("added_by"),
  status: text("status").$type<SpotifyMatchStatus>().notNull(),
  reason: text("reason").notNull(),
  trackId: uuid("track_id").references(() => tracks.id, { onDelete: "set null" }),
}, (t) => [uniqueIndex("spotify_entries_order_idx").on(t.playlistId, t.position), index("spotify_entries_track_idx").on(t.trackId)]);
