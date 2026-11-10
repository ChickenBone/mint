ALTER TABLE entities DROP CONSTRAINT entities_source_check;
ALTER TABLE entities ADD CHECK (source IN (
    'apple','musicbrainz','youtube','ytmusic','spotify','deezer','audius',
    'archive','wikidata','soundcloud','openverse','discogs'
));
ALTER TABLE entities DROP CONSTRAINT entities_origin_check;
ALTER TABLE entities ADD CHECK (origin IN (
    'apple','musicbrainz','listenbrainz','youtube','ytmusic','spotify','deezer',
    'audius','archive','wikidata','soundcloud','openverse','discogs','openwhyd'
));
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CHECK (task IN (
    'chart','lookup','lb-chart','mb-lookup','mb-albums','mb-songs',
    'yt-feed','yt-video','ytm-chart','ytm-artist','ytm-album','ytm-song','ytm-playlist',
    'spotify-lookup','deezer-chart','deezer-lookup','deezer-albums','deezer-tracks',
    'audius-chart','audius-lookup','audius-tracks','archive-chart','archive-lookup',
    'wikidata-lookup','soundcloud-lookup','openverse-chart','openverse-lookup',
    'discogs-lookup','discogs-albums','openwhyd-chart'
));
INSERT INTO source_controls(source) VALUES ('discogs'),('openwhyd');
INSERT INTO catalog_schema(version) VALUES (6);
