CREATE TABLE playback.queue_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES accounts.users (id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  shuffled boolean NOT NULL DEFAULT false,
  total integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX queue_snapshots_user_created_idx
  ON playback.queue_snapshots (user_id, created_at, id);
CREATE INDEX queue_snapshots_expiry_idx
  ON playback.queue_snapshots (expires_at);

CREATE TABLE playback.queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id uuid NOT NULL REFERENCES playback.queue_snapshots (id) ON DELETE CASCADE,
  media_file_id uuid NOT NULL REFERENCES library.media_files (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  original_position integer NOT NULL CHECK (original_position >= 0),
  source_occurrence_id uuid
);
CREATE INDEX queue_entries_page_idx
  ON playback.queue_entries (queue_id, position, id);
CREATE INDEX queue_entries_media_file_idx
  ON playback.queue_entries (queue_id, media_file_id);
