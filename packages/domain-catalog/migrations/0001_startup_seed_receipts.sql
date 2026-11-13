CREATE TABLE "catalog"."startup_seed_receipts" (
  "key" text PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
