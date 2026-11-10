from catalog.identity import artist_identity


MAX_BATCH = 4096


def ingest(conn, entities, capacity, *, merge_relationships=False):
    """Caller owns the catalog admission lock and surrounding transaction."""
    if len(entities) > MAX_BATCH:
        raise ValueError(f"Ingestion batch exceeds {MAX_BATCH} records")
    selected = {}
    for item in entities:
        previous = selected.get(item.key)
        if previous is None or item.quality >= previous.quality:
            if merge_relationships and previous is not None:
                from dataclasses import replace

                item = replace(
                    item,
                    artist_keys=tuple(set(previous.artist_keys) | set(item.artist_keys)),
                    album_keys=tuple(set(previous.album_keys) | set(item.album_keys)),
                )
            selected[item.key] = item
    if not selected:
        return 0, []
    conn.execute(
        """CREATE TEMP TABLE IF NOT EXISTS catalog_ingest_stage (
           key text PRIMARY KEY, source text, origin text, quality integer,
           country text, kind text, provider_id text, title text, artist text,
           album text, genres text[], url text, document text,
           artist_keys text[], album_keys text[], identity text,
           is_new boolean DEFAULT true, accepted boolean DEFAULT true,
           changed boolean DEFAULT true, was_indexed boolean DEFAULT false
           ) ON COMMIT DELETE ROWS"""
    )
    conn.execute("TRUNCATE pg_temp.catalog_ingest_stage")
    with conn.cursor().copy(
        """COPY pg_temp.catalog_ingest_stage (
           key,source,origin,quality,country,kind,provider_id,title,artist,album,
           genres,url,document,artist_keys,album_keys,identity) FROM STDIN"""
    ) as copy:
        for item in sorted(selected.values(), key=lambda row: row.key):
            copy.write_row(
                (
                    item.key,
                    item.source,
                    item.origin,
                    item.quality,
                    item.country,
                    item.kind,
                    item.provider_id,
                    item.title,
                    item.artist,
                    item.album,
                    list(item.genres),
                    item.url,
                    item.document(),
                    list(set(item.artist_keys)),
                    list(set(item.album_keys)),
                    artist_identity(item.source, item.provider_id)
                    if item.kind == "artist"
                    else None,
                )
            )
    conn.execute(
        """UPDATE pg_temp.catalog_ingest_stage s SET
           is_new=false, accepted=e.quality<=s.quality,
           changed=(e.document,e.url,e.quality,e.origin) IS DISTINCT FROM
                   (s.document,s.url,s.quality,s.origin),
           was_indexed=e.revision=e.indexed_revision
           FROM entities e WHERE e.key=s.key"""
    )
    inserted = conn.execute(
        "SELECT count(*) AS n FROM pg_temp.catalog_ingest_stage WHERE is_new"
    ).fetchone()["n"]
    if inserted > capacity:
        raise ValueError("Catalog capacity reached; raise MAX_ENTITIES or prune explicitly")
    conn.execute(
        """INSERT INTO canonical_artists(identity,canonical_id)
           SELECT identity,identity FROM pg_temp.catalog_ingest_stage WHERE identity IS NOT NULL
           ORDER BY identity ON CONFLICT DO NOTHING"""
    )
    conn.execute(
        """INSERT INTO source_metrics(source,entities,indexed)
           SELECT source,count(*) FILTER(WHERE is_new),
             -count(*) FILTER(WHERE accepted AND changed AND was_indexed)
           FROM pg_temp.catalog_ingest_stage
           WHERE is_new OR (accepted AND changed) GROUP BY source ORDER BY source
           ON CONFLICT(source) DO UPDATE SET
             entities=source_metrics.entities+excluded.entities,
             indexed=source_metrics.indexed+excluded.indexed"""
    )
    conn.execute(
        """INSERT INTO entities
           (key,source,origin,quality,country,kind,provider_id,title,artist,album,genres,url,document)
           SELECT key,source,origin,quality,country,kind,provider_id,title,artist,album,genres,url,document
           FROM pg_temp.catalog_ingest_stage WHERE accepted AND changed ORDER BY key
           ON CONFLICT(key) DO UPDATE SET
             title=excluded.title,artist=excluded.artist,album=excluded.album,
             origin=excluded.origin,quality=excluded.quality,genres=excluded.genres,
             url=excluded.url,document=excluded.document,
             revision=nextval('entity_revision'),observed_at=now(),updated_at=now()"""
    )
    conn.execute(
        """UPDATE entities e SET observed_at=now() FROM pg_temp.catalog_ingest_stage s
           WHERE e.key=s.key AND NOT (s.accepted AND s.changed)"""
    )
    conn.execute(
        """INSERT INTO vector_outbox(key,revision)
           SELECT e.key,e.revision FROM entities e JOIN pg_temp.catalog_ingest_stage s
           ON e.key=s.key WHERE s.accepted AND s.changed ORDER BY e.key
           ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,due_at=now(),
             attempts=0,dead=false,last_error=NULL"""
    )
    if not merge_relationships:
        conn.execute(
            """DELETE FROM edges e USING pg_temp.catalog_ingest_stage s
               WHERE e.source=s.key AND s.accepted
                 AND NOT ((e.relation='artist' AND e.target=ANY(s.artist_keys))
                       OR (e.relation='album' AND e.target=ANY(s.album_keys)))"""
        )
    conn.execute(
        """INSERT INTO edges(source,target,relation)
           SELECT s.key,t.target,'artist' FROM pg_temp.catalog_ingest_stage s
             CROSS JOIN LATERAL unnest(s.artist_keys) t(target) WHERE s.accepted
           UNION ALL
           SELECT s.key,t.target,'album' FROM pg_temp.catalog_ingest_stage s
             CROSS JOIN LATERAL unnest(s.album_keys) t(target) WHERE s.accepted
           ON CONFLICT DO NOTHING"""
    )
    if inserted:
        conn.execute("UPDATE catalog_budget SET entities=entities+%s", (inserted,))
    accepted = {
        row["key"]
        for row in conn.execute("SELECT key FROM pg_temp.catalog_ingest_stage WHERE accepted")
    }
    return inserted, [item for key, item in selected.items() if key in accepted]
