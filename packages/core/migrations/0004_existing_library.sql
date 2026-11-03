ALTER TABLE "tracks" ALTER COLUMN "youtube_video_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "existing_library_key" text;
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "existing_file_path" text;
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "existing_codec" text;
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "existing_duration_sec" integer;
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "existing_sonic_analyzed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "library_match_key" text;
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "upgrade_attempted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_existing_library_idx" ON "tracks" ("existing_library_key");
--> statement-breakpoint
CREATE INDEX "tracks_library_match_idx" ON "tracks" ("library_match_key");
--> statement-breakpoint
CREATE TABLE "track_videos" (
  "video_id" text PRIMARY KEY NOT NULL,
  "track_id" uuid NOT NULL,
  CONSTRAINT "track_videos_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "tracks" ("id") ON DELETE CASCADE
);
