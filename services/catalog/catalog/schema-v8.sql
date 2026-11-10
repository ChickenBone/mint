CREATE INDEX entity_links_recording_lookup ON entity_links(provider,kind,identifier,key)
    WHERE kind='song' AND canonical_status NOT IN ('excluded','conflict');
CREATE INDEX entities_recording_provider ON entities(source,provider_id,key) WHERE kind='song';
INSERT INTO catalog_schema(version) VALUES (8);
