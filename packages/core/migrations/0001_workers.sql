CREATE TYPE "public"."worker_status" AS ENUM('pending', 'active', 'disabled');--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"status" "worker_status" DEFAULT 'pending' NOT NULL,
	"version" text,
	"last_seen_at" timestamp with time zone,
	"last_ip" text,
	"active_jobs" integer DEFAULT 0 NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"capabilities" jsonb,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "remote_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "lease_id" text;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "lease_worker_id" uuid;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "remote_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workers_token_idx" ON "workers" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "workers_user_idx" ON "workers" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_lease_worker_id_workers_id_fk" FOREIGN KEY ("lease_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracks_remote_idx" ON "tracks" USING btree ("remote_at") WHERE "tracks"."remote_at" is not null;