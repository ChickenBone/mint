ALTER TABLE entities DROP CONSTRAINT entities_source_check;
ALTER TABLE entities ADD CHECK (source IN (
    'apple','musicbrainz','youtube','ytmusic','spotify','deezer','audius',
    'archive','wikidata','soundcloud','openverse'
));
ALTER TABLE entities DROP CONSTRAINT entities_origin_check;
ALTER TABLE entities ADD CHECK (origin IN (
    'apple','musicbrainz','listenbrainz','youtube','ytmusic','spotify','deezer',
    'audius','archive','wikidata','soundcloud','openverse'
));
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CHECK (task IN (
    'chart','lookup','lb-chart','mb-lookup','mb-albums','mb-songs',
    'yt-feed','yt-video','ytm-chart','ytm-artist','ytm-album','ytm-song','ytm-playlist',
    'spotify-lookup','deezer-chart','deezer-lookup','deezer-albums','deezer-tracks',
    'audius-chart','audius-lookup','audius-tracks','archive-chart','archive-lookup',
    'wikidata-lookup','soundcloud-lookup','openverse-chart','openverse-lookup'
));
ALTER TABLE jobs ADD COLUMN host text NOT NULL DEFAULT '';
UPDATE jobs SET host=CASE
    WHEN task='chart' THEN 'rss.marketingtools.apple.com'
    WHEN source='apple' THEN 'itunes.apple.com'
    WHEN source='musicbrainz' THEN 'musicbrainz.org'
    WHEN source='listenbrainz' THEN 'api.listenbrainz.org'
    WHEN source='youtube' THEN 'www.youtube.com'
    WHEN source='ytmusic' THEN 'music.youtube.com' END;
CREATE INDEX jobs_host ON jobs(host);
INSERT INTO source_controls(source) VALUES
    ('spotify'),('deezer'),('audius'),('archive'),('wikidata'),('soundcloud'),('openverse');
CREATE TABLE entity_links (
    key text NOT NULL REFERENCES entities(key) ON DELETE CASCADE,
    provider text NOT NULL,
    kind text NOT NULL,
    identifier text NOT NULL,
    url text NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key,provider,kind,identifier)
);
CREATE TABLE entity_annotations (
    key text PRIMARY KEY REFERENCES entities(key) ON DELETE CASCADE,
    metadata jsonb NOT NULL
);
INSERT INTO catalog_schema(version) VALUES (3);
