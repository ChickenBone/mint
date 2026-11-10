ALTER TABLE host_budgets ADD COLUMN crawl_sequence bigint NOT NULL DEFAULT 0;
CREATE INDEX jobs_host_priority ON jobs(host, priority DESC, due_at, key)
    WHERE NOT dead AND ready;
CREATE INDEX jobs_host_due ON jobs(host, due_at, key) WHERE NOT dead AND ready;
CREATE INDEX jobs_apple_batch ON jobs(country, kind, priority DESC, due_at, key)
    WHERE source='apple' AND task='lookup' AND NOT dead AND ready AND attempts=0;
INSERT INTO catalog_schema(version) VALUES (5);
