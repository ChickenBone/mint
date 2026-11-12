ALTER TABLE "tracks" ADD COLUMN "source_choices" jsonb;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "blocked_video_ids" text[] DEFAULT '{}'::text[] NOT NULL;