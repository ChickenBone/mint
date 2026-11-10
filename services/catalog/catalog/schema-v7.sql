ALTER TABLE entities DROP CONSTRAINT entities_source_check;
ALTER TABLE entities ADD CHECK (source IN (
    'apple','musicbrainz','youtube','ytmusic','spotify','deezer','audius',
    'archive','wikidata','soundcloud','openverse','discogs','omdb'
));
ALTER TABLE entities DROP CONSTRAINT entities_origin_check;
ALTER TABLE entities ADD CHECK (origin IN (
    'apple','musicbrainz','listenbrainz','youtube','ytmusic','spotify','deezer',
    'audius','archive','wikidata','soundcloud','openverse','discogs','openwhyd','omdb'
));
INSERT INTO source_controls(source) VALUES ('omdb');
CREATE TABLE import_runs (
    id text PRIMARY KEY,
    source text NOT NULL,
    kind text NOT NULL,
    fingerprint text NOT NULL,
    records bigint NOT NULL DEFAULT 0 CHECK (records>=0),
    observations bigint NOT NULL DEFAULT 0 CHECK (observations>=0),
    status text NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','limited','interrupted','complete')),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO catalog_schema(version) VALUES (7);
