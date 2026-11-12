CREATE TYPE "public"."search_request_enrichment_status" AS ENUM('queued', 'running', 'complete', 'not_found', 'ambiguous', 'failed');--> statement-breakpoint
CREATE TYPE "public"."search_request_status" AS ENUM('active', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "search_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"query" text NOT NULL,
	"normalized_query" text NOT NULL,
	"status" "search_request_status" DEFAULT 'active' NOT NULL,
	"enrichment_status" "search_request_enrichment_status" DEFAULT 'queued' NOT NULL,
	"musicbrainz_recording_id" text,
	"track_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_requests_closed_at_status_check" CHECK (("search_requests"."status" = 'active' and "search_requests"."closed_at" is null) or ("search_requests"."status" <> 'active' and "search_requests"."closed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "search_requests" ADD CONSTRAINT "search_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_requests" ADD CONSTRAINT "search_requests_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_requests_active_identity_idx" ON "search_requests" USING btree ("user_id","normalized_query") WHERE "search_requests"."status" = 'active';--> statement-breakpoint
CREATE INDEX "search_requests_user_status_created_idx" ON "search_requests" USING btree ("user_id","status","created_at");
