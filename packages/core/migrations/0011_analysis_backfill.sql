ALTER TABLE "analysis_workers" DROP CONSTRAINT "analysis_workers_mode_check";
--> statement-breakpoint
ALTER TABLE "analysis_workers" ADD CONSTRAINT "analysis_workers_mode_check" CHECK ("mode" IN ('local', 'remote', 'coordinator'));
--> statement-breakpoint
CREATE TABLE "analysis_backfills" (
  "id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "cursor" uuid,
  "upper_bound" uuid,
  "total" integer DEFAULT 0 NOT NULL,
  "scanned" integer DEFAULT 0 NOT NULL,
  "queued" integer DEFAULT 0 NOT NULL,
  "requested_by" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
