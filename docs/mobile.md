# Native consumer app

`apps/mobile` is an independently implemented Expo app for approved listeners.
The Next.js site, administration, providers and private worker remain separate
and retain their existing features. The native app does not expose chart
acquisition, provider setup, worker controls or administration. Search can
read existing charts as a browse category.

## Feature ownership

Expo Router files in `apps/mobile/app/` are thin entry points. Listener UI,
feature models and feature-specific hooks live in `apps/mobile/src/features/`:

| Folder | Existing responsibility |
| --- | --- |
| `home` | Personal shelves, recent additions, rediscovery and album recommendations |
| `artists` | Artist song selection, album shelf, portrait and attributed biography |
| `albums` | Read-only album song selection and artist navigation |
| `playlists` | Native/smart/source-managed/liked selections, revision-checked edits and copies |
| `search` | Library/recording search, explicit requests, Browse all and category/chart paging |
| `your-music` | Library facets, playlist creation, invitations, folders, pins and imports |
| `settings` | Account/privacy, download storage, reports and compatible update controls |
| `player` | Persistent sheet, lyrics, queue controls, gestures, cover palettes and seek UI |

Shared music presentation and page styles belong to `src/components/music`;
generic primitives remain in `src/components/ui`. `CollectionDetail` renders
the common bounded song window and full-selection playback controls; album,
artist and playlist entry screens own distinct API loads and only playlists
supply mutation controls. Generic paging/resource hooks remain in `src/hooks`,
not in Home or Search. `src/shell` owns navigation and the persistent outlet;
auth, API and theme remain shared foundation contracts.

The player engine and offline adapters remain in `src/playback` and
`src/offline`, independent of UI features. The `/player` deep link still opens
the same persistent sheet with Home underneath, not another engine.
Feature tests use flat `tests/<feature>-*.test.ts` names so existing npm test
discovery retains all coverage and each domain can run its focused selectors.
See [domain routing](../agents/domains/README.md) for bounded feature context.
Events, listener profiles and Jams/Devices are extension boundaries, not newly
implemented mobile screens.

## Local development

Node.js 22+ and npm are required. From the repository root:

```bash
npm install
npm run dev:web
npm run dev:mobile
```

Connect using your server's public root HTTPS address, for example
`https://mint.example.com`. Do not enter a worker address, operator token,
path or credentials in the server URL. The same approved email/password
account used on the website works in the app. Pending/disabled accounts do
not gain access through native sign-in.

SDK 58 dependencies were selected from the official
[Expo TypeScript template](https://github.com/expo/expo/tree/main/templates/expo-template-blank-typescript)
and resolved using `expo install`. React/React DOM and native peer versions
are pinned across workspaces to prevent duplicate React/native modules.
Make dependency changes through the root lockfile, then run:

```bash
npm exec -w @mint/mobile -- expo install --check
npm exec -w @mint/mobile -- expo-doctor
npm run typecheck
npm run lint -w @mint/mobile
npm test -w @mint/client
npm test -w @mint/mobile
npm exec -w @mint/web -- tsx --test tests/native-auth.test.ts
```

Database-backed native session/worker revocation tests use
`NATIVE_TEST_DATABASE_URL` with an isolated database named
`mint_native_test_...` and run with
`npm exec -w @mint/web -- tsx --conditions=react-server --test tests/native-sessions.test.ts`.
The test applies migrations to that fresh database; never point it at an
existing deployment.

The app uses custom native cover-color extraction and background audio
configuration, so a **development build** is required; Expo Go is not a
complete validation target. Android builds require Java/Android SDK and an
emulator or physical device. iOS native builds require macOS/Xcode or a
separately authorized cloud build.

The pinned `expo-audio` Android playlist implementation needs the registered
`src/playback/with-audio-playlist.cjs` config plugin to preserve per-item
Authorization headers. It checks the exact package version/source hashes,
fails explicitly on an unaudited SDK change, clears per-URI headers when
sources are cleared/released and disables authenticated playlist redirects.
Run `expo prebuild --platform android --no-install` before local compilation;
do not remove the plugin until an upstream replacement is audited.
See [native playback notes](mobile-playback.md). Source patch tests/prebuild
are not Kotlin compilation or physical-device playback evidence.

```bash
npm run android -w @mint/mobile
npm run ios -w @mint/mobile
npm run web -w @mint/mobile
```

`app.json` supplies stable application identifiers and the linked Expo project.
`eas.json` defines development/internal/production profiles. Production Android
distribution uses **EAS Build** for an installable APK and **EAS Update** for
compatible JavaScript/assets. No Play Store submission is configured. The public
Expo project ID/update URL are not credentials or a Mint backend address.

Follow [Android builds and updates](android-builds.md) for GitHub authentication,
stable Android signing, native compatibility gating and downloads. A new
native runtime still requires installing a new APK. EAS hosts application
updates, not account APIs or music; the native backend remains on your Mint
server. Existing APKs configured for the removed self-hosted update endpoint
must be replaced with an EAS-enabled APK before they can receive EAS updates.
Automatic launch checks do not delay startup; a compatible update may download
in the background and require a later cold launch. Installed release builds
also expose a manual update check in Settings, with a confirmed restart option
that is unavailable while playback or queue preparation is active. The App info
section distinguishes the installed native build number from app-config
version and shows update/recovery details locally, not in issue reports.

## Account transport and server requirements

The deployed Next.js server must include the native routes:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/native/auth/login` | Email/password plus installation UUID/name; returns an expiring bearer credential |
| `GET /api/native/auth/session` | Revalidate approval, expiry and revocation |
| `POST /api/native/auth/logout` | Revoke the specific native credential; no web-cookie changes |
| `/api/native/player/**` | Allowlisted catalog, progressive queues, track metadata, lyrics, offline entitlement and audio proxy |
| `/api/native/music/**` | Existing account-owned collections, discovery, likes, preferences, history and explicit acquisition requests |
| `GET /api/native/browse?facet=&offset=&limit=` | Paginated Search categories (`genre`, `mood`, `decade`) derived from playable songs, with song counts and one sample cover |
| `GET /api/native/charts[?chart=&offset=&limit=&revision=]` | Read-only chart list and chart pages with per-account library availability; chart requests are not routed |
| `POST /api/native/issue-reports` | Member-submitted reports only, never administrator reports access |

Only explicitly allowlisted consumer handlers are reachable. The adapter
authenticates a native session and runs the existing handlers in a
request-local consumer context; even an administrator account gets only
consumer privileges here. Ordinary web routes continue using web cookies
and their existing Origin checks. Native tokens cannot be reused as web
cookies, and no Origin header is forged.

Credentials have the same expiry as ordinary sessions, currently 30 days.
They reuse the existing session table (no database migration), store only a
SHA-256 token hash, carry a distinct raw-token purpose prefix and bind public
installation metadata to the account. Signing in again on the same
account/installation revokes its previous native credential. Account
disabling and existing session-deletion operations revoke native sessions
too. The private audio worker receives the same normal session hash and
checks existing active-account/session authorization.

Native credentials use SecureStore with device-only keychain accessibility;
passwords are never persisted. Web credentials are memory-only and require
sign-in after a reload. Local sign-out immediately stops playback and clears
account/server-scoped state; failed secure deletion, media cleanup or server
revocation is surfaced rather than reported as success. When the server is
unreachable, local cleanup cannot prove server revocation. Foreground
session validation and API 401 responses trigger revocation cleanup.

`@mint/client` is the server-free shared DTO/schema/transport package.
Audio sources and downloads use bearer headers on the public
`/api/native/player/audio/:id` proxy, never URL query credentials or a
long-lived public media URL. Range/HEAD requests and original-versus-MP3
compatibility retain the existing worker behavior. Artwork uses public
`/api/artwork/:id`, a separately signed worker purpose; artwork requests do
not send native bearer credentials to upstream image hosts.

## Library-first catalog and import contract (proposed v1)

This is a contract for follow-on work, not a description of shipped behavior.
Native Search currently returns local catalog pages and separate MusicBrainz
recording candidates; a member must still choose **Add to library**, and the
requested stage is kept only in screen state. `services/catalog` remains
standalone. Until the follow-on implementation lands, local search and playback
must continue to work without it. The bounded Plex indexer in
`apps/worker/src/library-index.ts` upserts existing tracks by
`existingLibraryKey`; that is an identity seam, not a catalog export or a
resumable crawler.

### Identity and ownership

| Reference | Contract |
| --- | --- |
| Local playable entry | Keep Mint `trackId` and each Plex `existingLibraryKey` (`server:section:ratingKey`) distinct. An indexed original is read-only and a replacement/upgrade is separate. |
| Recording | Preserve a MusicBrainz recording ID when confidently known. A recording identity is not a release/edition identity; never merge local rows or select a playable file by title/artist similarity alone. |
| Release and artist | Preserve release-group/release and artist MBIDs when available. The current schema has recording, release-group and artist IDs but no release ID; retain ambiguity and provenance until a more specific identity is verified. |
| Seed/provenance | Record installation/source, entity kind/key, originating library track or explicit search demand, provider/source, relationship edge and contract version. Do not write directly across service databases. Exchange bounded records through an owned API or queue contract. |
| Member intent | Keep likes and each editable playlist occurrence/revision account-owned and durable. Source-managed imports remain read-only; a copied collection is editable. Intent is not shared acquisition state. |

### Seed, refresh and expansion

1. A configured installation may seed from its existing indexed artists,
   albums and tracks. Use the indexer's bounded pages and stable
   `existingLibraryKey`; reuse existing external IDs, not inferred matches.
   Keep edition/recording references even when enrichment jobs are deduplicated.
2. Checkpoint each scan by installation, source/section, scan generation and
   source cursor (plus last stable identity). A restart resumes from the
   checkpoint; a changed/invalid source snapshot can restart an idempotent pass.
   Repeated pages and restarts must not multiply jobs. A later refresh queues
   only new or materially changed identities, not the whole library.
3. Use a shared job key of entity kind plus verified external identity and
   enrichment-policy version. Without an external ID, use a namespaced local
   seed key; do not merge unrelated entities by normalized name. Normalized
   repeated search demand may coalesce discovery work, but never erases a
   member's separate intent.
4. Persist bounded pages/checkpoints and expose scanned, queued, completed,
   deferred, failed and last-progress values. Apply backpressure rather than
   filling memory or the whole job queue. The installation owns its seed
   control; member search adds targeted seeds, not global discovery.
5. Related-artist/release expansion must include an attributable edge back to
   one or more library/search seeds. An operator sets depth, per-seed fan-out,
   per-source rate/concurrency/storage budgets and installation-wide job/storage
   caps. The first implementation contract caps depth at one, five related
   candidates per seed and 1,000 related candidates per installation per day;
   operators may disable or lower expansion. Expansion never downloads all
   tracks on an artist/album or treats metadata adjacency as audio intent.
6. Pause stops new work without losing checkpoints; resume is idempotent.
   Shared provider backoff applies across users and jobs. Quota exhaustion,
   operator denial, unavailable source and retry-after are observable deferred
   or blocked states, not endless retries or success-shaped results.

For the synthetic 20,000-track acceptance fixture, use 500 artists, 2,000
release groups and 18,000 distinct recording IDs (including 2,000 recordings
present on multiple local editions). With 200 source rows per page, the first
pass must produce exactly 20,500 distinct enrichment seeds, at most 500
outstanding jobs and at most two active lookups per source; draining resumes
from checkpoints. A second unchanged pass adds zero jobs. Adding 100 records
with 90 new recording IDs, eight new release groups and two new artists adds
exactly 100 seeds. Related work never exceeds the configured five-per-seed or
1,000-per-installation daily ceiling. For budget tests, cap metadata storage at
64 MiB per installation and 16 MiB per source; defer new writes when either cap
is reached. These are contract fixture limits, not claims about current
runtime configuration.

### Search miss, request lifecycle and playback

A **genuine miss** is a complete, successful search of the local library and
all applicable configured metadata pages for the requested entity kind with
zero candidates. A provider error, timeout, invalid response, disabled source,
partial page, stale/incomplete result or transient empty state is not a miss.
At least one eligible discovery provider for the entity kind must complete; if
none is configured or available, the result is unknown/deferred, not a miss.
Keep local matches usable while external enrichment is unavailable. Browsing,
recommendations and prefetch are never request triggers.

On a genuine artist, album or song miss, create/coalesce the targeted discovery
seed automatically; do not ask for another confirmation. For artist/album
metadata, this does not authorize bulk audio acquisition. For a song, queue
audio only after a recording/version is confidently resolved and member
permissions, operator policy, configured authorized sources, storage and
concurrency quotas all allow it. An ambiguous identity stays ambiguous; a
blocked/misconfigured source reports the real state. No source authorization or
legal policy is inferred by Mint.

An explicit **Like** or **Play** on an unavailable song is also a targeted
member intent and starts the same request path when policy allows; a blocked
request reports its actual state. It does not turn a browse, recommendation or
prefetch into acquisition. **Play** stays ephemeral: it can request
availability, but must not auto-resume after the listener moves on.

Keep member intent and shared request state as independent axes:

| Member intent | Contract |
| --- | --- |
| `none` | No saved request intent. A shared import may still exist for another member. |
| `liked` | Account-owned; survives shared failure and attaches to the resolved playable track without exposing another member's like. |
| `playlist-entry` | Account/collection/entry/revision-owned; preserves order and deliberate duplicate occurrences. Removing one member's entry does not cancel shared work. |
| `play` | Short-lived foreground action only; never durable autoplay intent. |

Intent survives import failure. Successful availability links the same resolved
track to saved intent; source-managed imports are not edited. Metadata
enrichment has its own `queued → processing → enriched` lifecycle, with
`failed`, `ambiguous` and `unavailable` outcomes; an enriched artist or album
does not imply an audio request.

| Shared song-acquisition state | Listener meaning and transition |
| --- | --- |
| `requested` | A durable targeted seed/request exists; duplicate users/searches join the same eligible work. |
| `processing` | Discovery or acquisition is active. For a not-yet-playable track, map queued/matching/searching/downloading/importing/tagging/scanning/analyzing stages to this state; `available` takes precedence as soon as the existing `PLAYABLE` rule is true. Do not expose worker jargon as the client contract. |
| `available` | A selected track is playable under the existing `PLAYABLE` rule. Attach preserved member likes/playlist intent without changing source-managed collections. |
| `failed` | Work failed with a safe reason and retry eligibility. Keep member intent; an idempotent retry resumes the same identity rather than creating duplicate tracks/jobs. |
| `ambiguous` | More than one plausible recording/release/version or conflicting library match needs resolution. Do not silently select or acquire a different edition. |
| `unavailable` | No configured authorized source, operator policy denial or exhausted quota prevents work. Show whether an operator/configuration change can unblock it; do not retry indefinitely. |

Expose an account-authorized durable status lookup keyed by a stable request
reference. A client response needs a versioned entity reference, request ID and
listener-safe state/retry information; it must not expose worker secrets,
private paths or raw provider errors. Current `{ trackId, needsQueue, stage }`
and local requested-state are legacy behavior, not this durable contract.
Cross-user retries and concurrent requests are idempotent by verified entity
identity; each member's like and playlist entry remains independent through
failure. `Play` is an ephemeral action: a request never pauses/replaces current
audio, completion never steals playback or revives an expired play intent, and
late availability only makes the item playable.

### Contract fixtures and next implementation

The owning tests must also prove: local search works during a metadata-provider
outage; genuine artist/album/song misses auto-seed; provider failures and
incomplete pages do not; repeated normalized searches and concurrent users
share one job; browse/like/play do not cause unrelated acquisition; operator
denial, quotas and unavailable sources remain truthful; ambiguous/version-
conflicting matches do not acquire; failure then retry and status after relaunch
preserve identity/intent; and completion after navigation does not affect the
player. Use synthetic or licensed fixture metadata/media only.

The smallest implementation slice is an account-scoped durable request/status
contract for one confidently identified missing song, with shared idempotent
deduplication and native status refresh; keep the local player independent.
**Owners:** `mobile-contracts` defines/version-checks the DTO and allowlisted
route; `collections` persists member intent; `acquisition` owns shared
deduplication, stages and retries; `library` validates identity against local
tracks; `mobile-search` presents genuine-miss and recovery states. This slice
requires an explicit migration and focused fixture tests. It does not wire the
standalone catalog or expand into bulk imports. Artist/album seed handling and
bounded adjacent metadata growth follow the same contract.

## Secondary Expo web target

For a web app served from a different origin, configure the **server-only**
`NATIVE_WEB_ORIGINS` environment variable with a comma-separated list of
exact approved origins, for example `https://app.example.com`. Wildcards
are not supported. The native facade permits only listed/same-origin web
requests, omits cookies and does not grant credentialed CORS. This does not
change CORS or CSRF rules on ordinary Next.js APIs.

Use the **Expo browser page's origin**, including its actual port, not the
Mint API server address: for local Expo web this is commonly
`http://localhost:8081` or `http://127.0.0.1:8081`. They are distinct origins.
Set the value in the CLI stack's `.env`, the NAS template's top settings
block, the local Next.js environment or the Vercel server environment, then
restart/recreate or redeploy the **web server**. Changing the Expo app alone
does not update a running server's allowlist. iOS/Android have no browser
Origin and do not need this setting.

Browser developer tools should show a successful `OPTIONS` request to
`/api/native/auth/login` with `Access-Control-Allow-Origin` equal to the
browser origin; valid login returns 201 and an incorrect password returns
readable JSON with 401, both carrying the same CORS header. A denied origin
intentionally cannot read responses. If the route returns 404 or a proxy
login/redirect before reaching Next.js, update the server to include native
routes or fix that proxy rule; adding an allowlist cannot repair an old
deployment or an upstream proxy intercepting `OPTIONS`.

Development builds may use HTTP explicitly to connect to local test
servers; release clients require HTTPS. Do not use development HTTP on an
untrusted network. Public artwork already works natively; browser
cross-origin image processing still depends on the image server's CORS
policy and must retain a neutral-color fallback.

## Verification limits

Typechecks, schema/auth tests, Expo Doctor and a Metro web export validate
foundation and bundle contracts, not physical-device audio, background
execution, native module compatibility, store signing or production
certification. Native account/audio tests require an isolated server and
approved fixture account; never use production credentials/databases for
destructive tests. Offline entitlements remain bounded by the existing
server policy (currently seven days); disconnected downloaded media cannot
be remotely revoked.

The selected SDK and color-extraction dependency graph currently carries
moderate npm advisories in transitive tooling/image packages. Review
`npm audit --omit=dev` when upgrading; do not blindly apply its suggested
older-SDK downgrade or claim that passing Expo Doctor is a security audit.
