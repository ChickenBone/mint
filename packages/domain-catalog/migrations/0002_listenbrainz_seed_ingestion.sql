CREATE TABLE "catalog"."listenbrainz_seed_ingestions" (
  "seed_key" text PRIMARY KEY NOT NULL,
  "payload_version" smallint DEFAULT 1 NOT NULL,
  "parser_version" smallint DEFAULT 1 NOT NULL,
  "origin" text DEFAULT 'listenbrainz' NOT NULL,
  "identifier_provider" text DEFAULT 'musicbrainz' NOT NULL,
  "country" text DEFAULT 'global' NOT NULL,
  "source_url" text DEFAULT 'https://api.listenbrainz.org/1/stats/sitewide/recordings?range=week&count=100&offset=0' NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "lease_token" uuid,
  "lease_until" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "not_before" timestamp with time zone DEFAULT now() NOT NULL,
  "paused" boolean DEFAULT false NOT NULL,
  "last_error" text,
  "period_from" timestamp with time zone,
  "period_to" timestamp with time zone,
  "source_updated_at" timestamp with time zone,
  "fetched_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "outcome" text,
  "received" integer DEFAULT 0 NOT NULL,
  "persisted" integer DEFAULT 0 NOT NULL,
  "missing_identifiers" integer DEFAULT 0 NOT NULL,
  "content_hash" text,
  CONSTRAINT "lb_seed_scope" CHECK (
    "seed_key" = 'catalog:startup:lb-chart:global' AND
    "payload_version" = 1 AND "parser_version" = 1 AND
    "origin" = 'listenbrainz' AND "identifier_provider" = 'musicbrainz' AND "country" = 'global' AND
    "source_url" = 'https://api.listenbrainz.org/1/stats/sitewide/recordings?range=week&count=100&offset=0'
  ),
  CONSTRAINT "lb_seed_state" CHECK ("state" IN ('pending', 'running', 'retry_wait', 'completed')),
  CONSTRAINT "lb_seed_lease" CHECK (
    ("lease_token" IS NULL) = ("lease_until" IS NULL) AND
    ("state" = 'running') = ("lease_token" IS NOT NULL)
  ),
  CONSTRAINT "lb_seed_counts" CHECK (
    "attempts" >= 0 AND "received" BETWEEN 0 AND 100 AND "persisted" BETWEEN 0 AND 100 AND
    "missing_identifiers" BETWEEN 0 AND 100 AND "received" = "persisted" + "missing_identifiers"
  ),
  CONSTRAINT "lb_seed_error" CHECK (
    "last_error" IS NULL OR "last_error" IN ('source_unavailable', 'invalid_source', 'aborted')
  ),
  CONSTRAINT "lb_seed_completion" CHECK (
    ("state" = 'completed') = ("completed_at" IS NOT NULL) AND
    ("state" <> 'completed' OR (
      "period_from" IS NOT NULL AND "period_to" IS NOT NULL AND "period_from" < "period_to" AND
      "source_updated_at" IS NOT NULL AND "source_updated_at" >= "period_from" AND
      "fetched_at" IS NOT NULL AND "content_hash" IS NOT NULL AND "last_error" IS NULL AND
      "outcome" IS NOT NULL
    ))
  ),
  CONSTRAINT "lb_seed_hash" CHECK ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "lb_seed_outcome" CHECK (
    "outcome" IS NULL OR
    ("outcome" = 'observations' AND "persisted" > 0) OR
    ("outcome" = 'empty_feed' AND "received" = 0) OR
    ("outcome" = 'no_identified_recordings' AND "received" > 0 AND "persisted" = 0)
  )
);
--> statement-breakpoint
CREATE TABLE "catalog"."listenbrainz_seed_observations" (
  "seed_key" text NOT NULL,
  "position" smallint NOT NULL,
  "recording_mbid" uuid NOT NULL,
  "title" text NOT NULL,
  "artist" text NOT NULL,
  "release" text,
  "artist_mbids" uuid[] DEFAULT '{}' NOT NULL,
  "listen_count" bigint NOT NULL,
  CONSTRAINT "lb_seed_observations_pk" PRIMARY KEY ("seed_key", "position"),
  CONSTRAINT "lb_seed_observations_run_fk" FOREIGN KEY ("seed_key")
    REFERENCES "catalog"."listenbrainz_seed_ingestions" ("seed_key") ON DELETE RESTRICT,
  CONSTRAINT "lb_seed_observations_position" CHECK ("position" BETWEEN 1 AND 100),
  CONSTRAINT "lb_seed_observations_text" CHECK (
    length(btrim("title")) BETWEEN 1 AND 500 AND length(btrim("artist")) BETWEEN 1 AND 500 AND
    ("release" IS NULL OR length(btrim("release")) BETWEEN 1 AND 500)
  ),
  CONSTRAINT "lb_seed_observations_artists" CHECK (
    cardinality("artist_mbids") <= 100 AND
    (array_ndims("artist_mbids") IS NULL OR array_ndims("artist_mbids") = 1) AND
    array_position("artist_mbids", NULL) IS NULL
  ),
  CONSTRAINT "lb_seed_observations_count" CHECK ("listen_count" BETWEEN 0 AND 9007199254740991)
);
