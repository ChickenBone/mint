# Plex-free library and PostgreSQL-first infrastructure

**User-directed target preference:** eliminate Plex entirely in the new Mint and
reduce operational complexity around PostgreSQL/pg-boss, following Audio-copy.
This supersedes retaining Plex as a target dependency, not the obligation to
preserve local listening, original files or imported collections. Current Mint
setup remains unchanged; no runtime dependency was removed by this plan.

The subsequent decisions select fresh empty installs, TypeScript/Fastify/tRPC,
pnpm/Nx/Drizzle and PostgreSQL/pg-boss/pgvector. No old account/library/job state
is migrated. Existing-library import remains optional and read-only. Separate
API/WebSocket and local-worker processes share PostgreSQL; both Expo apps remain
untouched, and remote worker execution is deferred.

## Library authority moves into Mint

The target library domain owns read-only roots, file inventory/probes, metadata
links, availability and artwork. Catalog identity, acquisition state and personal
collections remain separate domain authorities. A scanner is only part of that
replacement: search, paging, art, media delivery, reconciliation and management
must work without Plex credentials or services.

Donor evidence establishes read-only root-relative scanning/checkpoints,
separate playable media-file identity and private local-file streaming. It does
not establish scalable incremental traversal, deletion reconciliation, native
offline/transcode parity or replacement of Mint's provider imports and account
queue semantics. See [A4/A10 in the source ledger](../research/baselines.md).
Mint and Audio-copy follow-up research is integrated below. Both source baselines
remain pinned in the
[evidence ledger](../research/baselines.md).

## What Mint actually uses Plex for

| Current role | Source and implemented behavior | Replacement / intentional retirement |
| --- | --- | --- |
| Library metadata/index | [Indexer](../../apps/worker/src/library-index.ts): Plex pages supply tags/Part paths, filesystem stats verify read-only files, machine/section/rating key forms identity; UUID/upgrades survive upsert | Direct incremental inventory/probes with stable new file identities; incomplete tags remain explicit, without requiring old Plex metadata |
| Normal audio | [Playback](../../apps/worker/src/playback.ts), [transcode](../../apps/worker/src/transcode.ts), [media probe/tagging](../../apps/worker/src/media.ts): Mint already reads confined files, authorizes sessions, supports Range/HEAD and FFmpeg compatibility | Preserve existing independent capabilities; Plex is not Mint's normal audio server/transcoder |
| Finalization | [Finalize](../../apps/worker/src/jobs/finalize.ts): local reuse/upgrade/probe; already marks ready in disabled/read-only Plex mode; writable mode waits scan, key lookup and reported sonic analysis | Register verified local files directly; metadata/analysis background work must not gate verified playable media |
| Album/artist artwork | [Artwork](../../apps/worker/src/artwork.ts), [representatives](../../apps/web/src/lib/artwork-query.ts): preferred private Plex thumbs; artist portrait path Plex-only | Bounded embedded/folder/licensed public artwork, provenance and neutral portrait fallback; authorized cache export needs rights/size review |
| Spotify local matching | [Spotify store](../../packages/core/src/spotify-store.ts): playable candidates also require Plex key/existing-library identity | Fix target matching to verified media availability and recording/version evidence; do not exclude Plex-free downloads |
| Provider playlist export | [Maintenance](../../apps/worker/src/jobs/maintenance.ts), [Plex adapter](../../apps/worker/src/services/plex.ts): optional append/create mirror of DB collections | Retire external Plex mirror/invitations, preserve Mint/provider collections and occurrences; do not delete unrelated Plex installations |
| Plex sonic status/API | [Sonic job](../../apps/worker/src/jobs/sonic.ts), [private playback handler](../../apps/worker/src/playback.ts): reported-analysis polling and Plex nearest endpoint | Deliberately retire Plex-only fields/API under client policy; preserve independent measured [analysis](../../apps/worker/src/analysis-engine.ts) and discovery |
| Setup/health | [Integrations](../../apps/worker/src/integrations.ts), [configuration](../../apps/worker/src/config.ts), [Compose](../../docker-compose.yml) | Target removes Plex token/section/path translation/scan/health/bundled-service dependencies; current setup remains accurate |

The examined current indexer does not reconcile deletions: absent files are
skipped without retiring records. Target freshness/tombstones need explicit design.
No current web/mobile caller to the private Plex `/sonic` endpoint was found in
the focused research. This is source evidence, not proof every installed legacy
client ignores it. Own measured sonic discovery is already independent of Plex.

## How Audio-copy works without Plex

Donor references below are `ChickenBone/audio` at `5939dd3d31a9065e29f227bdd084a7023b1c3d67`.
It has no Plex runtime connector: configured roots feed scanner/probe/attribution
work, independent media-file UUIDs authorize direct local-byte streaming, and
private collections refer to library identity.

| Pinned donor source | Implemented strength | Gap to fix, not copy |
| --- | --- | --- |
| [Root dependencies](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/runtime/library-worker-dependencies.ts#L45-L112), [file schema](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-library/src/schema/media-files.ts#L4-L19) | UUID root/file identity, unique root-relative path, optional recording link | Path identity is not content deduplication; rename mappings must preserve collections |
| [Scanner](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-library/src/scanner/scanner.ts#L26-L98) | Read-only inventory/checkpoints and changed-source invalidation | Completed root cursor does not reset for new scan ID; whole-root rewalk per batch, no scan-generation/watch/deletion reconciliation |
| [Attribution dependencies](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/runtime/attribution-dependencies.ts#L45-L64) | Rich probe feeds conservative catalog attribution | Active scanned-file flow saves title/artist/release request, not all technical metadata; title+artist required; duration/ISRC/fingerprint not supplied to generic matcher |
| [Probe outbox](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-library/src/outbox/probe-outbox.ts#L67-L101) | Durable changed-file probe work and matching receipt checks | Persist technical/tag/error/untagged states independently of attribution; unmatched files must remain playable |
| [Local authorization](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/runtime/local-library.ts#L91-L145) | Member/file checks and local streaming, missing file denies grant | Stale list rows remain; target needs mount-loss-safe freshness and already-required transcode/offline behavior |
| [Artwork hydration](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/artwork-hydration.ts#L19-L104), [cache](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-catalog/src/artwork-cache/runtime.ts#L65-L119) | Evidence-backed catalog art and optional durable immutable assets | No unmatched embedded cover extraction; add bounded embedded/sidecar art and neutral fallback |
| [Composition](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/main.ts#L84-L119) | App pool and pg-boss share `DATABASE_URL`; domain workers composed together | Heavy jobs share capacity unless role/pool/admission limits are explicit |
| [Import polling](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/listener/src/import-progress.ts#L76-L124) | Bounded HTTP import polling | No donor server WebSocket/SSE/pubsub replacement established; local client subscription is not server fanout |

Managed imports persist more technical metadata than the scanned-original path;
do not infer scan parity from managed-file columns. Sample-rate/channels,
ReplayGain and embedded covers are not established persisted donor capabilities.
Probe/file pinning and known-hash validation are useful safety patterns, not proof
all new originals are content-hashed. Linux descriptors and the exact FFprobe
descriptor protocol require platform evidence.

The target must test a second scan with new, changed, renamed and deleted files,
and a missing mount that must not tombstone the whole library. Preserve imported
tag provenance, unmatched/ambiguous playback and new private collection identities.
No Plex export or legacy account/metadata converter is required for fresh installs.

| Responsibility | Target owner / required replacement |
| --- | --- |
| Existing-library discovery | Library: direct read-only inventory, bounded incremental frontier, checkpoints and root permissions |
| Technical metadata/availability | Library/analysis: confined probes, independently versioned results and reliable missing/unreadable states |
| Recording/artist/album identity | Catalog/library: evidence-backed links, unmatched files remain playable; stable target identities |
| Artwork | Library/catalog: bounded embedded/sidecar/licensed metadata assets, provenance, fallback and public/private policy |
| Media delivery | Playback/library: private authenticated direct file reads, Range/HEAD, revocation and codec compatibility |
| Library changes/finalization | Acquisition/library: accepted managed files registered directly; no dependency on Plex refresh |
| Account collections/imports | Collections/providers: preserve source identities, occurrences, ownership and sync without Plex mirrors |
| Operator setup/recovery | Admin/platform: root validation, scan/index health, errors, reconciliation and backup/restore |
| External Plex clients | Explicit legacy retirement scope: target does not promise Plex-client compatibility; preserve Mint accounts/content |

Do not rewrite originals to normalize tags or move them into a managed download
root. Missing files need deliberate availability/tombstone policy, not cascading
deletion of likes, playlist occurrences, history or aliases. Use root-relative
identity and independently validated paths; filenames are not recording identity.

## Consolidation is a responsibility map, not a queue swap

PostgreSQL is the selected durable authority; pg-boss is the selected job
delivery/scheduling mechanism. A final ADR must address migrations, transaction
composition, retries, leases, concurrency, retention, backup and load isolation.
Replacing BullMQ does not automatically replace Redis event/cache/throttle roles.
Audio-copy's inspected core has no Redis/BullMQ/Qdrant dependency, but original/
managed/staging media, artwork manifests/assets, discovery snapshots and
transcode caches live on disk. Native tools, optional Cobalt/Chromium, network
metadata sources and client storage remain separate resources. Back up database
and files coherently; "PostgreSQL-first" does not mean "all bytes in PostgreSQL."
Donor login limiting is process-local, not a fleet-wide rate-limit replacement.

### Current non-job Redis responsibilities

| Role | Current source | Target consideration |
| --- | --- | --- |
| Audience-scoped events | [Realtime](../../apps/realtime/src/index.ts), [event publisher](../../packages/core/src/events.ts) | Transactional event sequence/outbox; small notification wakeup and refetch/replay, auth/revocation/backpressure/poll fallbacks |
| Cache/leases/source pacing | [Public cache](../../packages/core/src/public-cache.ts), [chart cache](../../apps/web/src/lib/chart-cache.ts) | TTL/size/cleanup, fenced atomic leases, cooldown/Retry-After/abort and no unthrottled outage fallback |
| Rate limits/provider reservations | [Rate limiter](../../apps/web/src/lib/rate-limit.ts), [worker YouTube](../../apps/worker/src/services/youtube.ts), [web YouTube](../../apps/web/src/lib/youtube-search.ts) | Database-clock admission/counters/reservations and aggregate upstream limits |
| Index/health/progress | [Library index](../../apps/worker/src/library-index.ts), [maintenance](../../apps/worker/src/jobs/maintenance.ts) | Bounded schema-owned status/read projections, not queue existence as success |
| Catalog library-interest cursor | [Catalog priorities](../../apps/worker/src/catalog-priority.ts) | Persisted acknowledgements/cursor, verified artist identities and retry without losing previous state |

BullMQ jobs include provider sync beyond core queues and repeat schedules;
[worker queue policy](../../apps/worker/src/queues.ts) defines attempt/backoff/
retention differences. [Chart matching](../../apps/web/src/lib/chart-match-queue.ts)
also has process-local tail/timer work, not a BullMQ queue, worth durable migration.
Analysis and device/party commands already have PostgreSQL domain state; pg-boss
delivery must reconcile that authority, not duplicate it.

| Concern | Selected PostgreSQL-first responsibility | Acceptance for fresh deployment |
| --- | --- | --- |
| Durable commands/jobs | Domain intent/outbox plus pg-boss delivery, dedupe and fencing | Atomic admission/delivery or proved reconciliation; process/DB outage and replay |
| Scheduled/background work | pg-boss schedules with owned task state/checkpoints | No duplicate active schedules; restart/missed-run recovery and cancellation |
| Realtime delivery | Durable event sequence/outbox; notifications only wake readers, polling/replay recovers | Account/public separation, reconnect replay and multi-replica ordering |
| Cache/coalescing | Bounded process cache plus reviewed shared PostgreSQL cache/lease model where needed | Explicit stale/fresh/negative policy, total budgets and lease takeover |
| Rate/source admission | Persisted source permits, database-clock pacing/cooldown and bounded concurrency | Aggregate upstream budgets, abort propagation, fairness and expired-owner fencing |
| Operational status | Durable job/domain states with operator read projections | Inspectable progress/errors/retry, not merely transient queue presence |
| Derived semantic index | Preserve current catalog search/index contract; evaluate PostgreSQL vector option separately | Revision correctness, rebuild/retraction, recall and measured query/index budgets |

Do not claim pg-boss supplies cache, vector search or durable WebSocket delivery.
PostgreSQL `NOTIFY` is transient, not replay storage; send a small wakeup ID rather
than full personal payloads. Competing pg-boss consumers do not broadcast to every
WebSocket replica. Keep audience-scoped state and explicit reconnect recovery,
slow-consumer bounds and active session revocation.
Qdrant is replaced by PostgreSQL/pgvector: an installed vector extension alone is
not an embedding/index/query implementation. Fewer services can concentrate DB
contention and failure blast radius; representative mixed workloads must validate
isolation and recovery before declaring the target simpler operationally.
Reserve listener/auth database capacity separately from background pools; define
job retention/cleanup/autovacuum, concurrency/admission and backup/restore
budgets. Media bytes, FFmpeg, native player/download storage and external provider
services do not become PostgreSQL merely because durable control state does.

## Fresh-install dependency-off gates

Inventory actual Plex and Redis call sites/settings, then map each to a retained
capability or explicit retired integration. Old source/fixtures are comparison
evidence, not production dependencies. Fresh installations import no old
accounts, library rows, secrets or jobs. Optional direct read-only media import
must still preserve originals and separate managed upgrade precedence.

No BullMQ job transfer, legacy-ID backfill or reverse projection is required.
Domain intent/outbox/receipt fencing must protect new-system recovery. Do not
delete or reset an existing installation to simulate a fresh deployment.

Plex removal requires equivalent local search/library/album/artist art/playback
and import/finalization behavior with Plex disabled. Redis removal additionally
requires queue, realtime, cache, rate-limit, source-governor and operator-state
coverage. Retire credentials, settings, network routes and Compose dependencies
in the new deployment after those gates and a reviewed backup/restore rehearsal. Do not edit
current setup guides to claim the unreplaced runtime no longer needs them.

### Dependency-off acceptance ledger

Use a fresh isolated PostgreSQL/pg-boss system with reviewed media mounts/tools,
no Plex configuration/calls and no unaccounted Redis dependency. Demonstrate:
original files unchanged; first and second bounded scans including mount outage/
rename/deletion; playable untagged/ambiguous files; persisted technical metadata
and bounded artwork; member/revocation/Range/HEAD/codec behavior; crash recovery
without duplicate accepted publication; preserved private collections/history/
occurrence queues; WebSocket latency/replay and privacy goals. Semantic
index parity is a separate revision/recall/latency/backfill gate, not a donor
PostgreSQL extension claim.
