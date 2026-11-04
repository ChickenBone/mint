CREATE TABLE "track_analysis" (
  "track_id" uuid PRIMARY KEY REFERENCES "tracks"("id") ON DELETE CASCADE,
  "version" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','running','complete','failed','cancelled')),
  "attempts" integer NOT NULL DEFAULT 0,
  "result" jsonb,
  "error" text,
  "lease_id" uuid,
  "lease_expires_at" timestamptz,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "track_analysis_status_idx" ON "track_analysis" ("status", "updated_at");
--> statement-breakpoint
CREATE TABLE "analysis_settings" (
  "id" text PRIMARY KEY DEFAULT 'global' CHECK ("id" = 'global'),
  "controls" jsonb NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "analysis_workers" (
  "id" text PRIMARY KEY,
  "mode" text NOT NULL CHECK ("mode" IN ('local','remote')),
  "seen_at" timestamptz NOT NULL DEFAULT now(),
  "error" text
);
