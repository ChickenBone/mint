ALTER TABLE "track_events" ALTER COLUMN "stage" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "tracks" ALTER COLUMN "stage" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "tracks" ALTER COLUMN "stage" SET DEFAULT 'queued'::text;--> statement-breakpoint
UPDATE "track_events" SET "stage" = 'scanning' WHERE "stage" = 'previewing';--> statement-breakpoint
UPDATE "tracks" SET "stage" = 'scanning' WHERE "stage" = 'previewing';--> statement-breakpoint
DROP TYPE "public"."stage";--> statement-breakpoint
CREATE TYPE "public"."stage" AS ENUM('queued', 'matching', 'searching', 'downloading', 'importing', 'tagging', 'scanning', 'analyzing', 'ready', 'failed');--> statement-breakpoint
ALTER TABLE "track_events" ALTER COLUMN "stage" SET DATA TYPE "public"."stage" USING "stage"::"public"."stage";--> statement-breakpoint
ALTER TABLE "tracks" ALTER COLUMN "stage" SET DEFAULT 'queued'::"public"."stage";--> statement-breakpoint
ALTER TABLE "tracks" ALTER COLUMN "stage" SET DATA TYPE "public"."stage" USING "stage"::"public"."stage";--> statement-breakpoint
ALTER TABLE "tracks" DROP COLUMN "has_preview";--> statement-breakpoint
ALTER TABLE "tracks" DROP COLUMN "has_artwork";