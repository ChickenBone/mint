ALTER TABLE "track_analysis" ALTER COLUMN "version" SET DEFAULT 2;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "track_analysis_version_status_idx" ON "track_analysis" ("version", "status");
--> statement-breakpoint
ALTER TABLE "analysis_workers" ADD COLUMN IF NOT EXISTS "completed_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "analysis_workers" ADD COLUMN IF NOT EXISTS "failed_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "analysis_workers" ADD COLUMN IF NOT EXISTS "avg_duration_ms" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "analysis_workers" ADD COLUMN IF NOT EXISTS "active_track_id" uuid REFERENCES "public"."tracks"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "analysis_workers" ADD COLUMN IF NOT EXISTS "engine_version" text DEFAULT 'mint-dsp-v2' NOT NULL;
--> statement-breakpoint
ALTER TABLE "analysis_workers" ADD COLUMN IF NOT EXISTS "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "analysis_workers" ADD COLUMN IF NOT EXISTS "last_error" text;
