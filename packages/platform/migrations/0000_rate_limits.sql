CREATE SCHEMA "platform";
--> statement-breakpoint
CREATE TABLE "platform"."rate_limits" (
  "key" text PRIMARY KEY NOT NULL,
  "attempts" bigint NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "rate_limits_attempts_positive" CHECK ("attempts" > 0)
);
--> statement-breakpoint
CREATE INDEX "rate_limits_expiry_idx" ON "platform"."rate_limits" ("expires_at");
