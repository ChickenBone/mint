ALTER TABLE catalog_schema DROP CONSTRAINT catalog_schema_version_check;
ALTER TABLE catalog_schema ADD CHECK (version >= 1);
ALTER TABLE entities DROP CONSTRAINT entities_source_check;
ALTER TABLE entities ADD CHECK (source IN ('apple','musicbrainz','youtube','ytmusic'));
ALTER TABLE entities DROP CONSTRAINT entities_origin_check;
ALTER TABLE entities ADD CHECK (origin IN ('apple','musicbrainz','listenbrainz','youtube','ytmusic'));
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CHECK (task IN (
    'chart','lookup','lb-chart','mb-lookup','mb-albums','mb-songs',
    'yt-feed','yt-video','ytm-chart','ytm-artist','ytm-album','ytm-song','ytm-playlist'
));
ALTER TABLE jobs ADD COLUMN source text NOT NULL DEFAULT 'apple';
UPDATE jobs SET source=CASE
    WHEN task LIKE 'mb-%' THEN 'musicbrainz'
    WHEN task='lb-chart' THEN 'listenbrainz' ELSE 'apple' END;
CREATE INDEX jobs_source ON jobs(source);
ALTER TABLE chart_signals ALTER COLUMN rank DROP NOT NULL;
ALTER TABLE chart_signals ADD COLUMN signal_kind text NOT NULL DEFAULT 'rank';
ALTER TABLE chart_signals ADD COLUMN raw_value bigint;
CREATE TABLE source_controls (
    source text PRIMARY KEY,
    paused boolean NOT NULL DEFAULT false,
    changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO source_controls(source) VALUES
    ('apple'),('musicbrainz'),('listenbrainz'),('youtube'),('ytmusic');
CREATE TABLE activity (
    id bigserial PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    role text NOT NULL,
    source text,
    action text NOT NULL,
    key text,
    detail text NOT NULL,
    amount integer NOT NULL DEFAULT 0
);
CREATE TABLE workers (
    id uuid PRIMARY KEY,
    role text NOT NULL,
    state text NOT NULL,
    job_key text,
    seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE source_metrics (
    source text PRIMARY KEY,
    entities bigint NOT NULL DEFAULT 0,
    indexed bigint NOT NULL DEFAULT 0
);
INSERT INTO source_metrics(source,entities,indexed)
SELECT source,count(*),count(*) FILTER(WHERE revision=indexed_revision)
FROM entities GROUP BY source;
CREATE INDEX entities_updated ON entities(updated_at DESC,key);
CREATE INDEX entities_popularity ON entities(popularity DESC,key);
INSERT INTO catalog_schema(version) VALUES (2);
