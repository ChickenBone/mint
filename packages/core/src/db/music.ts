import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tracks, users } from "./schema";
import type { SmartRules } from "../music";

export const musicCollections = pgTable("music_collections", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(), description: text("description").notNull().default(""),
  artworkUrl: text("artwork_url"), rules: jsonb("rules").$type<SmartRules>(),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const musicEntries = pgTable("music_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  collectionId: uuid("collection_id").notNull().references(() => musicCollections.id, { onDelete: "cascade" }),
  trackId: uuid("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
}, (t) => [index("music_entries_order_idx").on(t.collectionId, t.position)]);
export const musicMembers = pgTable("music_members", {
  collectionId: uuid("collection_id").notNull().references(() => musicCollections.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accepted: boolean("accepted").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.collectionId, t.userId] })]);
export const musicFolders = pgTable("music_folders", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
});
export const musicOrganization = pgTable("music_organization", {
  collectionId: uuid("collection_id").notNull().references(() => musicCollections.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  folderId: uuid("folder_id").references(() => musicFolders.id, { onDelete: "set null" }),
  pinned: boolean("pinned").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.collectionId, t.userId] })]);
export const musicLikes = pgTable("music_likes", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  trackId: uuid("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.trackId] })]);
export const musicPreferences = pgTable("music_preferences", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  privateSession: boolean("private_session").notNull().default(false),
  historyAfter: timestamp("history_after", { withTimezone: true }),
});
export const musicHistory = pgTable("music_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  trackId: uuid("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
  listenedMs: integer("listened_ms").notNull(), completed: boolean("completed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("music_history_user_time_idx").on(t.userId, t.createdAt)]);
export const musicExclusions = pgTable("music_exclusions", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  trackId: uuid("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.userId, t.trackId] })]);
