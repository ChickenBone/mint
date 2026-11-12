# Architecture and trust boundaries

## Repository map

| Surface | Responsibility |
| --- | --- |
| `apps/web` | Next.js backend/API, authentication, catalog/provider metadata and admin tools; browser consumer UX is frozen, maintenance-only |
| `apps/mobile` | Consumer UX/UI design authority: Home/Search/Your Library, native playback and account-scoped downloads; no operator dashboard |
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

## Core listening baseline

This is the current compatibility baseline, not a feature-parity or release-readiness claim.

| Capability | Current implementation and evidence | Verified scope | Owner / smallest next check |
| --- | --- | --- | --- |
| Sign-in and account scope | Native auth uses revocable account/installation-bound bearer sessions (`packages/client/src/auth.ts`, `apps/web/src/app/api/native/auth/`); storage cleanup ordering is covered by `apps/mobile/tests/auth-storage.test.ts` and transport boundaries by `apps/web/tests/native-auth.test.ts`. | Native credentials and account cleanup have focused tests. The real Next.js login/session/audio fixture exists in `apps/web/tests/native-http.integration.test.ts`, but this CI workflow does not set its required `NATIVE_HTTP_DATABASE_URL`. | `mobile` / `mobile-contracts` / `deploy`: wire and run the real fixture in CI while retaining web/native isolation: [#5](https://github.com/ChickenBone/mint/issues/5). |
| Library browse and search | `apps/mobile/src/features/search/SearchScreen.tsx` queries the selected server's local catalog and separately presents MusicBrainz recording results. The screen currently requests at most 50 songs and 18 albums/artists per query. | Search is bounded and distinguishes local matches from external metadata; a MusicBrainz candidate still requires the explicit **Add to library** action. | `mobile-search`: make all local matches reachable with bounded paging: [#6](https://github.com/ChickenBone/mint/issues/6). |
| Playback and queue continuity | The native engine keeps queue state across routes, progressively hydrates frozen collection pages, and restores account/server-scoped queues paused (`apps/mobile/src/playback/`, `apps/mobile/tests/playback-engine.test.ts`). | Tests cover duplicate occurrence identity, queue edits that preserve the current item, paused restoration, seek/repeat state and account-key isolation. | `mobile-playback`: verify the shipped Android path on a physical device; source/unit tests are not device evidence: [#7](https://github.com/ChickenBone/mint/issues/7). |
| Likes and playlists | Member collections are served through the music API and `packages/core/src/db/music.ts`; `apps/web/tests/music-platform.test.ts` covers member isolation, ordered duplicate entries, revisions, imported-playlist copies and separate native/source-managed likes. | PostgreSQL fixtures are configured in CI through `MUSIC_TEST_DATABASE_URL`; this does not establish a successful CI run for a particular revision. | `collections` / `acquisition` / `mobile-contracts`: preserve read-only source imports and member intent in the catalog/import contract: [#8](https://github.com/ChickenBone/mint/issues/8). |

These are different evidence levels: source and unit assertions establish only
their tested behavior; database integration tests require their configured
fixture; neither source tests nor an OTA/build record is physical-device
evidence. The native HTTP fixture above is currently not wired into CI, and no
physical Android playback result is claimed here.

### MusicBrainz search, catalog isolation and library seed seam

Mint's current listener Search requests local results from the selected Mint
server and, separately, shows current MusicBrainz recording-search results in
“Beyond your library.” This is metadata search, not a search against the
standalone catalog. A result not in the library is not imported until the
member explicitly selects **Add to library**. The worker's MusicBrainz matching
and enrichment paths are also distinct from the standalone catalog service.
The current Search surface keeps the returned request stage in component-local
state; issue #8 must define durable request status and recovery across navigation
or relaunch.

`services/catalog` is an independently operated metadata service with its own
storage and crawler; its README explicitly says **“No Mint integration.”**
Nothing currently exports Mint's indexed library into that service or seeds it
from listener searches. The existing read-only Plex indexer is a concrete
future seed source: it reads bounded Plex pages and upserts `tracks` by the
stable server/section/rating-key `existingLibraryKey`, alongside the existing
library match key and available recording IDs (`apps/worker/src/library-index.ts`,
`packages/core/migrations/0004_existing_library.sql`). This is an indexing seam,
not a catalog export or crawler integration. Issue [#8](https://github.com/ChickenBone/mint/issues/8)
owns the bounded, resumable library-first seed/export contract and adjacent
metadata growth; define an explicit exchange boundary rather than cross-service
database writes. It must not require a worldwide catalog or block local search
and playback.

The confirmed next-wave behavior is intentionally different from today's
explicit-only request flow: a **genuine search miss** for an artist, album or
song will seed discovery and queue an import automatically, without another
listener confirmation. A provider error, timeout, incomplete page or transient
empty response is not a genuine miss. This future behavior remains subject to
member permissions, operator policy and authorized configured sources; it does
not make metadata adjacency an instruction to acquire audio. Keep honest,
durable status and preserve explicit Like/Play intent. Issue #8 defines this
contract; automatic search-miss imports are not implemented by this baseline.

## Data and synchronization

One shared library can serve many members, while likes, playlists, history, offline state and source choices retain their intended account ownership.

Reuse shared view/protocol helpers so APIs, realtime events and UI agree. Preserve signed choices, request ownership, deterministic queue jobs, transactional/advisory-lock deduplication and conflict-safe revisions.

For core listening changes, treat existing media and user state as migration
inputs to preserve, not disposable fixtures: Plex and its original files remain
read-only; library indexing must remain idempotent; likes stay member-owned;
playlist entry identity, duplicate occurrence, order and revision stay stable;
source-managed playlists remain distinct from editable copies; and saved queues
remain scoped to the selected server/account and restore paused. Keep browser
routes/features and backend/API compatibility intact while native consumer UX
evolves. Database changes are additive migrations; never rewrite applied
migrations, reset existing installations, or silently discard provider data.

WebSockets enhance server-rendered state; they are not the only recovery mechanism. Preserve polling/invalidation fallbacks where implemented. Public events must not reveal which member liked a track.

Library metadata, public artwork and provider chart visibility are intentional public features. Private HTML, player APIs, sessions, lyrics and audio must not become shared CDN/service-worker cache entries.

Server-side caches may reuse validated public provider metadata independently of
the member response. Apply authorization and account-specific choices after that
shared read; never put playback items, lyric corrections, private history or
credentials in public cache keys/values. Each consumer owns its freshness/stale
window, negative/error backoff, payload budget and invalidation semantics; shared
plumbing is not evidence that every read endpoint is cached.

## Server-side public read caches

`@mint/core/public-cache` supplies shared Redis coordination and a bounded
process-local hot cache. Web and worker adapters reuse validated public metadata,
not member response bodies. Keys hash provider, canonical URL/query/body,
variant/version and the MusicBrainz mirror identity where applicable; keys contain
no raw queries, credentials or account choices.
ListenBrainz popularity's read-only POST uses the canonical body in its identity;
this is not permission to cache mutations or arbitrary POST requests.

| Implemented read | Fresh / maximum retention |
| --- | --- |
| LRCLIB get/by-ID and Lyrics.ovh; LRCLIB search | 24 hours / 7 days; search 1 hour / 1 day |
| MusicBrainz web recording and worker recording/artist/release-group searches | 1 hour / 1 day |
| MusicBrainz entities, Wikidata, Wikipedia summaries and ListenBrainz popularity/related metadata | 24 hours / 7 days |
| Approved Cover Art Archive resolution/images and YouTube thumbnails | 24 hours / 7 days |
| Direct chart feeds; configured chart-source proxy | 1 hour / 7 days; proxy 60 seconds / 7 days with embedded ranking age checked |

Only actual 404s or validated no-matches become five-minute negatives. Failures
remain errors or explicitly bounded stale data, never an empty successful match.
Leases coalesce reads across processes; atomic token-owned publication/release
rejects expired/replaced lease writers. Invalidation is TTL, cache version and
provider/parameter identity changes, not a manual purge API.
Total deadlines/AbortSignals bound source work; canceling one waiter does not
cancel a shared fetch needed by other callers.

The shared adapter spaces provider requests, including a two-second MusicBrainz
interval across web/worker, and honors bounded Retry-After. Failures use a
30-second cooldown; Redis outages fail closed with a 30-second circuit, using
only known-good hot stale values where policy permits, not unrestricted upstream
fallback. Direct charts retain their separate provider throttling policy.
Payload limits are consumer-specific: 512 KB default JSON, 1 MB MusicBrainz,
300 KB lyric reads (2 MB search), 2 MB charts and 4 MiB validated raster images
with a 6 MiB base64 storage limit. The hot cache is bounded to 128 entries/16 MiB;
artwork retains its separate 32 MiB LRU. Redis has no application-wide aggregate
byte cap here: configure deployment `maxmemory`/eviction; per-entry limits and
expiry are not a promise of unlimited safe storage.

Coverage is deliberately not every API. Private Plex/bearer requests, OAuth and
personal Spotify/YouTube metadata, authorization, signed audio/private delivery
and acquisition mutations are excluded. Direct provider chart image URLs are
not newly proxied/backend-cached. Member lyric corrections and chart/playback
availability remain outside shared public values; API privacy/no-store rules
still apply. See [charts](../docs/charts.md#configuration-and-resilience),
[artwork/lyrics](playback-and-library.md) and the owning adapter tests for budgets,
stale notices and failure semantics.

## Persistence

Database migrations run through the pipeline worker. Schema changes must update the migration journal and directly dependent services; do not rewrite previously applied migrations to repair an existing installation.

Keep PostgreSQL and its original generated encryption/signing secrets together. Original music mounts are read-only; separately stored downloads/upgrades must not overwrite originals.

Never recommend deleting databases, secrets, volumes or project directories to fix ordinary networking or migration symptoms.

## Application distribution

EAS Build/Update distributes the Expo application, not the Mint backend or music. A new native runtime requires a matching, successfully finished and validated platform build (Android APK or iOS IPA); compatible JavaScript updates use its production channel/runtime. Preserve stable Android signing, verified Apple team/ad hoc provisioning and embedded/cached recovery. There is no self-hosted `/api/updates/**` service. See [Android builds](../docs/android-builds.md), [iPhone builds](../docs/ios-builds.md) and [native transport](../docs/mobile.md); build/export success is not device or deployed-server evidence.
