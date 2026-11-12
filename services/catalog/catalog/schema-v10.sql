ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check CHECK (task IN (
    'chart','lookup','lb-chart','mb-lookup','mb-albums','mb-songs','mb-releases','mb-release',
    'yt-feed','yt-video','ytm-chart','ytm-artist','ytm-album','ytm-song','ytm-playlist',
    'spotify-lookup','deezer-chart','deezer-lookup','deezer-albums','deezer-tracks',
    'audius-chart','audius-lookup','audius-tracks','archive-chart','archive-lookup',
    'wikidata-lookup','soundcloud-lookup','openverse-chart','openverse-lookup',
    'discogs-lookup','discogs-albums','openwhyd-chart',
    'ytm-search','ytm-related','apple-search','mb-search'
));
CREATE TABLE IF NOT EXISTS priority_artists (
    entity_key text NOT NULL,
    provenance text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_key, provenance)
);
CREATE INDEX IF NOT EXISTS jobs_mb_releases_pending ON jobs (due_at)
    WHERE task='mb-releases' AND NOT dead;
ALTER TABLE jobs ADD COLUMN demand_priority double precision NOT NULL DEFAULT 0;
UPDATE jobs SET demand_priority=priority
    WHERE priority>=75 AND task<>'chart' AND task NOT LIKE '%-chart';
INSERT INTO catalog_schema(version) VALUES (10);
