CREATE TABLE artist_metadata (
  artist_name text PRIMARY KEY,
  musicbrainz_artist_id text,
  status text NOT NULL DEFAULT 'queued',
  profile jsonb,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX artist_metadata_status_idx ON artist_metadata(status, next_attempt_at);
--> statement-breakpoint
CREATE INDEX artist_metadata_mbid_idx ON artist_metadata(musicbrainz_artist_id);
