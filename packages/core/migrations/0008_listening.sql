CREATE TABLE "lyric_matches" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "track_id" uuid NOT NULL REFERENCES "tracks"("id") ON DELETE CASCADE,
  "lyrics" jsonb,
  "offset_ms" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "track_id"),
  CONSTRAINT "lyric_offset_bounds" CHECK ("offset_ms" BETWEEN -30000 AND 30000)
);
