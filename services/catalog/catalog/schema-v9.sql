ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CHECK (task IN (
    'chart','lookup','lb-chart','mb-lookup','mb-albums','mb-songs','mb-releases','mb-release',
    'yt-feed','yt-video','ytm-chart','ytm-artist','ytm-album','ytm-song','ytm-playlist',
    'spotify-lookup','deezer-chart','deezer-lookup','deezer-albums','deezer-tracks',
    'audius-chart','audius-lookup','audius-tracks','archive-chart','archive-lookup',
    'wikidata-lookup','soundcloud-lookup','openverse-chart','openverse-lookup',
    'discogs-lookup','discogs-albums','openwhyd-chart'
));
CREATE TABLE priority_artists (
    entity_key text NOT NULL,
    provenance text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_key, provenance)
);
CREATE INDEX jobs_mb_releases_pending ON jobs (due_at)
    WHERE task='mb-releases' AND NOT dead;
INSERT INTO catalog_schema(version) VALUES (9);
