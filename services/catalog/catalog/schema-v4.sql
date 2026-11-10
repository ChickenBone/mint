ALTER TABLE entities ADD COLUMN artist_identity text GENERATED ALWAYS AS (
    CASE WHEN kind='artist' THEN
        CASE WHEN source='youtube' THEN 'ytmusic' ELSE source END
        || ':artist:' || provider_id
    END
) STORED;
CREATE INDEX entities_artist_identity ON entities(artist_identity) WHERE artist_identity IS NOT NULL;
CREATE TABLE canonical_artists (
    identity text PRIMARY KEY,
    canonical_id text NOT NULL
);
CREATE INDEX canonical_artists_group ON canonical_artists(canonical_id);
ALTER TABLE entity_links ADD COLUMN canonical_status text NOT NULL DEFAULT 'unreviewed'
    CHECK (canonical_status IN ('unreviewed','accepted','conflict','excluded'));
INSERT INTO catalog_schema(version) VALUES (4);
