CREATE SCHEMA "catalog";
--> statement-breakpoint
CREATE TABLE "catalog"."recordings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "version" text,
  "duration_ms" integer,
  "explicit" boolean,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recordings_title_nonempty" CHECK (length(btrim("title")) > 0),
  CONSTRAINT "recordings_duration_positive" CHECK ("duration_ms" IS NULL OR "duration_ms" > 0)
);
--> statement-breakpoint
CREATE INDEX "recordings_title_fts_idx" ON "catalog"."recordings" USING gin (to_tsvector('simple'::regconfig, "title"));
