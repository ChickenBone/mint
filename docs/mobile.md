# Native consumer app

`apps/mobile` is an independently implemented Expo app for approved listeners.
The Next.js site, administration, providers and private worker remain separate
and retain their existing features. The native app does not expose chart
acquisition, provider setup, worker controls or administration. Search can
read existing charts as a browse category.

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
