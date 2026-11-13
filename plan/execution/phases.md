# Ordered implementation phases and done gates

The coordinator accepted P0's inventory and crosswalk deliverable. P0 is evidence and inventory only, not runtime implementation. The P1 pnpm/Nx
workspace and bounded runtime slices are implemented, but P1 and the application
rewrite are not complete: the unchanged Next.js UI/global auth/actions and
preserved playback/collection operations are not integrated with the target
backend. The standalone API entry point/base configuration and Library original-media
reader were already present at the selected baseline; the reader is not
authorized HTTP streaming. Fresh installations supersede old
coexistence/backfill/cutover proposals. Build inside Mint; neither Expo app
changes.

| Phase | Prerequisites | Work | Done gate |
| --- | --- | --- | --- |
| P0 Evidence/inventory | None | Union of Mint and donor API capabilities, web routes/actions, licenses and owned contracts; no runtime implementation | Every capability has owner, source and initial/deferred/retired disposition; inventory and crosswalk accepted |
| P1 Stack/contracts | P0; D25, D28-D30, D32-D49 | **Implemented slices:** pnpm/Nx workspace excluding Expo; Accounts storage, session, approval, atomic member-status and bounded admin account listing/role operations; platform admission and serialized migrations; six-field Catalog schema; Library identity, verified availability, bounded UUID-keyset search/listing and trusted local verification with confined Linux access and full decode; callable API and server-free validated SDK. The standalone API entry point/base configuration predate this tranche. An explicit optional Argon2-backed initial-admin bootstrap now runs after migrations and before listening. API authorization uses fresh persisted sessions. Server-only Next.js session, approval, Library GET and member-status POST routes are connected and accepted as bounded slices; admin listing and role changes are accepted at SDK/API level, not integrated into the UI. **Remaining:** unchanged UI/global auth/action integration and its playback/collection dependencies; admin counts and song/provider details; login/access-request HTTP onboarding under D49; secret lifecycle and deployment; worker composition, scanner checkpoint persistence/scheduling, freshness and playback-time authorization. Keep `@mint/client` and both Expo apps unchanged. | Enforce the dependency graph and validated envelopes. API and worker startup must use packaged, serialized migrations. Active members and admins must use bounded listing/search through SDK and unchanged Next.js UI, with preserved actions working through target dependencies, not placeholders or legacy adapters. Preserve account fields, approval, Argon2 and 30-day opaque sessions; D49 defers IP-limited onboarding until trusted ingress. Persist verified availability with playback-time file rechecks; missing/unreadable files retain identity. Show imported tags before confirmed metadata and filename fallback; do not infer recording identity. Keep restrictive recording/root references and no cascade. D36 removes public `/browse` without redirect. Bounded API and gateway slices do not establish P1 completion. |
| P2 Fresh data/runtime | P1 | **Implemented slices, not phase completion:** fixed-window admission and central serialized migrations; callable local pg-boss runtime; opt-in ListenBrainz worker with atomic intent and permanent ingestion completion; durable per-audience PostgreSQL replay; public-only PostgreSQL cache; optional initial-admin bootstrap. Separate worker build/start scripts require explicit settings and central journal/SQL through `0009`. **Remaining:** broader domain handlers/outboxes and recovery, event producers and WebSocket consumers, image/deployment wiring, backup/restore and mixed-load acceptance. Login/access-request HTTP onboarding stays deferred under D49. | Empty deployment works; privacy, transaction/outbox/recovery and new-system restore tests pass. Queue delivery, durable domain receipts, event replay/refetch and WebSocket recovery are validated in integrated API/worker/runtime flows. |
| P3 Catalog/library | P2; P1 root/availability/identity contracts | **Implemented bounded slices:** read-only Catalog reconciliation through an injected reader; deterministic source-scoped planning and atomic permanent receipt/queue intent (central tag `0007`); ListenBrainz-only opt-in worker/command retaining at most 100 attributed weekly-global occurrences plus one permanent run (tag `0008`, domain payload `{version:1,job}`), without canonical/authority/Library writes; read-only Library scanning with private-worker continuation and caller-owned persistence/serialization. **Remaining:** combined/deployment acceptance, other-source ingestion, canonical integration, production reconciliation reader/schema/API, refresh/recovery orchestration, full metadata engine, pgvector, bulk imports, scalable/fair scans, availability freshness and artwork. Pg-boss retries do not turn cooldown/pause/exhaustion into completion or supply automatic recovery. Scanner replay is O(active-prefix entries), bounded by default/cap 100000; huge directories may not finish and completed-directory additions need a fresh scan. Neither snapshots/full fairness nor complete P3 are established. | Mint ingestion/fairness/index parity; repeated/resumable scans and mount loss; untagged playback; no browse acquisition; unavailable files retain identity and playback rechecks the actual file; root deletion is blocked while media-file references remain |
| P4 Expanded domain API | P2; P3 availability/identity contracts | **Implemented slice, not phase completion:** account-owned listening history has a playback-domain schema/repository, authenticated API and runtime-validated SDK for recording, bounded history pages, per-entry/all deletion, and private-session state. It preserves the one-second threshold, duration/completion rules, event idempotency, privacy boundaries and stale-event rejection. **Remaining:** broader collections, queues, providers, source-specific requests/acquisition, playback/lyrics/analysis/device commands and combined recovery fixtures. | History remains private to a fresh active account; only verified media can be recorded; retries are idempotent per account; deletion/private-session boundaries reject stale work; validated API/SDK/PostgreSQL fixtures pass. Other P4 operations and local-worker crash recovery remain open. |
| P5 SDK and Next.js web | P1; remaining P4 operation contracts | Complete `@mint/sdk` and replace remaining web backend/data wiring while preserving UI/admin workflows; P1 does not wait for all P4 APIs. Keep `@mint/client` and both Expo apps untouched | Every current web feature uses `@mint/sdk` or documented media transport; no Expo changes |
| P6 Integrated operations | P3, P4, P5 | WebSockets, separate local workers, optional providers, deployment and mixed workloads | No Plex/Redis/Qdrant dependency; 20 listeners/20k library/200 daily additions exercised with truthful results |
| P7 Fresh release readiness | P6 | Installation/backup/restore guidance, empty-state and optional-library onboarding | Fresh installation rehearsal and feature ledger complete; no legacy data transfer or remote-worker execution required |

Contract-stable portions can proceed in parallel; row order alone does not create
dependencies. Keep one schema/migration integrator, one lockfile writer and one
domain-map writer. Do not introduce old/new production dual writers. The
migration helper is called by the API and callable local job runtime, but neither
establishes packaged application-worker startup or deployment configuration; the
API, SDK and new route do not establish a working unchanged Next.js UI listing
flow.

The callable API runtime composes the Accounts repository, serialized migrations
and a listener with explicit settings and notification/error bindings. Its
standalone entry point and base runtime configuration existed at baseline. The
optional all-or-none admin-bootstrap environment configuration is new: it uses
the Accounts Argon2 binding after migrations and before listen, without changing
an existing account.
Session
lookup, approval, member status, admin account listing/role changes and Library
listing are available over HTTP.
Next.js session, approval, Library and member-status routes are wired and accepted
as bounded slices; admin listing and role changes have SDK/API coverage but no
integrated admin UI. Deployment packaging and existing UI integration remain
unfinished. An actor DTO is not authentication and must not be browser-controlled input.

## Mandatory gates

| Gate | Required evidence |
| --- | --- |
| Coverage | Mint and donor API union, existing web routes/actions and explicit deferred execution |
| Authorization | Public/pending/member/admin policy, revocation, account/cache/event isolation |
| Data | New recording/file/occurrence identities, frozen queues, optional read-only import and coherent restore |
| Catalog | Seeds/durable misses, bulk resume, demand/source fairness, refresh/retraction and pgvector parity |
| Acquisition | Mint-specific import/request triggers, local reuse, conservative source matching and no speculative downloads |
| Media | Confined private grants, Range/HEAD, compatibility conversion and existing web offline behavior |
| Events/jobs | Durable intent/receipts, fenced attempts, source cooldowns, WebSocket reconnect and backpressure |
| Scale | About 20 tunnel listeners, 20k files and 200 additions/day under mixed API/job/index load |
| Scope | Neither Expo app modified; remote execution deferred; Next.js layout/interactions preserved |
| Tooling | Package/schema/import enforcement, focused tasks and truthful skipped/integration coverage |

Physical-device/mobile integration is deferred with the untouched Expo apps, not
claimed complete by API fixtures. Compilation/default test counts do not prove
live providers, tunnel performance or media recovery.

The first executable slice is bounded approved-member library listing/search
with cursor, consumed by `@mint/sdk` and the unchanged Next.js UI, returning one
result per playable media file. D38-D39 preserve unmatched playable files with
nullable confirmed recording links and block deletion of referenced recordings
until explicit relink or unlink, never cascading media deletion. D43-D45 select
persisted stable-ID roots, verified listing availability with a playback-time
file recheck, and read-only file-tag-first display with Catalog and
filename/unknown fallbacks. D47 blocks deleting roots while media-file
references remain, without cascading media deletion; root deletion is possible
after references are absent, but no file-move/removal/unlink workflow is
selected. D46-D48 select server-only shared-secret Next.js-to-API
authentication, requiring `x-mint-gateway-token` with a server-injected
32-byte-random base64url secret on every private `/trpc` call; missing or
invalid credentials are rejected. D37's persisted session remains the sole
user identity, and client-IP forwarding remains disabled until ingress trust is
settled. Secret lifecycle/configuration, ingress trust, full schema/root fields,
automated scan lifecycle, freshness, playback-time checks and broader import remain work. The
implemented confined opener and bounded verifier do not provide full format
coverage or hard filesystem timeouts. D33 moves only its required account/session/
approval prerequisite into P1; other account/runtime work remains in P2. D34-D35
preserve the current Accounts fields and approval behavior, Argon2 password
hashing, access for active members and active admins, and a 30-day opaque
PostgreSQL-backed cookie session. D37 keeps `mint_session`: the same-origin
Next.js gateway forwards only its opaque token to the private API, which resolves
the principal independently from PostgreSQL on every request, checking expiry,
revocation and account status without trusting client or Next identity headers.
Reject native `mn1.` tokens for browser authentication. Preserve hashed token
storage, HttpOnly, secure and SameSite cookies and origin protections. Define the
auth interfaces within these decisions. D46 does not authorize trusting browser-supplied
forwarded-IP headers: establish a correctly trusted ingress path first. Secret
lifecycle and proxy configuration remain unselected; API and SDK enforce the
service-auth boundary. No temporary legacy-auth adapter is selected.
Broader metadata catalog browse/search remains a P3 capability, not retired.
D36 removes `/browse` and its entry links without a redirect or compatibility
handler.

D40 prioritizes fresh target integration over old-backend runtime continuity:
move only the backend dependencies needed for preserved UI actions into P1.
Do not use temporary legacy adapters, dual writes or legacy-identity bridges,
remove controls or treat placeholders as working actions. Broader APIs remain
in P4; unresolved action and business contracts still require decisions.
D41 selects `mint_migrations.__drizzle_migrations` as the single physical
history table and requires serialized API/worker startup migrations. The
platform helper now implements that serialization with explicit history
options, a dedicated-client session advisory lock and a central journal;
the API runtime and separate opt-in ListenBrainz worker invoke it with explicit
options. Worker build/start scripts require the mapped artifact tree; broader
composition, resource tuning and image/deployment integration remain gates.
The callable pg-boss runtime separately
invokes the same central migration helper before pg-boss manages its internal
schema. The journal includes platform event/public-cache, Catalog seed-receipt
and bounded ListenBrainz ingestion storage; the
Library scanner and media reader do not supply authorized HTTP streaming or
scheduling. Scanner continuation is an opt-in private-worker hint with
caller-owned persistence/serialization and
[bounded replay limitations](../migration/compatibility.md#library-scan-continuation).
