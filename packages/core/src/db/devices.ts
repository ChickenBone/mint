import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { DeviceCommand, DeviceState } from "../devices";
import { sessions, users } from "./schema";

export const connectedDevices = pgTable("connected_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  authSessionId: text("auth_session_id").references(() => sessions.id, { onDelete: "set null" }),
  kind: text("kind").$type<"web" | "native">().notNull().default("web"),
  installationId: uuid("installation_id"),
  tokenHash: text("token_hash").notNull(),
  name: text("name").notNull(),
  state: jsonb("state").$type<DeviceState>().notNull(),
  sequence: integer("sequence").notNull().default(0),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("connected_devices_user_idx").on(t.userId),
  uniqueIndex("connected_devices_installation_idx").on(t.userId, t.installationId)]);

export const deviceCommands = pgTable("device_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: uuid("device_id").notNull().references(() => connectedDevices.id, { onDelete: "cascade" }),
  sourceDeviceId: uuid("source_device_id").references(() => connectedDevices.id, { onDelete: "set null" }),
  actorId: uuid("actor_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  actorSessionId: text("actor_session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  command: jsonb("command").$type<DeviceCommand>().notNull(),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("device_commands_sequence_idx").on(t.deviceId, t.sequence),
  index("device_commands_pending_idx").on(t.deviceId, t.status),
]);

export const partySessions = pgTable("party_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => connectedDevices.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  queue: jsonb("queue").$type<string[]>().notNull().default([]),
  revision: integer("revision").notNull().default(0),
  appliedRevision: integer("applied_revision"),
  guestsCanEdit: boolean("guests_can_edit").notNull().default(false),
  inviteHash: text("invite_hash"),
  inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("party_sessions_host_idx").on(t.hostId)]);

export const partyParticipants = pgTable("party_participants", {
  id: uuid("id").primaryKey().defaultRandom(),
  partyId: uuid("party_id").notNull().references(() => partySessions.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("party_participants_member_idx").on(t.partyId, t.userId)]);
