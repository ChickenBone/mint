CREATE TABLE "platform"."event_streams" (
  "stream" text PRIMARY KEY NOT NULL,
  "last_sequence" bigint NOT NULL DEFAULT 0,
  "replay_floor" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "event_streams_sequence_nonnegative" CHECK ("last_sequence" >= 0),
  CONSTRAINT "event_streams_floor_valid" CHECK ("replay_floor" >= 0 AND "replay_floor" <= "last_sequence")
);
--> statement-breakpoint
CREATE TABLE "platform"."events" (
  "stream" text NOT NULL REFERENCES "platform"."event_streams" ("stream"),
  "sequence" bigint NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("stream", "sequence"),
  CONSTRAINT "events_sequence_positive" CHECK ("sequence" > 0),
  CONSTRAINT "events_payload_bounded" CHECK (octet_length("payload"::text) <= 65536)
);
