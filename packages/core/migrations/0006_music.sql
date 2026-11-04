CREATE TABLE music_collections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL, description text NOT NULL DEFAULT '', artwork_url text, rules jsonb,
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE music_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid NOT NULL REFERENCES music_collections(id) ON DELETE CASCADE,
 track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, position integer NOT NULL
);
CREATE INDEX music_entries_order_idx ON music_entries(collection_id,position);
--> statement-breakpoint
CREATE TABLE music_members (
 collection_id uuid NOT NULL REFERENCES music_collections(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, accepted boolean NOT NULL DEFAULT false,
 PRIMARY KEY(collection_id,user_id)
);
--> statement-breakpoint
CREATE TABLE music_folders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, title text NOT NULL
);
CREATE TABLE music_organization (
 collection_id uuid NOT NULL REFERENCES music_collections(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 folder_id uuid REFERENCES music_folders(id) ON DELETE SET NULL, pinned boolean NOT NULL DEFAULT false,
 PRIMARY KEY(collection_id,user_id)
);
--> statement-breakpoint
CREATE TABLE music_likes (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,track_id)
);
CREATE TABLE music_preferences (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, private_session boolean NOT NULL DEFAULT false, history_after timestamptz
);
--> statement-breakpoint
CREATE TABLE music_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, listened_ms integer NOT NULL,
 completed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX music_history_user_time_idx ON music_history(user_id,created_at);
CREATE TABLE music_exclusions (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id,track_id)
);
