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
protections. The package-level session interface is implemented: the unstarted
API exposes the runtime-validated `accounts.session` query, resolves its
principal from an injected Accounts repository on every request, and never
accepts a client-supplied identity. This is not a login/access-request HTTP
surface or Next.js gateway integration. The API requires an explicit gateway
token; the separate `@mint/sdk` requires the trusted tRPC URL and gateway token
and can forward only the optional canonical `mint_session` token. It sends
credentials omitted, disables caching and redirects, and does not accept
arbitrary headers or forward identity/IP claims. Next.js does not yet use this
SDK.
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
UI, filesystem validation, deployment mount configuration or scanner
implementation. Import without Plex, preserve unknown/ambiguous but playable
files, support repeated scans and safe rename/deletion/mount-outage handling.
D44 requires listings to use persisted verified availability and playback
authorization to recheck the actual file. Missing or unreadable files become
unavailable without deleting their identities; optional tags and analysis do
not block verified audio. Persisted verification is not a playback grant, and
freshness intervals, probe format/budgets and scanner implementation remain
unselected. D45 displays each file's imported tags first, then confirmed
Catalog metadata, then filename/unknown fallback. Preserve original tags and
never treat filenames as recording identity, use them to create Catalog records
or rewrite/deduplicate file metadata. Empty installation must not require a
populated library or bulk dump.

D46-D48 require a dedicated server-only `x-mint-gateway-token` header on every
private `/trpc` call, with missing and invalid credentials rejected. Its value
is a server-injected secret with a 32-byte-random base64url shape; the header
name is public, not the secret value. The unstarted API enforces the header
before routing, including framework errors and unsupported methods, using
constant-time comparison of canonical ASCII values. The SDK requires an
explicit token and sends only the dedicated header plus the optional canonical
session cookie. The API rereads and validates that session for each request;
the gateway secret does not establish user identity. Keep client-IP forwarding
disabled until ingress trust is settled; a shared secret cannot make
browser-supplied forwarded headers trustworthy. Secret lifecycle/configuration,
Next.js wiring, application startup, deployment, TLS/proxy settings and ingress
trust remain unimplemented or unresolved.

Use new schema migrations and coherent database/media backup and restore.
For fresh targets D41 selects `mint_migrations.__drizzle_migrations` as the
single history table and requires startup migration serialization across API
and worker processes. `runStartupMigrations` takes a packages root and lock timeout, internally
supplies the selected history to `runMigrations`, uses a dedicated pool client
for the session advisory lock and official migrator, and applies the central
journal's platform rate-limit, Accounts, Catalog and Library mappings in that
order. Application startup does not yet invoke the helper; packaging, startup
defaults, pool budgets, environment defaults and deployment integration remain
open.

Accepted foundations are not the integrated UI listing slice. Accounts
lookup/lifecycle/authentication/access-request services and PostgreSQL
schema/repository/bootstrap exist; login and access-request HTTP onboarding and
the concrete Argon2 binding remain unwired under D49's trusted-ingress gate.
The callable API composes fresh-session approval, member status and bounded
admin account listing/role operations; the SDK exposes them. Same-origin
Next.js session, approval and member-status routes are connected, but the
existing UI, global auth and actions remain legacy. Platform admission and
serialized startup migrations exist. Catalog has a six-field recording schema
with checks and simple full-text search, not the full metadata engine,
pgvector parity, artist metadata or provenance. Library has persisted identity
and verified availability, bounded listing/search and confined local media
verification; the API, SDK and Next.js Library GET route are connected.
Scanner, freshness, broader import, playback-time checks and preserved
playback/collection controls remain open. Admin counts and song/provider
details are not covered by the accepted account slice; executable startup,
secret lifecycle and worker composition remain open.
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
