# Catalog metadata and schemas (`catalog`)

## Boundaries

- Owns `services/catalog/**`: standalone Python/Compose, PostgreSQL, Qdrant,
  volumes and dependencies.
- Also owns `@mint/domain-catalog`: six-column recording schema/FTS, read-only
  reconciliation, startup intent receipts and bounded source ingestion, not a
  full catalog engine. Production reconciliation reader/schema/API and pgvector
  parity remain unimplemented; candidates never merge or authorize acquisition.
- `reconcileRecordings` uses an injected consistent-snapshot reader with bounded
  lexical/link queries; metadata scores are ordering evidence, never identity or
  probability. Preserve conflicts and excluded links. See [bounds](../../plan/migration/compatibility.md#reconciliation-bounds).
- Startup planning is explicit/source-scoped (128 jobs, 50 countries, 64 YouTube
  channels). `createCatalogSeedStore` atomically commits permanent PostgreSQL
  receipts with same-client queue intent, preserving existing keys/state;
  central tag `0007` applies its table.
  Scheduling counts are intent, not ingestion; pg-boss dedup is not a receipt.
- `createCatalogSeedIngestor` accepts only explicitly enabled ListenBrainz
  weekly-global startup jobs via domain payload `{version:1,job}`. Central tag
  `0008` stores at most one permanent run and 100 attributed occurrence rows,
  never canonical recording, authority or Library writes. Lease-fenced completion
  survives queue retention; pg-boss alone dispatches retries, while pauses,
  cooldowns and exhaustion stay incomplete. No automatic recovery or refresh is
  supplied. Other-source ingestion, production reconciliation and deployment
  acceptance remain gates. See [command/queue bounds](../../plan/migration/compatibility.md#listenbrainz-startup-ingestion).
- Standalone Python remains independent; its optional authenticated bridge serves
  bounded, provenance-bearing artist IDs. Mint owns bridge networking and
  producers/consumers; default operation has no Mint dependency.
- Read `services/catalog/README.md`, `OPERATIONS.md` and focused source/store tests.

## Invariants

- No upstream credentials, copied browser tokens, authentication/challenge
  bypasses, rotating identities or audio downloads. Public access does not
  imply unrestricted reuse; respect source terms and upstream backoff.
- Use explicit MusicBrainz IDs for identity/metadata; ListenBrainz weekly sitewide
  counts and separately opted-in Apple charts provide scoped popularity. YouTube
  feed/oEmbed and unauthenticated YouTube Music IDs stay distinct; persist no
  cookies, audio or player URLs. `SOURCES.md` separates nine public adapters from
  research. Preserve Openverse attribution; Spotify/SoundCloud are oEmbed-only,
  Amazon links-only, Discogs masters/editions distinct, and Openwhyd IDs explicit.
  Never merge matching names or infer/copy genres between record kinds.
- Bulk COPY stays admitted, quality-counted and bounded; fingerprinted checkpoints
  commit with metadata, without per-ID job floods. Retain MusicBrainz recording/
  release-group IDs and memberships plus separate genre licensing. Parse OMDB
  dumps only; do not restore/execute them or import playback/media tables.
- Popularity is a decaying explicit-chart-rank/public-count proxy propagated over
  artist/album/recording edges, not global listening counts. Unranked list
  positions never become invented chart ranks.
- PostgreSQL owns metadata, crawl leases, rate budgets, dead letters and the
  transactional vector outbox. Qdrant is a rebuildable search index.
- Artist groups are reversible derived mappings based only on explicit
  MusicBrainz/Wikidata links or exact shared provider/channel IDs; same names
  never prove identity and conflicting IDs stay separate. Keep source-scoped
  records/vectors and operator exclusions; group search after revision fencing
  and before limits, with attribution and a raw-results option.
- Index acknowledgments are revision-fenced; partial charts never replace richer
  lookups. Bound queries, responses, expansion and imports. Worker failures stop
  siblings and drain in-flight work; shared leases, per-host dispatch, cooldowns,
  pauses, Retry-After and source budgets remain authoritative. Avoid unchanged
  writes and popularity-only starvation.
- Embeddings are lossy; retain source attribution, coverage and failures. PCA is
  visualization, not audio, identity or graph evidence.
- New sources use this adapter/parser seam, never Mint provider/library code.
- Recording reconciliation is read-only and provenance-bearing. Metadata ranks
  are review candidates, never identity/probability; preserve version/duration
  conflicts, explicit exclusions, bounded lookup windows and original records.
- The loopback console uses bounded telemetry and same-origin controls; it cannot
  enable disabled sources, cancel active jobs or override backoff. See
  `OPERATIONS.md`; it is not public administration.
- Eligibility excludes disabled/paused sources and hosts in backoff; due counts
  are not worker counts, and an empty outbox can mean caught up. Graphs show
  actual edges with bounded settling and accessible controls.
- Neighborhoods show attributed shared credits, not similarity; preserve bounded
  paging, stale-request fences, sampling notices and local pinned Cytoscape.
- Catalog views group by provider/type, retain counts/attribution/coverage and
  never guess Qdrant disk use.
- `/data` uses allowlisted sources and bounded paging with independent errors;
  no arbitrary SQL, database writes or connection disclosure.
- `/v1/demand`: token-gated, anonymous, priority-only hints.

## Validation

Install `.[test]` in an isolated environment. Unit tests need no network.
`CATALOG_TEST_DATABASE_URL` must be disposable: fixtures create/drop databases.
Qdrant defaults to local mode. Tests do not establish deployment, remote
quantization or multi-million-item latency; verify those separately.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Standalone metadata aggregation, target recording schema, read-only reconciliation, startup seed receipts and bounded ListenBrainz observations.
- **Read before editing:** [services/catalog/README.md](../../services/catalog/README.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`platform`](platform.md)
- **Imported by:** [`library`](library.md), [`platform`](platform.md), [`playback`](playback.md), [`web-shell`](web-shell.md)
- **Live detail:** `npm run agents -- map catalog` (exports, line counts, cross-domain import edges).

### Owned files (120)

- `packages/domain-catalog/` `package.json`, `tsconfig.json`
- `packages/domain-catalog/migrations/` `0000_recordings.sql`, `0001_startup_seed_receipts.sql`, `0002_listenbrainz_seed_ingestion.sql`
- `packages/domain-catalog/src/` `index.ts`, `listenbrainz-source.ts`, `reconciliation.ts`, `schema.ts`, `seed-ingestion-schema.ts`, `seed-ingestion-store.ts`, `seed-ingestion.ts`, `startup-seed-store.ts`, `startup-seeding.ts`
- `packages/domain-catalog/tests/` `listenbrainz-source.test.ts`, `reconciliation.test.ts`, `schema.test.ts`, `seed-ingestion.integration.test.ts`, `seed-ingestion.test.ts`, `startup-seed-store.test.ts`, `startup-seeding.test.ts`
- `services/catalog/` `.dockerignore`, `.env.example`, `.gitignore`, `Dockerfile`, `OPERATIONS.md`, `README.md`, `SOURCES.md`, `compose.bridge.yml`, `compose.consumer.yml`, `compose.yml`, `package-lock.json`, `package.json`, `pyproject.toml`
- `services/catalog/catalog/` `__init__.py`, `api.py`, `atlas.py`, `bridge.py`, `browser.py`, `bulk_import.py`, `catalog_network.py`, `config.py`, `console.py`, `crawler.py`, `demand.py`, `discogs.py`, `discogs_import.py`, `embedding_map.py`, `graph.py`, `identity.py`, `importer.py`, `indexer.py`, `ingestion.py`, `main.py`, `model.py`, `musicbrainz_import.py`, `omdb_import.py`, `openwhyd.py`, `providers.py`, `public_sources.py`, `ranker.py`, `reconcile.py`, `schema-v10.sql`, `schema-v2.sql`, `schema-v3.sql`, `schema-v4.sql`, `schema-v5.sql`, `schema-v6.sql`, `schema-v7.sql`, `schema-v8.sql`, `schema-v9.sql`, `schema.sql`, `snapshot.py`, `sources.py`, `store.py`, `telemetry.py`, `vectors.py`, `workers.py`, `youtube.py`
- `services/catalog/catalog/static/` `api.html`, `clustering.worker.js`, `console.css`, `console.js`, `cytoscape.LICENSE.txt`, `cytoscape.min.js`, `data.css`, `data.html`, `data.js`, `embedding-atlas.LICENSE.txt`, `embedding-atlas.js`, `embedding-map.js`, `graph-layout.js`, `graph-view.js`, `index.html`
- `services/catalog/scripts/` `build-atlas.mjs`
- `services/catalog/tests/` `conftest.py`, `embedding-map.test.cjs`, `graph-layout.test.cjs`, `test_atlas.py`, `test_bridge.py`, `test_browser.py`, `test_bulk_import.py`, `test_catalog_network.py`, `test_console.py`, `test_demand.py`, `test_discogs.py`, `test_embedding_map.py`, `test_graph.py`, `test_hosts.py`, `test_identity.py`, `test_model.py`, `test_openwhyd.py`, `test_pipeline.py`, `test_public_sources.py`, `test_reconcile.py`, `test_snapshot.py`, `test_sources.py`, `test_store.py`, `test_workers.py`, `test_youtube.py`

### Validate

Owned tests: 9.

```bash
corepack pnpm --filter @mint/domain-catalog run typecheck
corepack pnpm --filter @mint/domain-catalog exec tsx --test tests/listenbrainz-source.test.ts tests/reconciliation.test.ts tests/schema.test.ts tests/seed-ingestion.integration.test.ts tests/seed-ingestion.test.ts tests/startup-seed-store.test.ts tests/startup-seeding.test.ts
node --test services/catalog/tests/embedding-map.test.cjs services/catalog/tests/graph-layout.test.cjs
corepack pnpm --filter @mint/domain-catalog exec tsx --test tests/listenbrainz-source.test.ts tests/reconciliation.test.ts tests/schema.test.ts tests/seed-ingestion.test.ts tests/seed-ingestion.integration.test.ts tests/startup-seed-store.test.ts tests/startup-seeding.test.ts
python -m pytest services/catalog/tests
python -m ruff check services/catalog
node --test services/catalog/tests/*.test.cjs
docker compose --env-file services/catalog/.env.example -f services/catalog/compose.yml config --quiet
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).

<!-- agents:generated:end -->
