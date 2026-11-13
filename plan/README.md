# Mint full rewrite knowledge base

**Status:** this folder records the target, evidence, preservation constraints,
current bounded implementation and ordered migration gates. The current
user request authorizes the rewrite in dependency-ready slices, not external
tooling installation, deployment, Git publication or deletion of installations.
The coordinator accepted P0's inventory and crosswalk; P1 and the application
rewrite are not complete.

## Confirmed direction

- Rebuild Mint fully, rather than treating API cleanup as the final destination.
- Follow Audio-copy's architecture, folder design and domain modularity.
- Compare seeding/discovery/crawling and agentic coding.
- Prefer eliminating Plex entirely in the rewrite and simplifying infrastructure
  around PostgreSQL and pg-boss, following Audio-copy. Exact implementation and
  retirement gates remain to be designed; the current runtime is not Plex-free.
- Adopt TypeScript, Fastify/tRPC, pnpm/Nx, Drizzle and PostgreSQL/pg-boss.
  Reimplement the Python catalog in TypeScript with PostgreSQL/pgvector parity.
- Build inside the main Mint repository. Expand the Audio-copy API to cover both
  systems, add a separate `packages/sdk` (`@mint/sdk`) for the web migration, and
  rewire the existing Next.js web UI to it. Keep the existing `packages/client`
  (`@mint/client`) unchanged for its Expo consumers.
- Leave both Mint and Audio-copy Expo applications untouched.
- Start fresh with empty state on all production machines: no legacy account,
  collection, library or job migration. Direct read-only library import remains
  a supported feature, not a requirement to import existing files at installation.
- Remove anonymous public library browsing at `/browse` and its entry links,
  without a redirect or compatibility handler (D36), and
  re-anchor the first P1 API → `@mint/sdk` → unchanged Next.js UI slice on
  approved-member library listing. Keep the metadata catalog backend and its
  future capabilities, approval-required membership, separate admin policy and
  source-specific acquisition/matching behavior. D35 preserves current
  Accounts fields and approval/password/session behavior, and selects one
  listing result per playable file. Other public surfaces are not in this
  retirement decision.
- Keep WebSocket updates with PostgreSQL-backed recovery. Run separate API and
  local-worker processes sharing one PostgreSQL service; remote workers are deferred.

**Current delivery scope:** preserve the current web layout, interactions and
features except the explicit retirement of anonymous public library browsing,
while replacing backend/client wiring. Preserve `/app/library` playback and
collection controls; move only their necessary target backend dependencies
forward into P1 instead of deferring UI integration for legacy compatibility
(D40). Broader APIs remain in P4; unchanged controls or placeholders do not
establish working actions. No temporary legacy adapters, dual writes or
legacy-identity bridges are required. API
capability coverage includes mobile-facing operations, but modifying or
integrating either Expo app is outside this rewrite stage. Do not infer old-client
wire compatibility from capability parity.

The P1 pnpm/Nx workspace foundation has been accepted. Additional runtime
foundations and bounded slices are implemented: Accounts services and PostgreSQL
storage, an explicit Argon2-backed optional initial-admin bootstrap, platform
admission and serialized startup migrations, callable pg-boss and durable
PostgreSQL event/cache primitives, a callable authenticated API runtime, the
separate runtime-validating `@mint/sdk`, a six-field Catalog recording schema,
and Library identity, verified availability, bounded listing/search and trusted
local media verification. The API exposes
fresh-session-authorized listing and account operations. A server-only Next.js
binding and same-origin session and approval routes are implemented and exercised
through the API and PostgreSQL; Library GET and member-status POST routes are
also accepted following an actual media-to-Next.js integration journey. Admin
account listing and role changes are accepted through the SDK, HTTP API and
PostgreSQL, with fresh active-admin authorization; their existing UI remains
legacy. Bootstrap is disabled when all `MINT_API_BOOTSTRAP_ADMIN_EMAIL`,
`MINT_API_BOOTSTRAP_ADMIN_NAME` and `MINT_API_BOOTSTRAP_ADMIN_PASSWORD`
variables are absent; supplying any requires all three. It runs after
migrations and before listen, inserts an active admin only when the
case-insensitive email is absent, and never modifies an existing account.
Login/access-request HTTP routes remain unwired under D49. These do not complete P1:
the existing Next.js UI, layout, global auth and actions still use the legacy
backend, preserved playback/collection dependencies are not migrated, and
the accepted bounded slices are not integrated into a working existing UI.
The standalone API entry point and base validated runtime configuration
(`apps/api/src/main.ts` and `runtime-config.ts`) already existed at the selected
baseline; optional admin-bootstrap configuration/wiring is new. The Library original-media reader (`playback-media.ts`) also existed:
it reopens and reads original media but is not authorized HTTP streaming.
Admin listing defaults to 50, caps at 100 and binds its UUID cursor to strict
status/members and search filters; it returns only safe account fields. Role
changes reject either self-role value with the preserved error copy, allow
pending updates and treat missing targets as no-ops. Admin counts, song/provider
details and other management operations remain outside this slice.
The approved-member listing depends on the narrowly required target-owned
account/session/approval work moved into P1 by D33; other account/runtime work
remains in P2. The Accounts approval decision service is implemented at package
level and through the API, where it requires a trusted active admin from fresh persisted-session
composition; an actor DTO is not authentication or browser-controlled HTTP
input. D34-D35 preserve current account/session fields and approval
rules, Argon2 password hashing, active member and active admin access, and
30-day opaque, revocable PostgreSQL-backed browser cookie sessions. D37 keeps
`mint_session`: a same-origin Next.js gateway forwards only its opaque token
to the private API, which independently resolves the principal from PostgreSQL
on every request, checking expiry, revocation and account status rather than
trusting client or Next identity headers. Native `mn1.` tokens are not browser
credentials; preserve HttpOnly, secure, SameSite and origin protections. The
session lookup and gateway-auth checks now exist in the API, SDK and server-only
Next.js binding.
The listing returns one result per playable file. D38-D39 make the normalized
recording foreign key nullable for unknown or ambiguous identity, without
speculative recording records, and block deletion of a linked recording until
explicit relink or unlink; media files are never cascade-deleted. The bounded
scanner supports opt-in private-worker continuation with caller-owned checkpoint
persistence and per-root serialization, but replay scalability, scan scheduling,
availability freshness and broader import remain open. The
implemented session and approval procedures do not add login/access-request
HTTP routes; no temporary legacy-auth adapter is selected.
D43-D45 require configured
read-only roots to be persisted as Library-owned records with stable IDs; use
persisted verified availability for listings and recheck files when playback is
authorized; and show each file's imported tags before confirmed Catalog
metadata, then filename/unknown fallback, without rewriting originals or using
filenames as recording identity. Missing/unreadable files become unavailable
without losing identity, and optional tags/analysis do not block verified audio.
The implemented identity schema has `library.roots` and
`library.media_files`, with unique root/relative-path pairs and restrictive
references to roots and Catalog recordings. Stored paths are metadata, not
proof of safe filesystem access. A Linux confined opener and bounded ffprobe
and full ffmpeg decode are composed with persisted root/file lookup and positive
verification; inconclusive failures preserve prior state. A separate bounded
scanner explicitly imports bounded batches with optional continuation; active
prefix replay is bounded and offers no snapshot or full fairness guarantee.
Scheduling and freshness remain caller-owned work. Full format support, hard filesystem timeouts and
playback grants remain open.
Root-management UI and availability freshness remain open. D47
blocks deletion of a Library root while media-file references remain, without
cascading media deletion; deletion is possible once references are absent, but
no administrator workflow for moving, removing or unlinking media files is
selected.
For private Next.js-to-API calls, D46-D48 require a dedicated server-only
`x-mint-gateway-token` header on every private `/trpc` call, with missing or
invalid credentials rejected. The API and separate SDK now
enforce this boundary; the SDK requires an explicit gateway token and can
forward only the optional canonical session token. D37's API-resolved session
remains the sole user identity. Client-IP forwarding stays disabled until
ingress trust is settled; browser-supplied forwarded headers are not trusted.
Secret lifecycle/configuration, deployment, ingress and TLS/proxy settings
remain unimplemented or unsettled.
For fresh targets D41 selects `mint_migrations.__drizzle_migrations` and
serialized startup migrations across API and worker processes. The platform
helper implements the dedicated-client session advisory lock and central
journal, which maps platform rate limits, Accounts, Catalog, Library identity
and listing, then platform events/public cache, Catalog startup seed receipts
and bounded ListenBrainz ingestion storage.
Public `runStartupMigrations` takes a packages root
and lock timeout, and internally supplies the selected history to
`runMigrations`. The callable API runtime invokes this before listening, with
explicit pool, migration and listener configuration and notification/error
bindings. The standalone entry point and base validated runtime configuration
already existed at the selected baseline. The callable local pg-boss runtime
also invokes central migrations before pg-boss creates/upgrades its own schema;
the PostgreSQL public-read cache stores public metadata only and supplies
bounded leases, stale/negative/error states and fenced publication.
Feature-specific identity, validation, freshness, provider pacing and cleanup
scheduling remain caller-owned. A separate opt-in local worker now composes
ListenBrainz-only startup ingestion with explicit settings, bounded pool/timeouts
and `build:local`/`start:local` scripts. Disabled mode opens nothing; enabled
artifacts need the central journal and mapped SQL through `0009`. See
[worker configuration](migration/compatibility.md#local-worker-runtime).
Broader worker integration, resource tuning and deployment remain gates. See
[D32-D48 and the remaining gates](execution/decisions.md#decisions).

Additional bounded slices in this tranche are not phase completion: platform
provides a callable pg-boss local-job runtime, audience-scoped PostgreSQL event
log and public-read cache. The separate opt-in ListenBrainz worker consumes the
job runtime; the legacy worker has not migrated to it, and event-log/cache
integration with domain producers and the existing WebSocket service remains
open. Catalog exposes read-only reconciliation
through a bounded reader port and deterministic startup seed planning. No
production reconciliation reader/schema/API is implemented. Seed adapter code
and its receipt migration are included in central startup tag `0007`. A separate
ListenBrainz-only command now persists at most 100 attributed weekly-global
occurrences and one permanent completion row under central tag `0008`, without
canonical recording, authority or Library writes. Its versioned domain payload,
queue/retry bounds and explicit-recovery limits are documented in
[the ingestion contract](migration/compatibility.md#listenbrainz-startup-ingestion).
Combined worker acceptance, other-source ingestion, canonical
integration and refresh remain separate gates, not a complete metadata pipeline.
The P4 playback slice now provides fresh-session-authorized, account-owned
history record/list/delete and private-session operations through the API and
SDK. It uses verified Library media, per-account event idempotency, the existing
one-second/completion thresholds and transactionally fenced deletion/privacy
boundaries; broader P4 capabilities remain open.
Scanner continuation replays active directory prefixes within a separate budget;
huge directories can exceed its cap and completed-directory additions require a
fresh scan. See [the precise limits](migration/compatibility.md#library-scan-continuation).
The planner alone is
not durable scheduling, and queued seed intent is not fetched metadata.

Build in dependency-ordered slices, then validate a fresh installation. Earlier
coexistence/backfill proposals are superseded by the fresh-install decision.

## Reading map

| Document | Purpose |
| --- | --- |
| [Baselines and evidence](research/baselines.md) | Revision-pinned source ledger, current implementation and evidence limits |
| [Mint operation inventory](research/mint-operation-inventory.md) | Mint routes, actions, events, workers and explicit target dispositions |
| [Audio-copy operation inventory](research/audio-copy-operation-inventory.md) | Revision-pinned donor procedures/contracts, dispositions and license evidence |
| [Seeding, discovery and crawling](research/discovery.md) | Compare metadata ingestion, local imports and listener recommendations |
| [Agentic coding](research/agentic-coding.md) | Repository boundaries, portable context and verification gaps |
| [Target architecture](architecture/target.md) | Proposed package tree, allowed dependencies and schema ownership |
| [Plex-free infrastructure](architecture/plex-free.md) | Library replacement responsibilities, PostgreSQL/pg-boss consolidation and dependency retirement |
| [Feature decisions](migration/features.md) | Preserve, rebuild, adapt or deliberately retire |
| [API, identity and data](migration/compatibility.md) | Combined API coverage, SDK/web integration and fresh-install data rules |
| [Phases and done gates](execution/phases.md) | Prerequisites, ownership and measurable exit criteria |
| [Decisions, questions and risks](execution/decisions.md) | Confirmed decisions and remaining engineering evidence |

## Evidence status and maintenance

Source reports for Mint `82bd987` and Audio-copy `5939dd3` are
integrated with source links and runtime/default/unsupported distinctions.
The inventory and crosswalk are accepted P0 evidence, not runtime work or
validation of the future target; historical test counts do not validate it either.
Focused Mint Plex/Redis and donor Plex-free/PostgreSQL consolidation reports are
also integrated, including scan/probe/art/realtime gaps and dependency-off gates.

The slices above do not establish a working unchanged web listing, full
metadata/library behavior, or integrated web actions. Catalog currently has a
six-field recording schema with checks and simple full-text search, not the
complete metadata engine or pgvector parity; automated scanning and full import
remain future work. Login/access-request HTTP onboarding remains unwired. The stack, Plex elimination and
PostgreSQL/pgvector consolidation are confirmed directions, not proof of
implemented replacements. User permission to reuse Audio-copy source is
recorded in [D31](execution/decisions.md#decisions); third-party licensing
remains separate. Target workload: about 20 concurrent listeners
through Cloudflare Tunnel, 20,000 imported songs and 200 new songs/day.
Record accepted changes in the
[decision register](execution/decisions.md), update source revisions and link the
affected acceptance gate. Keep this folder public-safe: no deployment settings,
credentials, private library records, transcripts or session evidence.

Current product and engineering authority remains
[product decisions](../agents/product-decisions.md) and
[engineering](../agents/engineering.md). This plan describes a future target;
existing packages and migration tooling do not establish target completion or
acceptance of the integrated runtime.
