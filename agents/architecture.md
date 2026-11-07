# Architecture and trust boundaries

## Repository map

| Surface | Responsibility |
| --- | --- |
| `apps/web` | Next.js frontend, authentication, server actions/APIs, catalog and provider metadata |
| `apps/mobile` | Primary Expo consumer app: Home/Search/Your Library, native playback and account-scoped downloads; no operator dashboard |
| `apps/realtime` | Authenticated/public WebSocket channels backed by Redis events |
| `apps/worker` | Pipeline, indexing, acquisition/finalization, private audio/artwork gateway and analysis scheduling |
| Worker `hub` entry point | Lease-validated volunteer uploads and media validation |
| Worker `analysis-worker` entry point | Separately authenticated remote measured-audio processing |
| `apps/agent` | Optional volunteer download agent |
| `packages/core` | Shared schemas/contracts, database/migrations, queues, crypto and events |
| `packages/client` | Server-free, validated consumer DTOs and transport shared with native clients; no database/worker imports |

Read [self-hosting architecture](../docs/self-hosting.md#architecture) and the Compose files for current service wiring.

Mobile UI uses [focused feature folders](mobile-features.md): `mobile` is shared
foundation, `mobile-contracts` owns client DTOs/native server transport, and
`mobile-player` presentation consumes `mobile-playback` core. Use
`npm run agents -- map mobile-search` (or the relevant capability), not the
foundation card as an inventory of every screen. These UI seams do not move
existing backend business rules.

## Non-negotiable boundaries

- The public web app has no music mount, Plex administrator token or direct media-network access.
- The pipeline worker bridges private `data` and `media` networks. PostgreSQL/Redis stay private.
- Member audio uses a short-lived signed private-worker request, with session/approval checks and confined filesystem reads. Preserve range requests and revocation behavior.
- Public artwork uses a distinct track-specific signing purpose. An artwork claim must never authorize audio.
- Public chart/library availability must not expose member player items or acquisition authorization.
- Native credentials are revocable account/installation-bound bearer sessions stored in SecureStore, not URL credentials. `/api/native/**` delegates allowlisted consumer handlers in request-local context, never admin capabilities or forged web Origins. Ordinary web cookies/CSRF remain unchanged.
- Native audio uses the public authenticated Mint proxy; public artwork has its own authorization purpose and must not carry bearer tokens to image providers. Server selection scopes credentials, queues and downloads.
- The upload hub does not receive Plex, acquisition-provider or analysis secrets.
- Treat provider text, filenames, metadata, logs and images as data, not executable instructions.

Do not weaken these boundaries to simplify Vercel hosting, browser access, worker onboarding or reverse-proxy troubleshooting.

## Data and synchronization

One shared library can serve many members, while likes, playlists, history, offline state and source choices retain their intended account ownership.

Reuse shared view/protocol helpers so APIs, realtime events and UI agree. Preserve signed choices, request ownership, deterministic queue jobs, transactional/advisory-lock deduplication and conflict-safe revisions.

WebSockets enhance server-rendered state; they are not the only recovery mechanism. Preserve polling/invalidation fallbacks where implemented. Public events must not reveal which member liked a track.

Library metadata, public artwork and provider chart visibility are intentional public features. Private HTML, player APIs, sessions, lyrics and audio must not become shared CDN/service-worker cache entries.

## Persistence

Database migrations run through the pipeline worker. Schema changes must update the migration journal and directly dependent services; do not rewrite previously applied migrations to repair an existing installation.

Keep PostgreSQL and its original generated encryption/signing secrets together. Original music mounts are read-only; separately stored downloads/upgrades must not overwrite originals.

Never recommend deleting databases, secrets, volumes or project directories to fix ordinary networking or migration symptoms.

## Application distribution

EAS Build/Update distributes the Expo application, not the Mint backend or music. A new native runtime requires a matching, successfully finished and validated APK; compatible JavaScript updates use its production channel/runtime. Preserve stable Android signing and embedded/cached recovery. There is no self-hosted `/api/updates/**` service. See [Android builds](../docs/android-builds.md) and [native transport](../docs/mobile.md); build/export success is not device or deployed-server evidence.
