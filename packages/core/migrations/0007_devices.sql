CREATE TABLE "connected_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "auth_session_id" text NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "name" text NOT NULL,
  "state" jsonb NOT NULL,
  "sequence" integer DEFAULT 0 NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "connected_devices_user_idx" ON "connected_devices" ("user_id");
--> statement-breakpoint
CREATE TABLE "device_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "device_id" uuid NOT NULL REFERENCES "connected_devices"("id") ON DELETE CASCADE,
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "actor_session_id" text NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "sequence" integer NOT NULL,
  "command" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL CHECK ("status" IN ('pending','delivered','succeeded','failed','expired')),
  "error" text,
  "expires_at" timestamptz NOT NULL,
  "delivered_at" timestamptz,
  "acknowledged_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "device_commands_sequence_idx" ON "device_commands" ("device_id", "sequence");
--> statement-breakpoint
CREATE INDEX "device_commands_pending_idx" ON "device_commands" ("device_id", "status");
--> statement-breakpoint
CREATE TABLE "party_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "host_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL REFERENCES "connected_devices"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "queue" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "applied_revision" integer,
  "guests_can_edit" boolean DEFAULT false NOT NULL,
  "invite_hash" text,
  "invite_expires_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "closed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "party_sessions_host_idx" ON "party_sessions" ("host_id");
--> statement-breakpoint
CREATE TABLE "party_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "party_id" uuid NOT NULL REFERENCES "party_sessions"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "joined_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "party_participants_member_idx" ON "party_participants" ("party_id", "user_id");
