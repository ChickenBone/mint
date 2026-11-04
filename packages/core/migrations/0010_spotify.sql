CREATE TABLE spotify_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider_id text NOT NULL, provider_account_id text, display_name text NOT NULL,
  access_token_enc text NOT NULL, refresh_token_enc text NOT NULL,
  expires_at timestamptz NOT NULL, scope text NOT NULL,
  auto_sync boolean NOT NULL DEFAULT true, status text NOT NULL DEFAULT 'idle', error text,
  last_synced_at timestamptz, next_sync_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE spotify_oauth_states (
  hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  verifier_enc text NOT NULL, expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE spotify_playlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES spotify_accounts(user_id) ON DELETE CASCADE,
  provider_id text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '',
  provider_url text NOT NULL, owner_name text, sync_enabled boolean NOT NULL DEFAULT false,
  snapshot_id text, source_total integer NOT NULL DEFAULT 0, matched_total integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'not_synced', error text, last_synced_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX spotify_playlists_source_idx ON spotify_playlists(user_id, provider_id);
--> statement-breakpoint
CREATE TABLE spotify_entries (
  id uuid PRIMARY KEY, playlist_id uuid NOT NULL REFERENCES spotify_playlists(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0), provider_id text, provider_uri text,
  title text NOT NULL, artists jsonb NOT NULL, album text, duration_ms integer, isrc text,
  added_at text, added_by text, status text NOT NULL CHECK (status IN ('matched','missing','unavailable','ambiguous')),
  reason text NOT NULL, track_id uuid REFERENCES tracks(id) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX spotify_entries_order_idx ON spotify_entries(playlist_id, position);
--> statement-breakpoint
CREATE INDEX spotify_entries_track_idx ON spotify_entries(track_id);
