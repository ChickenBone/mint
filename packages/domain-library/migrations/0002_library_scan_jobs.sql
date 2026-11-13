CREATE TABLE "library"."scan_jobs" (
  "root_id" uuid PRIMARY KEY,
  "status" text NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending', 'completed', 'partial', 'blocked', 'failed')),
  "cursor" text CHECK ("cursor" IS NULL OR octet_length("cursor") BETWEEN 1 AND 1048576),
  "had_issues" boolean NOT NULL DEFAULT false,
  "failures" integer NOT NULL DEFAULT 0 CHECK ("failures" BETWEEN 0 AND 5),
  "last_result" jsonb,
  "last_error" text CHECK ("last_error" IN ('cursor-rejected', 'root-unavailable', 'no-progress', 'scan-failed')),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "scan_jobs_root_fk" FOREIGN KEY ("root_id") REFERENCES "library"."roots" ("id") ON DELETE RESTRICT,
  CONSTRAINT "scan_jobs_terminal_cursor" CHECK ("status" NOT IN ('completed', 'partial') OR "cursor" IS NULL)
);
