ALTER TABLE "library"."media_files"
  ADD COLUMN "availability" text DEFAULT 'unverified' NOT NULL,
  ADD COLUMN "checked_at" timestamp with time zone,
  ADD COLUMN "verified_at" timestamp with time zone,
  ADD COLUMN "unavailable_reason" text,
  ADD COLUMN "audio_stream_index" integer,
  ADD COLUMN "audio_codec" text,
  ADD COLUMN "decoded_sample_frames" integer,
  ADD COLUMN "duration_ms" integer,
  ADD COLUMN "imported_title" text,
  ADD COLUMN "imported_artist" text,
  ADD COLUMN "imported_album" text,
  ADD COLUMN "imported_version" text,
  ADD CONSTRAINT "media_files_availability_valid"
    CHECK ("availability" IN ('unverified', 'verified', 'unavailable')),
  ADD CONSTRAINT "media_files_verification_evidence"
    CHECK ("availability" <> 'verified' OR (
      "checked_at" IS NOT NULL AND "verified_at" IS NOT NULL
      AND "audio_stream_index" IS NOT NULL AND "audio_stream_index" >= 0
      AND "audio_codec" IS NOT NULL AND length(btrim("audio_codec")) > 0
      AND "decoded_sample_frames" IS NOT NULL AND "decoded_sample_frames" > 0
      AND "unavailable_reason" IS NULL
    )),
  ADD CONSTRAINT "media_files_unavailable_reason"
    CHECK (
      ("availability" = 'unavailable' AND "checked_at" IS NOT NULL
        AND "unavailable_reason" IN ('missing', 'unreadable', 'invalid_audio')
        AND "unavailable_reason" IS NOT NULL)
      OR ("availability" <> 'unavailable' AND "unavailable_reason" IS NULL)
    ),
  ADD CONSTRAINT "media_files_duration_positive"
    CHECK ("duration_ms" IS NULL OR "duration_ms" > 0);
--> statement-breakpoint
CREATE INDEX "media_files_verified_id_idx" ON "library"."media_files" USING btree ("id")
  WHERE "availability" = 'verified';
