# Standalone metadata catalog (`catalog`)

## Boundaries

- Owns `services/catalog/**`: standalone Python/Compose, PostgreSQL, Qdrant,
  volumes and dependencies.
- No Mint imports or database access, playback, acquisition or accounts.
  The optional authenticated bridge accepts explicit artist IDs with provenance
  and serves bounded metadata; Mint owns its producer, consumers and networking.
  Default standalone operation must not require Mint.
- Start with `services/catalog/README.md`, then `OPERATIONS.md`, the source
  parser, durable store and focused pipeline tests.

## Invariants

- No upstream credentials, copied browser tokens, authentication/challenge
  bypasses, rotating identities or audio downloads. Public access does not
  imply unrestricted reuse; respect source terms and upstream backoff.
- MusicBrainz provides identity/metadata; ListenBrainz public sitewide weekly
  statistics provide scoped popularity observations. Apple's public chart and
  lookup endpoints are separately opt-in. YouTube feeds/oEmbed and unauthenticated YouTube Music retain separate IDs.
  No cookies, audio or player URLs are persisted. `SOURCES.md` separates nine
  `PUBLIC_SOURCES` adapters from research. Spotify/SoundCloud are oEmbed-only;
  Amazon is links-only. Retain Openverse attribution; never merge matching names.
  Genres must be explicit, not inferred or copied between record kinds.
  Discogs masters/editions retain distinct IDs; local CC0 XML imports stream
  without online job floods. Openwhyd supplies explicit platform IDs, not user data.
- Bulk COPY batches retain admission, quality, counters and outbox fencing.
  Fingerprinted import checkpoints commit with metadata; no per-ID crawl floods.
  MusicBrainz releases supply recording/release-group IDs and unioned memberships;
  genres retain their separate license. OMDB dumps are parsed, never restored or
  executed; keep independent IDs and discard playback/media tables.
- Popularity is a decaying explicit-chart-rank/public-count proxy propagated over
  artist/album/recording edges, not global listening counts. Unranked list
  positions never become invented chart ranks.
- PostgreSQL owns metadata, crawl leases, rate budgets, dead letters and the
  transactional vector outbox. Qdrant is a rebuildable search index.
- Artist identity groups are reversible derived mappings, backed by explicit
  MusicBrainz/Wikidata provider links or exact shared provider/channel IDs.
  Same names never prove equivalence; conflicting same-provider IDs stay apart.
  Raw records/vectors and graph identities remain source-scoped. Search groups
  artists after revision fencing and before limits, with provider attribution
  and a raw-results opt-out. Rebuilds preserve operator link exclusions.
- Index acknowledgments are revision-fenced. Partial charts never overwrite
  richer lookup metadata. Responses, queries, expansion pages and imports have
  explicit budgets; exploration avoids a popularity-only starvation loop.
- Bounded crawler/indexer pools own independent transport/model sessions.
  Worker failures stop sibling workers and propagate; shutdown drains in-flight
  work. Atomic per-host dispatch and shared scheduling retain oldest-due,
  bulk and popularity slots. Apple batches preserve every lease; failed jobs
  retry individually. Ingestion avoids unchanged edge/job writes. Shared budgets,
  publication locks and fencing remain authoritative. Rank batches avoid
  unchanged writes without weakening the global lock order.
  Fractional per-source intervals stay shared; public MusicBrainz retains its
  one-second minimum. Higher rates never override pauses or Retry-After.
  Preserve redirect continuations and nonblocking first-request deferrals.
- Local embeddings are lossy; retain attribution URLs, source scope, coverage
  limits and visible failures. Embedding Atlas maps current vectors with paged
  sample PCA, not audio/identity/edge evidence. Preserve session bases, browser
  limits and accessible alternatives.
- New sources use this adapter/parser seam, never Mint provider/library code.
- Recording reconciliation is read-only and provenance-bearing. Metadata ranks
  are review candidates, never identity/probability; preserve version/duration
  conflicts, explicit exclusions, bounded lookup windows and original records.
- The loopback console retains bounded telemetry, accessible reduced motion and
  same-origin controls; these never enable disabled sources, cancel active jobs
  or override backoff. See `OPERATIONS.md`; it is not public administration.
- Eligible jobs exclude disabled/paused sources and hosts in backoff. Due counts
  are not active workers; an empty embedding outbox can mean caught up. The
  Cytoscape graph has actual edges, bounded offline settling and accessible
  pan/zoom/selection alternatives, not invented live topology.
- Neighborhoods show attributed shared credits, not inferred similarity.
  Preserve bounded paging, stale-request fencing, sampling notices and accessible
  graph alternatives. Serve pinned Cytoscape locally under CSP.
- Whole catalog groups by provider/type, not similarity; retain exact counts,
  attribution, coverage and accessible drilldown. Never guess Qdrant disk use.
- `/data` reads only allowlisted catalog tables/the configured Qdrant collection.
  Retain bounded keyset/scroll paging, independent errors and raw JSON precision.
  No arbitrary SQL, database writes or connection disclosure.
- `/v1/demand`: token-gated, anonymous, priority-only hints.

## Validation

Install `.[test]` in an isolated environment. Unit tests need no network.
`CATALOG_TEST_DATABASE_URL` must be disposable: fixtures create/drop databases.
Qdrant defaults to local mode. Tests do not establish deployment, remote
quantization or multi-million-item latency; verify those separately.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Standalone metadata aggregation, recording reconciliation, popularity graph, search and optional authenticated metadata bridge.
- **Read before editing:** [services/catalog/README.md](../../services/catalog/README.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** none
- **Imported by:** none
- **Live detail:** `npm run agents -- map catalog` (exports, line counts, cross-domain import edges).

### Owned files (99)

- `services/catalog/` `.dockerignore`, `.env.example`, `.gitignore`, `Dockerfile`, `OPERATIONS.md`, `README.md`, `SOURCES.md`, `compose.bridge.yml`, `compose.consumer.yml`, `compose.yml`, `package-lock.json`, `package.json`, `pyproject.toml`
- `services/catalog/catalog/` `__init__.py`, `api.py`, `atlas.py`, `bridge.py`, `browser.py`, `bulk_import.py`, `catalog_network.py`, `config.py`, `console.py`, `crawler.py`, `demand.py`, `discogs.py`, `discogs_import.py`, `embedding_map.py`, `graph.py`, `identity.py`, `importer.py`, `indexer.py`, `ingestion.py`, `main.py`, `model.py`, `musicbrainz_import.py`, `omdb_import.py`, `openwhyd.py`, `providers.py`, `public_sources.py`, `ranker.py`, `reconcile.py`, `schema-v10.sql`, `schema-v2.sql`, `schema-v3.sql`, `schema-v4.sql`, `schema-v5.sql`, `schema-v6.sql`, `schema-v7.sql`, `schema-v8.sql`, `schema-v9.sql`, `schema.sql`, `snapshot.py`, `sources.py`, `store.py`, `telemetry.py`, `vectors.py`, `workers.py`, `youtube.py`
- `services/catalog/catalog/static/` `api.html`, `clustering.worker.js`, `console.css`, `console.js`, `cytoscape.LICENSE.txt`, `cytoscape.min.js`, `data.css`, `data.html`, `data.js`, `embedding-atlas.LICENSE.txt`, `embedding-atlas.js`, `embedding-map.js`, `graph-layout.js`, `graph-view.js`, `index.html`
- `services/catalog/scripts/` `build-atlas.mjs`
- `services/catalog/tests/` `conftest.py`, `embedding-map.test.cjs`, `graph-layout.test.cjs`, `test_atlas.py`, `test_bridge.py`, `test_browser.py`, `test_bulk_import.py`, `test_catalog_network.py`, `test_console.py`, `test_demand.py`, `test_discogs.py`, `test_embedding_map.py`, `test_graph.py`, `test_hosts.py`, `test_identity.py`, `test_model.py`, `test_openwhyd.py`, `test_pipeline.py`, `test_public_sources.py`, `test_reconcile.py`, `test_snapshot.py`, `test_sources.py`, `test_store.py`, `test_workers.py`, `test_youtube.py`

### Validate

Owned tests: 2.

```bash
node --test services/catalog/tests/embedding-map.test.cjs services/catalog/tests/graph-layout.test.cjs
python -m pytest services/catalog/tests
python -m ruff check services/catalog
node --test services/catalog/tests/*.test.cjs
docker compose --env-file services/catalog/.env.example -f services/catalog/compose.yml config --quiet
```

<!-- agents:generated:end -->
