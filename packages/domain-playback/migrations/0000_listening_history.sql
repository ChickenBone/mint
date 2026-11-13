CREATE SCHEMA IF NOT EXISTS playback;

CREATE TABLE playback.history_preferences (
  user_id uuid PRIMARY KEY REFERENCES accounts.users (id) ON DELETE CASCADE,
  private_session boolean NOT NULL DEFAULT false,
  history_after timestamptz
);

CREATE TABLE playback.listening_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES accounts.users (id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  media_file_id uuid NOT NULL REFERENCES library.media_files (id) ON DELETE CASCADE,
  listened_ms integer NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listening_history_user_event_uidx UNIQUE (user_id, event_id),
  CONSTRAINT listening_history_duration_bounds CHECK (listened_ms BETWEEN 0 AND 86400000)
);

CREATE INDEX listening_history_user_time_idx
  ON playback.listening_history (user_id, created_at DESC, id DESC);
CREATE INDEX listening_history_media_file_idx
  ON playback.listening_history (media_file_id);
