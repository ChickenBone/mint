CREATE SCHEMA "accounts";
--> statement-breakpoint
CREATE TYPE "accounts"."role" AS ENUM('user', 'admin');
--> statement-breakpoint
CREATE TYPE "accounts"."user_status" AS ENUM('pending', 'active', 'denied', 'disabled');
--> statement-breakpoint
CREATE TABLE "accounts"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "accounts"."role" DEFAULT 'user' NOT NULL,
	"status" "accounts"."user_status" DEFAULT 'pending' NOT NULL,
	"request_note" text,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts"."sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "accounts"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "accounts"."users" USING btree (lower("email"));
--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "accounts"."sessions" USING btree ("user_id");
