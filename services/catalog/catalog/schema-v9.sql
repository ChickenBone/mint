ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CHECK (task IN (
    'chart','lookup','lb-chart','mb-lookup','mb-albums','mb-songs',
    'yt-feed','yt-video','ytm-chart','ytm-artist','ytm-album','ytm-song','ytm-playlist',
    'spotify-lookup','deezer-chart','deezer-lookup','deezer-albums','deezer-tracks',
    'audius-chart','audius-lookup','audius-tracks','archive-chart','archive-lookup',
    'wikidata-lookup','soundcloud-lookup','openverse-chart','openverse-lookup',
    'discogs-lookup','discogs-albums','openwhyd-chart',
    'ytm-search','ytm-related','apple-search','mb-search'
));
INSERT INTO catalog_schema(version) VALUES (9);
