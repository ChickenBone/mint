CREATE TABLE IF NOT EXISTS "matching_settings" (
  "id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
  "controls" jsonb NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
