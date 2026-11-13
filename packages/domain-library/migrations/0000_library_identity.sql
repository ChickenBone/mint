CREATE SCHEMA "library";
--> statement-breakpoint
CREATE TABLE "library"."roots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "path" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "roots_path_nonempty" CHECK (length(btrim("path")) > 0)
);
--> statement-breakpoint
CREATE TABLE "library"."media_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "root_id" uuid NOT NULL,
  "relative_path" text NOT NULL,
  "recording_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_files_relative_path_nonempty" CHECK (length(btrim("relative_path")) > 0),
  CONSTRAINT "media_files_root_fk" FOREIGN KEY ("root_id") REFERENCES "library"."roots"("id") ON DELETE RESTRICT,
  CONSTRAINT "media_files_recording_fk" FOREIGN KEY ("recording_id") REFERENCES "catalog"."recordings"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_root_id_relative_path_idx" ON "library"."media_files" USING btree ("root_id", "relative_path");
--> statement-breakpoint
CREATE INDEX "media_files_recording_id_idx" ON "library"."media_files" USING btree ("recording_id");
