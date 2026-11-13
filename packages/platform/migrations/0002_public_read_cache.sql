CREATE TABLE "platform"."public_read_cache" (
  "slot" integer PRIMARY KEY NOT NULL CHECK ("slot" BETWEEN 0 AND 65535),
  "cache_key" text NOT NULL UNIQUE CHECK ("cache_key" ~ '^[0-9a-f]{64}$'),
  "kind" text CHECK ("kind" IN ('value', 'negative')),
  "payload" jsonb,
  "fetched_at" timestamp with time zone,
  "fresh_until" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "lease_token" uuid,
  "lease_until" timestamp with time zone,
  "retry_until" timestamp with time zone,
  CONSTRAINT "public_read_cache_value_valid" CHECK (
    ("kind" IS NULL AND "payload" IS NULL AND "fetched_at" IS NULL AND "fresh_until" IS NULL AND "expires_at" IS NULL)
    OR (
      "kind" IS NOT NULL AND "payload" IS NOT NULL
      AND "fetched_at" IS NOT NULL AND "fresh_until" IS NOT NULL AND "expires_at" IS NOT NULL
      AND "fetched_at" <= "fresh_until" AND "fresh_until" <= "expires_at"
      AND ("kind" <> 'negative' OR "fresh_until" = "expires_at")
    )
  ),
  CONSTRAINT "public_read_cache_lease_valid" CHECK (("lease_token" IS NULL) = ("lease_until" IS NULL)),
  CONSTRAINT "public_read_cache_payload_bounded" CHECK ("payload" IS NULL OR octet_length("payload"::text) <= 262144)
);
--> statement-breakpoint
CREATE INDEX "public_read_cache_expiry_idx" ON "platform"."public_read_cache" ("expires_at");
