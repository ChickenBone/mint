DO $$ BEGIN
  PERFORM pg_advisory_xact_lock(7820009);
  CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
END $$;
--> statement-breakpoint
CREATE FUNCTION mint_search_text(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT trim(regexp_replace(regexp_replace(lower(normalize(coalesce(value, ''), NFKD)), U&'[\0300-\036f]', '', 'g'), '[^[:alnum:]]+', ' ', 'g'))
$$;
--> statement-breakpoint
CREATE INDEX tracks_search_words_idx ON tracks USING gin(to_tsvector('simple', mint_search_text(title || ' ' || artist || ' ' || coalesce(album, ''))));
--> statement-breakpoint
CREATE INDEX tracks_search_near_idx ON tracks USING gist(mint_search_text(title || ' ' || artist || ' ' || coalesce(album, '')) public.gist_trgm_ops);
--> statement-breakpoint
CREATE INDEX tracks_catalog_order_idx ON tracks(artist, album, title, id);
--> statement-breakpoint
CREATE TABLE playback_queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1,
  shuffled boolean NOT NULL DEFAULT false,
  total integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
--> statement-breakpoint
CREATE INDEX playback_queues_user_idx ON playback_queues(user_id, created_at);
--> statement-breakpoint
CREATE INDEX playback_queues_expiry_idx ON playback_queues(expires_at);
--> statement-breakpoint
CREATE TABLE playback_queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id uuid NOT NULL REFERENCES playback_queues(id) ON DELETE CASCADE,
  track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position integer NOT NULL,
  original_position integer NOT NULL,
  source_occurrence_id uuid
);
--> statement-breakpoint
CREATE INDEX playback_queue_entries_page_idx ON playback_queue_entries(queue_id, position, id);
--> statement-breakpoint
CREATE INDEX playback_queue_entries_track_idx ON playback_queue_entries(queue_id, track_id);
--> statement-breakpoint
CREATE INDEX tracks_recording_idx ON tracks(mb_recording_id) WHERE mb_recording_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE user_tracks ADD COLUMN origin text NOT NULL DEFAULT 'youtube';
