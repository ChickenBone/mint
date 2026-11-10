CREATE TABLE IF NOT EXISTS catalog_schema (
    version integer PRIMARY KEY CHECK (version = 1)
);
INSERT INTO catalog_schema VALUES (1) ON CONFLICT DO NOTHING;
CREATE SEQUENCE IF NOT EXISTS entity_revision;
CREATE TABLE IF NOT EXISTS entities (
    key text PRIMARY KEY,
    source text NOT NULL CHECK (source IN ('apple', 'musicbrainz')),
    origin text NOT NULL CHECK (origin IN ('apple', 'musicbrainz', 'listenbrainz')),
    quality integer NOT NULL CHECK (quality IN (0,1)),
    country text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('artist', 'album', 'song')),
    provider_id text NOT NULL,
    title text NOT NULL,
    artist text NOT NULL,
    album text NOT NULL,
    genres text[] NOT NULL,
    url text NOT NULL,
    document text NOT NULL,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple', document)) STORED,
    revision bigint NOT NULL DEFAULT nextval('entity_revision'),
    indexed_revision bigint,
    popularity double precision NOT NULL DEFAULT 0,
    observed_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entities_search ON entities USING gin(search);
CREATE INDEX IF NOT EXISTS entities_scope ON entities(country, kind);
CREATE INDEX IF NOT EXISTS entities_revision ON entities(revision);
CREATE TABLE IF NOT EXISTS catalog_budget (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    entities bigint NOT NULL DEFAULT 0
);
INSERT INTO catalog_budget(singleton) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS edges (
    source text NOT NULL REFERENCES entities(key) ON DELETE CASCADE,
    target text NOT NULL,
    relation text NOT NULL CHECK (relation IN ('artist', 'album')),
    PRIMARY KEY (source, target)
);
CREATE INDEX IF NOT EXISTS edges_target ON edges(target, source);
CREATE TABLE IF NOT EXISTS chart_signals (
    chart text NOT NULL,
    key text NOT NULL REFERENCES entities(key) ON DELETE CASCADE,
    rank integer NOT NULL CHECK (rank BETWEEN 1 AND 100),
    weight double precision NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(chart, key)
);
CREATE INDEX IF NOT EXISTS signals_key ON chart_signals(key);
CREATE TABLE IF NOT EXISTS jobs (
    key text PRIMARY KEY,
    task text NOT NULL CHECK (
        task IN ('chart', 'lookup', 'lb-chart', 'mb-lookup', 'mb-albums', 'mb-songs')
    ),
    entity_key text,
    country text NOT NULL,
    kind text NOT NULL,
    provider_id text NOT NULL,
    page integer NOT NULL DEFAULT 0 CHECK (page BETWEEN 0 AND 100000),
    priority double precision NOT NULL DEFAULT 0,
    due_at timestamptz NOT NULL DEFAULT now(),
    ready boolean NOT NULL DEFAULT true,
    lease_token uuid,
    lease_until timestamptz NOT NULL DEFAULT '-infinity',
    attempts integer NOT NULL DEFAULT 0,
    dead boolean NOT NULL DEFAULT false,
    last_error text
);
CREATE INDEX IF NOT EXISTS jobs_priority ON jobs(priority DESC, due_at, key) WHERE NOT dead AND ready;
CREATE INDEX IF NOT EXISTS jobs_ready_due ON jobs(due_at, key) WHERE NOT dead AND ready;
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(due_at, key) WHERE NOT dead AND NOT ready;
CREATE INDEX IF NOT EXISTS jobs_entity ON jobs(entity_key);
CREATE TABLE IF NOT EXISTS vector_outbox (
    key text PRIMARY KEY REFERENCES entities(key) ON DELETE CASCADE,
    revision bigint NOT NULL,
    due_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    lease_until timestamptz NOT NULL DEFAULT '-infinity',
    attempts integer NOT NULL DEFAULT 0,
    dead boolean NOT NULL DEFAULT false,
    last_error text
);
CREATE INDEX IF NOT EXISTS outbox_due ON vector_outbox(due_at, key) WHERE NOT dead;
CREATE TABLE IF NOT EXISTS host_budgets (
    host text PRIMARY KEY,
    next_at timestamptz NOT NULL DEFAULT '-infinity'
);
