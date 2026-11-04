CREATE INDEX tracks_chart_identity_idx ON tracks(mint_search_text(artist), mint_search_text(title));
--> statement-breakpoint
CREATE TABLE chart_entry_links (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  entry_id text NOT NULL,
  identity text NOT NULL,
  track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, provider, entry_id)
);
