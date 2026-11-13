# Target architecture

**Confirmed:** Audio-copy-style domain modularity, TypeScript, Fastify/tRPC,
pnpm/Nx, Drizzle, PostgreSQL/pg-boss and pgvector; no target Plex dependency.
Build in the main Mint repository for fresh installations. **Recommended:**
framework-independent services, narrow exports and domain-owned schemas, composed
by applications. The names below describe the target Mint tree, not donor paths
or a claim that every target package is complete. Actual donor patterns are in the
[source ledger](../research/baselines.md).

**Implemented slices, not an integrated rewrite:** Accounts services and
PostgreSQL storage, platform admission/migration primitives, the six-field
Catalog recording schema, a callable Fastify/tRPC API runtime, and a
separate runtime-validating `@mint/sdk` now exist. The API requires and checks
the dedicated gateway token; the SDK requires it explicitly and forwards only
the optional canonical session token. Its session and approval operations use a
fresh persisted session through the Accounts repository. The runtime requires
explicit settings and notification/error bindings; it is not a standalone
executable. Library provides persisted verification and bounded listing/search,
with a confined Linux opener and full decode verification. The API, SDK and
server-only Next.js session, approval, Library GET and member-status POST routes
are connected and accepted as bounded gateway slices. Admin account listing
and role changes are accepted through the SDK and HTTP API against PostgreSQL,
with fresh persisted active-admin authorization; they are not yet integrated
into the existing admin UI. The existing
UI/auth/actions still use the legacy backend; automated imports, preserved target
UI actions and full Catalog behavior are not implemented.
Neither Expo app nor `@mint/client` has changed.

Audio-copy currently composes `apps/server`, Expo `apps/listener`, Vite
`apps/admin`, and `contracts`, `db-core`, `domain-app`, `domain-catalog`,
`domain-library`, `domain-imports`, `domain-recommendations` packages.
Its four PostgreSQL schemas (`app`, `catalog`, `library`, `imports`) have a
no-cross-schema-SQL/FK contract. The proposed tree below extends that architecture
to Mint's retained domains; do not mistake absent donor packages for permission
to drop Mint behavior.

```text
apps/
  mobile/                  existing Mint Expo app; in place but outside pnpm/Nx
  api/                     Fastify/tRPC, authentication and WebSocket composition
  web/                     Next.js; existing consumer/admin UI using @mint/sdk
  worker/                  background execution and private media composition
packages/
  contracts/               server-free operations, DTOs, errors and event schemas
  client/                  existing @mint/client for Expo consumers; unchanged
  sdk/                     new @mint/sdk; server-free, runtime-validated tRPC SDK for Next.js
  platform/                DB lifecycle, crypto, queue ports, cache and observability
  domain-accounts/          accounts, sessions, approvals and authorization policy
  domain-catalog/           metadata identity, provenance, reconciliation, crawl demand
  domain-library/           read-only media import, file links, search and artwork
  domain-collections/       likes, playlists, folders, invitations and discovery
  domain-providers/         charts, provider account links and source-managed imports
  domain-acquisition/       explicit requests, source choice, intent and durable work
  domain-playback/          server queues, media grants, history and lyrics
  domain-analysis/          measured analysis, leases and backfill lifecycle
  domain-devices/           registry, handoff and single-output parties
  domain-workers/           remote-worker capability contracts; execution deferred
```

`apps/mobile` remains at its current path and is not a pnpm workspace member or
Nx project; do not edit or move it. P1 workspace installation behavior at the
repository root may change, so the existing root install flow is not guaranteed.
The Audio-copy Expo app is in a separate repository and is not part of this
checkout.

API/WebSocket and local background workers run in separate processes with one
PostgreSQL service and bounded independent pools. Next.js remains the web frontend;
business logic moves to exported API domain services, including existing server
actions. The separate `@mint/sdk` is a server-free typed tRPC SDK with
runtime-validated contracts; REST/OpenAPI is added only for concrete integrations.

The API must cover the union of Mint and Audio-copy capabilities. Conflicting
acquisition behavior follows Mint's source-specific policy. Neither Expo app is
modified or rewired in this stage; the existing `@mint/client` remains unchanged
and is not repurposed for the web migration. The separate `@mint/sdk` is for the
Next.js app only. Remote download/analysis execution is deferred, not erased from
the API capability inventory.

The separate Python/Qdrant catalog is replaced by TypeScript domain packages and
PostgreSQL/pgvector. Preserve bulk ingestion, startup seeds, fairness, provenance,
demand and revision-fenced indexing; an extension alone does not provide parity.

## Allowed dependencies

| Importer | Allowed dependencies | Forbidden coupling |
| --- | --- | --- |
| Expo apps | Existing `@mint/client` and server-free contracts; own UI foundation | Database schemas, job runtimes, another app's internals; migration to `@mint/sdk` |
| Browser/admin | New `@mint/sdk` and server-free contracts; own UI foundation | Database schemas, job runtimes, another app's internals |
| Transport adapters | Contracts, trusted-principal policy, exported domain services | Business rules implemented again in route handlers |
| Domain services | Own model/repository ports, contracts, narrow platform interfaces | App/framework imports or another domain's private tables |
| Repository/provider adapters | Own domain ports, platform DB/runtime, reviewed external adapters | Cross-domain writes bypassing the owner |
| Composition roots | Explicit domain exports and runtime bindings | Becoming a new generic business-logic package |
| Background workers | Exported commands/ports and versioned job envelopes | Independent state transitions outside domain fencing |

Use exports, dependency linting and architecture tests to enforce this graph.
Cross-domain operations use typed ports/events or an explicit owner-coordinated
transaction. Contracts remain server-free; `platform` must not become the old
mixed `core` under another name. Exactly one domain writes each aggregate.

## Schema and authority

| Owner | Authoritative data |
| --- | --- |
| Accounts | Users, role/status, approvals, sessions and encrypted account links policy |
| Catalog | Source identities, recording/release/artist reconciliation and provenance |
| Library | Media files, root/import checkpoints, catalog links and availability |
| Collections | Account likes, playlist occurrences/revisions, folders and invitations |
| Providers | Source-managed playlist membership, aliases, sync cursors and chart snapshots |
| Acquisition | Account intent, shared recording work, source choices, attempts and outbox |
| Playback | Account queue snapshots/entries, history, lyrics correction and grant policy |
| Analysis | Measured results/version, schedule/leases and backfill state |
| Devices/workers | Device commands/acknowledgements and separately scoped worker credentials/leases |
| Platform | The single Drizzle migration runner/journal and shared primitives, not feature-owned rows |

For the P1 member-library listing, Catalog recordings and Library media files
remain separate entities connected by a real PostgreSQL foreign key; do not
collapse them into a denormalized display/playability table. The foreign key
links Library media files to confirmed Catalog recordings when present, and is
nullable for unknown or ambiguous identities (D38). Verified files can be
listed without speculative recording records; target playback remains work. D35 selects one
listing result per playable media file, so distinct playable files or versions
are not merged into one recording result. PostgreSQL blocks recording deletion
while files reference it, until explicit relinking or unlinking; media files
must never be cascade-deleted (D39). These decisions do not specify the full
schema, safe filesystem paths, cursor/search/DTO/mutation rules or import
implementation. Anonymous public library browsing at `/browse` is removed
without a redirect or compatibility handler (D36); the metadata catalog backend
and other public surfaces remain in scope. D43 requires configured read-only
roots to be persisted as Library-owned PostgreSQL records with stable IDs; the
initial identity schema now provides `library.roots` and
`library.media_files`, with stable IDs, unique root-relative paths, nullable
recording links and restrictive references. Stored root paths are metadata,
not filesystem validation or proof of safe access. D47
requires PostgreSQL to block deletion while media-file references remain,
without cascading media deletion, and allows deletion once no references remain.
No administrator workflow for moving, removing or unlinking media files is
selected. This identity foundation does not complete the Library schema or
select management/deletion UI, deployment mounts or scanner implementation.
The implemented Linux confined opener and trusted local verification compose
persisted paths with bounded ffprobe and full ffmpeg decode, not playback grants
or universal format and filesystem timeout guarantees. D44 uses persisted verified
availability for listing and rechecks the actual file when playback is
authorized. Missing/unreadable files become unavailable without deleting their
identities, and optional tags/analysis do not block verified audio; persisted
verification is not a playback grant. D45 displays imported file tags first,
then confirmed Catalog metadata, then filename/unknown fallback, without
rewriting originals or inferring recording identity from filenames. These
decisions do not specify availability freshness or an automated scanner. D33
moves only the account/session/approval work needed for this slice into P1;
other account/runtime work remains in P2. D34-D35 preserve current
Accounts-owned user/session fields, approval
rules, Argon2 password hashing, active member/admin access and the 30-day
opaque, revocable PostgreSQL-backed cookie session model. D37 keeps
`mint_session` and forwards only its opaque token via a same-origin Next.js
gateway to the private API. The API independently resolves the principal from
PostgreSQL on every request, checking expiry, revocation and account status,
never trusting client or Next identity headers. Browser authentication rejects
native `mn1.` tokens. Retain hashed token storage, HttpOnly, secure and SameSite
cookies and origin protections. Session and approval now run through the
server-only Next.js gateway, SDK, API and persisted Accounts repository.
D40 moves only backend dependencies
necessary for preserved Next.js UI integration into P1, including playback or
collection actions where needed; broader APIs remain in P4. The target actions
must work, not merely appear as controls or placeholders, and no legacy adapter,
dual write or legacy-identity bridge is required. See [D32-D48 and the remaining
gates](../execution/decisions.md#decisions).

## Next.js gateway and API trust

D46-D48 require a dedicated server-only `x-mint-gateway-token` header to
authenticate every private `/trpc` call, in addition to D37's opaque
session-token forwarding. The API rejects missing/invalid gateway
credentials through an early hook, including framework errors and unsupported
methods; comparison uses canonical ASCII values in constant time. Its
repository-injected session lookup rereads the opaque session on every call.
The separate SDK requires an explicit gateway token and forwards only the
optional canonical session cookie. Neither service secret nor header conveys
user identity; the API resolves identity solely from the persisted session.
Keep client-IP forwarding disabled until ingress trust is settled. A shared
secret does not make browser-supplied forwarded-IP headers trustworthy.
Secret generation/rotation and lifecycle, standalone startup/deployment wiring,
TLS/proxy settings and ingress trust
rules remain unselected or unimplemented.

Domain schemas can share PostgreSQL; schema boundaries do not imply independent
databases. PostgreSQL foreign keys across domain and schema boundaries are
allowed. The platform owns one Drizzle migration runner and journal, which
applies migration files owned by domain packages. D41 selects the single
physical history table `mint_migrations.__drizzle_migrations` for fresh targets
and requires startup migrations to be serialized across API and worker
processes. The implemented `runStartupMigrations` helper takes a packages root and
`lockTimeoutMs`, internally supplying the selected history to `runMigrations`.
It obtains a session-level advisory lock using a dedicated pool client also
passed to the official migrator, and restores/releases the lock safely. The
stable two-integer key is `[0x4d494e54, 0x4d494752]`. The central journal now
maps platform rate limits, Accounts, Catalog, Library identity and Library
listing migrations, in that order.
The callable API runtime invokes it before listening; worker composition and packaged migration artifacts,
timeout defaults, pool budgets, environment defaults and deployment changes
remain unimplemented or unselected. Domain SQL for `platform.rate_limits`
creates the `platform` schema, so a separate history schema avoids a collision.
Donor no-cross-schema SQL is a
documented contract, not established raw SQL enforcement; Mint's selected
foreign-key policy differs. Add architecture checks to make the selected policy real.
Use new target identities and explicit recording/file/occurrence distinctions.
No legacy-data converter is required for fresh installs. Existing read-only roots
must remain safely importable; do not reset a running installation or rewrite files.

## Runtime acceptance still required

The stack and separate API/local-worker topology are selected. The platform
migration helper and history/journal mechanism are invoked by the callable API
runtime; validate packaged migration execution and cross-process startup through
real API/worker composition. API/SDK listing and its new Next.js route do not
provide the unchanged member UI listing flow. Transaction,
queue/realtime/cache/vector semantics still require implementation evidence.
See [replacement responsibilities and retirement gates](plex-free.md).
Prefer one reviewed decision at a time with deployment, cache,
job receipt, schema fingerprint and client compatibility evidence. Preserve
Mint's private-media boundaries, optional acquisition providers and NAS-friendly
Compose support. Remote worker execution and Expo delivery are deferred; donor
development Compose is not production parity.
