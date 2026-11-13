import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, foreignKey, integer, primaryKey, smallint, text, timestamp, uuid,
} from "drizzle-orm/pg-core";
import { catalogSchema } from "./schema";

export const listenbrainzSeedIngestions = catalogSchema.table("listenbrainz_seed_ingestions", {
  seedKey: text("seed_key").primaryKey(),
  payloadVersion: smallint("payload_version").notNull().default(1),
  parserVersion: smallint("parser_version").notNull().default(1),
  origin: text("origin").notNull().default("listenbrainz"),
  identifierProvider: text("identifier_provider").notNull().default("musicbrainz"),
  country: text("country").notNull().default("global"),
  sourceUrl: text("source_url").notNull().default(
    "https://api.listenbrainz.org/1/stats/sitewide/recordings?range=week&count=100&offset=0",
  ),
  state: text("state").notNull().default("pending"),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull().defaultNow(),
  paused: boolean("paused").notNull().default(false),
  lastError: text("last_error"),
  periodFrom: timestamp("period_from", { withTimezone: true }),
  periodTo: timestamp("period_to", { withTimezone: true }),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  outcome: text("outcome"),
  received: integer("received").notNull().default(0),
  persisted: integer("persisted").notNull().default(0),
  missingIdentifiers: integer("missing_identifiers").notNull().default(0),
  contentHash: text("content_hash"),
}, (table) => [
  check("lb_seed_scope", sql`${table.seedKey} = 'catalog:startup:lb-chart:global' AND
    ${table.payloadVersion} = 1 AND ${table.parserVersion} = 1 AND
    ${table.origin} = 'listenbrainz' AND ${table.identifierProvider} = 'musicbrainz' AND
    ${table.country} = 'global' AND ${table.sourceUrl} =
    'https://api.listenbrainz.org/1/stats/sitewide/recordings?range=week&count=100&offset=0'`),
  check("lb_seed_state", sql`${table.state} IN ('pending', 'running', 'retry_wait', 'completed')`),
  check("lb_seed_lease", sql`(${table.leaseToken} IS NULL) = (${table.leaseUntil} IS NULL) AND
    (${table.state} = 'running') = (${table.leaseToken} IS NOT NULL)`),
  check("lb_seed_counts", sql`${table.attempts} >= 0 AND ${table.received} BETWEEN 0 AND 100 AND
    ${table.persisted} BETWEEN 0 AND 100 AND ${table.missingIdentifiers} BETWEEN 0 AND 100 AND
    ${table.received} = ${table.persisted} + ${table.missingIdentifiers}`),
  check("lb_seed_error", sql`${table.lastError} IS NULL OR
    ${table.lastError} IN ('source_unavailable', 'invalid_source', 'aborted')`),
  check("lb_seed_completion", sql`(${table.state} = 'completed') = (${table.completedAt} IS NOT NULL) AND
    (${table.state} <> 'completed' OR (${table.periodFrom} IS NOT NULL AND ${table.periodTo} IS NOT NULL AND
    ${table.periodFrom} < ${table.periodTo} AND ${table.sourceUpdatedAt} IS NOT NULL AND
    ${table.sourceUpdatedAt} >= ${table.periodFrom} AND ${table.fetchedAt} IS NOT NULL AND
    ${table.contentHash} IS NOT NULL AND ${table.lastError} IS NULL AND ${table.outcome} IS NOT NULL))`),
  check("lb_seed_hash", sql`${table.contentHash} IS NULL OR ${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  check("lb_seed_outcome", sql`${table.outcome} IS NULL OR
    (${table.outcome} = 'observations' AND ${table.persisted} > 0) OR
    (${table.outcome} = 'empty_feed' AND ${table.received} = 0) OR
    (${table.outcome} = 'no_identified_recordings' AND ${table.received} > 0 AND ${table.persisted} = 0)`),
]);

export const listenbrainzSeedObservations = catalogSchema.table("listenbrainz_seed_observations", {
  seedKey: text("seed_key").notNull(),
  position: smallint("position").notNull(),
  recordingMbid: uuid("recording_mbid").notNull(),
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  release: text("release"),
  artistMbids: uuid("artist_mbids").array().notNull().default(sql`'{}'`),
  listenCount: bigint("listen_count", { mode: "number" }).notNull(),
}, (table) => [
  primaryKey({ name: "lb_seed_observations_pk", columns: [table.seedKey, table.position] }),
  foreignKey({
    name: "lb_seed_observations_run_fk",
    columns: [table.seedKey],
    foreignColumns: [listenbrainzSeedIngestions.seedKey],
  }).onDelete("restrict"),
  check("lb_seed_observations_position", sql`${table.position} BETWEEN 1 AND 100`),
  check("lb_seed_observations_text", sql`length(btrim(${table.title})) BETWEEN 1 AND 500 AND
    length(btrim(${table.artist})) BETWEEN 1 AND 500 AND
    (${table.release} IS NULL OR length(btrim(${table.release})) BETWEEN 1 AND 500)`),
  check("lb_seed_observations_artists", sql`cardinality(${table.artistMbids}) <= 100 AND
    (array_ndims(${table.artistMbids}) IS NULL OR array_ndims(${table.artistMbids}) = 1) AND
    array_position(${table.artistMbids}, NULL) IS NULL`),
  check("lb_seed_observations_count", sql`${table.listenCount} BETWEEN 0 AND 9007199254740991`),
]);
