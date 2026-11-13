# Combined API, web SDK and fresh-install data

## Confirmed delivery boundary

Build the Audio-copy-based implementation inside the main Mint repository.
Expand its API to cover both systems, implement the separate `packages/sdk`
(`@mint/sdk`) as a server-free typed TypeScript tRPC SDK with runtime-validated
contracts, then rewrite the Next.js web app's data/command
wiring while preserving its current UI, routes and interactions except for the
explicit retirement of anonymous public library browsing at `/browse`. The first
P1 API/SDK/UI slice is bounded approved-member library listing/search at
`/app/library`. Preserve its existing playback and collection controls; do not
remove them. Under D40, move only target backend dependencies necessary for
the preserved UI's integration, including playback/collection actions where
required, into P1. Broader APIs remain in P4. Prioritize a working fresh target
over old-backend runtime continuity; do not defer the UI for legacy compatibility
or build temporary legacy adapters, dual writes or legacy-identity bridges.
An unchanged control or placeholder is not evidence that an action works.

D36 removes the public `/browse` page and its entry links without a redirect or
compatibility handler; ordinary Next.js missing-route behavior applies. This
does not retire the metadata catalog backend or its future browse/search
capabilities, member catalog search, the public landing/login/account-request,
health, artwork or chart surfaces, admin workflows, or backend capabilities.
D35 selects one listing result per playable Library media file. D38 keeps its
real Catalog recording foreign key nullable for unknown or ambiguous identity:
unmatched playable files remain listed and playable without speculative
recording records. D39 blocks recording deletion while media files reference
it, until explicit relink or unlink; never cascade-delete media files. D47
blocks Library-root deletion while media-file rows reference that root, without
cascading media deletion; deletion is possible once references are absent. No
administrator workflow for moving, removing or unlinking media files is selected.

Both Expo applications and the existing `packages/client` (`@mint/client`)
remain untouched. Inventory Expo backend capabilities, but do not wire either
app to the new `@mint/sdk`; neither Expo SDK integration nor
installed-mobile-client compatibility is an initial release gate. Capability
parity is not necessarily wire-format parity. D42 selects only this package
boundary and adds no wire, cookie, response or business policy beyond D37.
REST/OpenAPI is needed only for concrete external integrations.

All production machines receive fresh installations with empty state. No old
accounts, collections, library rows, provider credentials, sessions, queued jobs
or client caches are migrated. This does not authorize deleting existing
deployments, volumes, credentials or original music during development.

## Operation inventory

Inventory Mint HTTP JSON/media routes, native dispatch, Next server actions,
WebSocket events, worker protocols and client operations alongside Audio-copy
procedures. Classify each as implemented, initial delivery, deferred execution,
or explicitly retired. Remote workers are deferred; Plex-specific integrations
are retired. Do not lose a capability simply because it lacks a JSON route.

For each operation record domain owner, consumers, approval policy, IDs/units,
request/response/error schemas, deadlines, paging, cache privacy, idempotency and
recovery. Use public-safe synthetic fixtures, not deployment captures.

Web pages must consume the SDK instead of importing server domain/database
internals. Preserve loading/error/empty states, admin-only actions, account
isolation, audio Range/HEAD, revocation and browser Origin protection.

## Source-specific acquisition parity

Preserve current Mint behavior, not a universal download-on-like rule:

- Browsing/searching and artist metadata enrichment do not acquire audio.
- Explicit recording requests use account-bound choices and conservative source
  identity/version/duration checks before acquisition.
- YouTube liked-song/selected-playlist sync can queue missing songs automatically,
  after existing-library reuse, source safety and ambiguity checks.
- Spotify sync reads authorized metadata and matches local media; it does not
  download missing entries.

Source evidence: [YouTube import and enqueue](../../apps/worker/src/jobs/sync.ts),
[recording requests](../../apps/web/src/lib/music-requests.ts),
[choice matching](../../apps/web/src/lib/request-match.ts),
[source safety](../../packages/core/src/matching.ts), and
[Spotify snapshots](../../packages/core/src/spotify-store.ts).
Preserve original protection, deduplication, official recording evidence,
retryable failures and measured media validation. Metadata enrichment and
acquisition remain independent authorities.

## New target identity and persistence

Distinguish catalog recording/release/edition, playable media file and personal
occurrence identities. Use unit-tagged durations, occurrence-aware playlists
and frozen queue revisions. New accounts retain approval-required membership
and separate admin policy. The P1 listing prerequisite includes only the
target-owned accounts, sessions and approval work it needs; other account/runtime
work remains in P2. D35 preserves the existing user and session fields,
approval rules, Argon2 password hashing and 30-day session lifetime; the target
stores these in fresh Accounts-owned tables, not through legacy-data migration.
Preserve active member and active admin access with opaque, revocable
PostgreSQL-backed cookie sessions. D37 keeps `mint_session`; the same-origin
Next.js gateway forwards only its opaque token to the private API. The API
independently resolves the persisted principal from PostgreSQL on every request,
checking expiry, revocation and account status, not trusting client or Next
identity headers. Native `mn1.` tokens are rejected as browser credentials.
Preserve hashed token storage, HttpOnly, secure and SameSite cookies and origin
protections. The package-level session interface is implemented: the target
API exposes the runtime-validated `accounts.session` query, resolves its
principal from an injected Accounts repository on every request, and never
accepts a client-supplied identity. This is not a login/access-request HTTP
surface. Same-origin Next.js session and approval gateway routes exist, but the
existing UI/global auth are not migrated. The API requires an explicit gateway
token; the separate `@mint/sdk` requires the trusted tRPC URL and gateway token
and can forward only the optional canonical `mint_session` token. It sends
credentials omitted, disables caching and redirects, and does not accept
arbitrary headers or forward identity/IP claims. The server-only Next.js binding
uses this SDK for the accepted bounded gateway routes.
No temporary legacy-auth adapter, JWT or legacy session migration is implied.
Do not retire duplicate playable files or versions, or remove existing
`/app/library` playback/collection controls. Anonymous public library browsing
is retired from the rewrite target, while the metadata catalog and other public
surfaces remain. D38-D39 settle only recording-link nullability and deletion;
the initial Library root/media-file identity storage now exists, but the
complete Catalog/Library schema, availability implementation details, safe
filesystem paths, cursor/search/DTO/mutation rules and import implementation
remain open.
See [D32-D48](../execution/decisions.md#decisions).

Existing-library support is still required: operators may configure read-only
roots after installation. D43 requires these roots to be persisted as
Library-owned PostgreSQL records with stable IDs, so their identities survive
restarts. The initial schema stores `library.roots(id, path, createdAt)` and
`library.media_files(id, rootId, relativePath, recordingId, createdAt)`, with
unique `(rootId, relativePath)` and restrictive foreign keys to both root and
Catalog recording. A nullable recording link preserves unknown or ambiguous
identity. Stored paths are metadata, not proof that a path is safe or that
filesystem access has been validated. D47 makes root references restrictive: a
root cannot be deleted while media-file rows reference it, and deleting a root
cannot cascade-delete media rows. Root deletion becomes possible once its
references are absent, but how an administrator moves, removes or unlinks media
files is not decided.
This does not complete the Library schema or select root-management/deletion
UI, filesystem validation, deployment mount configuration, or automated scan
scheduling/checkpoint persistence. Import without Plex, preserve unknown/ambiguous but playable
files, support repeated scans and safe rename/deletion/mount-outage handling.
D44 requires listings to use persisted verified availability and playback
authorization to recheck the actual file. Missing or unreadable files become
unavailable without deleting their identities; optional tags and analysis do
not block verified audio. Persisted verification is not a playback grant, and
freshness intervals, probe format/budgets and scan scheduling/checkpoint persistence remain
unselected. D45 displays each file's imported tags first, then confirmed
Catalog metadata, then filename/unknown fallback. Preserve original tags and
never treat filenames as recording identity, use them to create Catalog records
or rewrite/deduplicate file metadata. Empty installation must not require a
populated library or bulk dump.

D46-D48 require a dedicated server-only `x-mint-gateway-token` header on every
private `/trpc` call, with missing and invalid credentials rejected. Its value
is a server-injected secret with a 32-byte-random base64url shape; the header
name is public, not the secret value. The target API enforces the header
before routing, including framework errors and unsupported methods, using
constant-time comparison of canonical ASCII values. The SDK requires an
explicit token and sends only the dedicated header plus the optional canonical
session cookie. The API rereads and validates that session for each request;
the gateway secret does not establish user identity. Keep client-IP forwarding
disabled until ingress trust is settled; a shared secret cannot make
browser-supplied forwarded headers trustworthy. Explicit standalone API
configuration, optional initial-admin bootstrap and bounded Next.js gateway
wiring exist; secret rotation, complete web integration, deployment, TLS/proxy
settings and ingress trust remain open. The bootstrap requires all three
`MINT_API_BOOTSTRAP_ADMIN_EMAIL`, `MINT_API_BOOTSTRAP_ADMIN_NAME` and
`MINT_API_BOOTSTRAP_ADMIN_PASSWORD` variables or none; it uses the Accounts
Argon2 binding after migrations and before listen, and an existing
case-insensitive email is never modified. It is not a login/access-request HTTP
flow.

Use new schema migrations and coherent database/media backup and restore.
For fresh targets D41 selects `mint_migrations.__drizzle_migrations` as the
single history table and requires startup migration serialization across API
and worker processes. `runStartupMigrations` takes a packages root and lock timeout, internally
supplies the selected history to `runMigrations`, uses a dedicated pool client
for the session advisory lock and official migrator, and applies the central
journal's platform rate-limit, Accounts, Catalog and Library mappings in that
order, plus platform event/public-cache, Catalog seed-receipt and bounded
ListenBrainz ingestion storage. API
startup invokes the helper before listening; packaging, startup
defaults, pool budgets, environment defaults and deployment integration remain
open.

Accepted foundations are not the integrated UI listing slice. Accounts
lookup/lifecycle/authentication/access-request services and PostgreSQL
schema/repository, concrete Argon2 binding and explicit optional API initial-admin
bootstrap exist. Login and access-request HTTP onboarding remain unwired under
D49's trusted-ingress gate.
The callable API composes fresh-session approval, member status and bounded
admin account listing/role operations; the SDK exposes them. Same-origin
Next.js session, approval and member-status routes are connected, but the
existing UI, global auth and actions remain legacy. Platform admission and
serialized startup migrations exist. Catalog has a six-field recording schema
with checks and simple full-text search, not the full metadata engine,
pgvector parity, artist metadata or provenance. Library has persisted identity
and verified availability, bounded listing/search and confined local media
verification; the API, SDK and Next.js Library GET route are connected.
An explicit bounded root-prefix scanner and confined original-media playback
reader exist; automated scan lifecycle, freshness, broader import and authorized HTTP
playback/collection controls remain open. The standalone API entry point and
base configuration (`apps/api/src/main.ts` and `runtime-config.ts`) and the
`playback-media.ts` reader were already present at the selected baseline. The
reader reopens and reads original media; it does not authorize or implement HTTP
streaming. Admin counts and song/provider details are not covered by the accepted
account slice. Secret rotation, deployment and full worker composition remain
open. P1 remains incomplete because the existing Next.js UI, global auth and
actions still use the legacy backend.

P2 platform primitives now include a callable `startLocalJobRuntime`: it runs
central startup migrations before pg-boss manages its own schema, verifies
configured queue policy, bounds and validates job envelopes, and can enqueue
within a caller-owned PostgreSQL transaction. Singleton-key de-duplication is
limited to queued/retrying/active jobs, not a durable receipt. ListenBrainz now
has domain intent/completion and an opt-in worker; other domain intents/outboxes
and broader worker integration remain work. The central journal
also includes platform event and public-read-cache tables. `PostgresEventLog`
stores public, admin and per-account streams with per-audience sequence order,
bounded replay and a durable replay floor; append can share a caller's
transaction. Authorization, domain payload validation, retention scheduling,
WebSocket transport, producers and consumer recovery are not wired by this
primitive. `PostgresPublicReadCache` stores public metadata only and supplies
bounded keyed leases, fresh/stale/negative/error states, fenced publication and
bounded cleanup; feature validation, freshness, pacing and cleanup scheduling
remain caller-owned.

Catalog's reconciliation service is a read-only bounded algorithm over an
injected reader; it returns provenance, conflicts and review candidates and
never merges records or authorizes acquisition. No production observation/link
reader or backing provenance schema is implemented. Startup seed planning is
deterministic and source-scoped; planning/scheduling counts are not ingested
metadata. `createCatalogSeedStore` and central startup migration `0007` provide
permanent receipts with atomic queue intent through one shared transaction.
Existing receipts do not enqueue or modify queue state; enqueue failure rolls
back the receipt. An existing active singleton can satisfy a newly inserted
receipt without changing that job. The pool/runtime must target the same
database, and callers must configure/start the queue and schedule seeds
explicitly. A separate bounded ListenBrainz ingestion command and opt-in local
worker composition now exist; combined/deployment acceptance remains separate,
and other-source ingestion remains unimplemented.

The seed-store contract is
`insertIfAbsent(job, signal?: AbortSignal)`; the scheduler forwards its signal
through each store call. `createCatalogSeedStore` requires the caller's pool
connection timeout to be 1–2000 ms. It bounds row/lock waits to 1000 ms and the
borrowed transaction to 5000 ms, including statement and idle-transaction
timeouts. Cancellation or transaction timeout destroys the borrowed client
rather than returning an uncertain connection to the pool, rolling back any
uncommitted receipt and enqueue. The pool and job runtime must still share the
same database. These are bounded enqueue semantics, not an ingestion guarantee.
The Library scanner explicitly
imports bounded batches, retains existing identities and evidence, and does
not follow discovered symlinks or sweep unseen paths. Optional private-worker
continuation is available under the limits below; no scheduler or full fairness
guarantee is supplied.

### ListenBrainz startup ingestion

`createCatalogSeedIngestor(pool, {enabledSources, request?}).ingest(payload, signal)`
implements only the fixed `lb-chart` ListenBrainz weekly-global startup seed.
Configuration accepts `[]` or `["listenbrainz"]`; the nine-source pure planner
does not imply nine implemented ingestion adapters. The domain payload is
`{version:1,job}` inside the unchanged platform envelope. Producer/store enqueue
this version explicitly; unsupported sources or payloads fail rather than
silently completing.

The fixed request asks for at most 100 rows (`range=week&count=100&offset=0`),
with a 2,000,000-byte response cap and eight-second fetch budget. The command
budget is 20 seconds; pool connection timeout must be 1–2000 ms. Transactions
use a five-second budget, at most one-second lock waits and client read timeouts;
the publication lease lasts 30 seconds. `CATALOG_LISTENBRAINZ_SEED_QUEUE_V1`
selects queue `catalog.seed.listenbrainz.v1`, concurrency 1, retry limit 5,
60-second initial retry delay with backoff capped at 3600 seconds, 60-second
expiry and seven-day retention/deletion. Pg-boss is the sole retry dispatcher,
not a second domain retry loop.

Central tag `0008_catalog_listenbrainz_seed_ingestion` applies Catalog SQL
`0002_listenbrainz_seed_ingestion.sql`. Two tables retain at most one fixed
startup run plus 100 occurrence-position observations permanently, separate from
the startup intent receipt and expiring queue job. Attribution includes source,
global scope, URL, source period/update/fetch timestamps; observations retain
explicit recording MBIDs, titles, artists, optional release, public listen counts
and native `uuid[]` artist identifiers (at most 100 per row). Repeated identifiers
remain separate occurrences; no canonical recording, authority-link or Library
identity writes occur, and no production reconciliation reader is supplied.

Lease-fenced publication commits observations and completion together. Completion
survives queue retention, restarts and explicit re-enqueue without refetch or
duplicate publication. Empty feeds and feeds without recording IDs have explicit
completion outcomes; unidentified rows are counted, not guessed. Refusals,
cooldowns, pauses, lost leases and retry exhaustion do not become successful
ingestion. Recovery requires explicit queue re-enqueue after the blocking state
is resolved; a permanent startup receipt alone does not dispatch it. There is no
automatic recovery UI/scheduler, periodic refresh, all-source coverage, canonical
metadata integration, live-provider permission or deployment claim.

Disposable PostgreSQL 16/pg-boss fixtures exercise central migration startup,
cardinality and source bounds, lost leases, rollback/restart, retained completion
after queue expiry/re-enqueue, and committed publication followed by a lost queue
acknowledgment and retry without refetch. Injected provider responses establish
these local contracts, not live upstream access or deployment readiness.

### Local worker runtime

The separate `apps/worker/src/local-job-{config,runtime,main}.ts` entry point
composes only the implemented ListenBrainz queue/handler and one startup seed;
it does not replace legacy `src/index.ts` or enable the other eight planner
sources. Required `MINT_LOCAL_WORKER_ENABLED_SOURCES` is JSON `[]` or
`["listenbrainz"]`. `[]` returns disabled without opening a pool, running
migrations, starting queues or fetching providers. Missing/invalid configuration
fails closed; no implicit enablement or inherited legacy DB defaults apply.

When enabled, all settings below are required with prefix `MINT_LOCAL_WORKER_`:

| Suffix | Contract |
| --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Explicit connection fields; port 1–65535; password may be empty but must be present |
| `DB_TLS` | `disabled` or `verify` (certificate verification required) |
| `DB_POOL_MAX`, `DB_CONNECT_TIMEOUT_MS` | Pool 1–16; connection timeout 1–2000 ms |
| `MIGRATIONS_PACKAGES_ROOT`, `MIGRATIONS_LOCK_TIMEOUT_MS` | Absolute packages root; lock timeout 1–2147483647 ms |
| `POLLING_INTERVAL_SECONDS` | 0.5–60 seconds |
| `SUPERVISE_INTERVAL_SECONDS`, `MAINTENANCE_INTERVAL_SECONDS` | Integer 1–86400 seconds |
| `SHUTDOWN_TIMEOUT_MS` | Integer 1000–60000 ms |

`corepack pnpm --filter @mint/worker run build:local` builds
`dist/local-job-main.js`; `start:local` starts that artifact with supplied
environment. External runtime dependencies must be available, and the configured
packages tree must retain `platform/migrations/meta/_journal.json` plus all mapped
domain/platform SQL through central `0009`. Build/start scripts are not container
or deployment wiring. The worker starts central migrations before pg-boss,
validates its queue policy and schedules intent using the atomic receipt adapter.
Existing startup receipts do not recover an exhausted job automatically.

SIGINT/SIGTERM abort source work and stop queues before closing the owned pool;
startup errors clean up and report sanitized phase/error names. Disposable
PostgreSQL 16 fixtures cover the config/runtime/main boundary; a compiled disabled
smoke is not live-provider or deployment evidence. Other-source handlers,
canonical integration, automatic recovery, restore/mixed-load and full P2/P3
readiness remain open.

### Library scan continuation

`scanLibraryRoot` accepts an optional private-worker `cursor` and returns
`nextCursor` while traversal remains unfinished. Callers persist it only after
the invocation succeeds, serialize scans per root and own retries/checkpoints
across process restarts. Status, counters and issues describe each invocation,
not the entire traversal; unfinished aborted files are retried and writes remain
idempotent. Cursor state is not a browser DTO, authorization or a playback grant:
root confinement, read-only access and media verification remain fresh.

Restoring a cursor rereads active directory prefixes in O(active-prefix entries),
not seek-efficient time. `maxReplayEntries` defaults to and caps at 100000;
exceeding the chosen budget raises an actionable input error advising a larger
budget up to that cap or a fresh scan with larger traversal budgets. Huge
directories can therefore remain impossible to finish through continuation.
New-entry/file budgets exclude replay; `replayedEntries` reports its cost.
Active directory identity/stamp and replayed-prefix changes reject stale cursors.
Timestamp collisions can hide unread-suffix changes; additions in completed
directories require a fresh scan. There is no snapshot, universal mutation
detection, full fairness, worker schedule/lease, freshness reconciliation,
deletion sweep, hard filesystem/SQL timeout or playback authorization.

### Reconciliation bounds

Reconciliation accepts at most five references (checked before examining their
entries), fields of at most 500 characters and positive integer durations up to
86,400,000 ms; title plus artist or an explicit reference is required. Each
reader lookup requests 51 rows, retains 50 and reports overflow, returning at
most ten ranked candidates. The caller supplies one consistent read snapshot;
readers must exclude rejected/conflicting and non-MusicBrainz/Wikidata links
before limits and use bounded lexical indexing, not full-catalog scans.
Direct provider IDs and retained authority links can establish explicit
identifier evidence; YouTube/YouTube Music share only explicit video IDs.
Exact normalized metadata remains a review candidate, never identity or a
probability. Title, artist, version and duration differences over 2,000 ms are
conflicts (exactly 2,000 ms is allowed). Aggregate conflicts and truncated
explicit evidence remain visible; lexical overflow alone does not invalidate
clean explicit evidence. Reader failures, oversize and provenance violations
propagate; `automaticMerge` is always false, with no writes or acquisition.

Use coherent backup and restore for data created by the fresh target.
pgvector indexes are derived and rebuildable with revision fencing. Domain intent,
outbox, job receipts and attempts must recover without duplicate side effects.
There is no legacy BullMQ-to-pg-boss transfer or reverse projection requirement.

## Release acceptance

Validate a fresh PostgreSQL/pg-boss/pgvector deployment without Plex, Redis or
Qdrant. Exercise API union coverage through `@mint/sdk` and the preserved Next.js
UI, source-specific requests/imports, WebSocket reconnect/privacy, local workers,
optional providers, empty-state onboarding and optional read-only library import.
Restore tests cover data created by the new installation, not old-version
session/database continuity. See [phases](../execution/phases.md) and
[infrastructure responsibilities](../architecture/plex-free.md).
