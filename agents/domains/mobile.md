# Mobile foundation (`mobile`)

## Boundaries

- Owns Expo configuration, the route layout, navigation shell, shared music/UI components, theme, app-wide hooks and client authentication lifecycle. Feature folders and their routes/tests have separate owners; this is a fallback, not a reason to load every feature.
- [Native contracts](mobile-contracts.md) own `@mint/client` and `/api/native/**`; [playback](mobile-playback.md) owns the engine/offline store; [player presentation](mobile-player.md) owns the sheet and controls.
- The Expo app is consumer-only: Home, Search, Your Library, personal collections, listening and personal settings. Provider machinery, chart acquisition and administrator/management screens stay out of its navigation. Existing Next.js features remain intact.
- Native mobile is the consumer design authority; evolve original Spotify-inspired interactions and artwork-derived gradients with neutral fallbacks. Browser UX is frozen, maintenance-only; backend/API, security and administration continue.
- Share presentation through `src/components/music` and `src/components/ui`, never by importing Home's styles into another feature. Shell navigation is not feature state.

## Invariants

- SDK versions come from the official Expo template and `expo install`. Only one dependency/lockfile writer works at a time.
- Android must build `expo-audio` from source through the package's `expo.autolinking.android.buildFromSource` opt-out while the playback domain's authenticated playlist patch is required. SDK 58's stock precompiled Maven artifact ignores patched Kotlin; do not remove the opt-out based on passing source tests. Verify actual APK patch contents as well as signer/runtime, and rebuild for native changes.
- Never import `@mint/core`, Next.js, database/Redis, worker secrets or Node modules into native runtime files. `@mint/client` contains only public DTOs, runtime validation and HTTP transport.
- Native bearer credentials are revocable, expiring account/installation-bound sessions. Installation IDs are public metadata, not authorization. Store credentials in platform SecureStore, never AsyncStorage; Expo web keeps them in memory only.
- Keep one player across routes, restore queues paused, isolate account/server state and clear media/offline state on logout/revocation. Disconnected downloaded audio cannot be remotely revoked.
- Server-dependent and native background/device behavior requires actual integration/device evidence; a web export is not native production certification.
- EAS Build produces Android APKs and EAS Update hosts compatible JavaScript updates. Keep project/channel/runtime configuration aligned, preserve embedded/offline recovery and stable Android signing, and never publish an update for an incompatible native runtime. Mint's server does not host application updates. See [distribution setup](../../docs/android-builds.md).
- iOS device delivery uses the EAS-managed `ios-production` profile and production channel, not Android's local signing profile. Native fingerprints and finished signed baselines are platform-specific; preserve registered-device provisioning and recovery. See [iPhone distribution](../../docs/ios-builds.md).

## Contracts and validation

- `src/auth` exports `AuthProvider`/`useAuth`; `src/api` exports `useApi`. Only the auth adapter retains raw credentials.
- `src/shell` owns navigation; the layout mounts authentication and one `PlayerProvider`. Shared hooks consume stable auth/API/playback exports rather than implementing another engine.
- Use generated focused checks below. Changes to foundation exports require checks of actual consumers, not every backend guide.
- For dependency/native configuration changes, read [technical setup](../../docs/mobile.md) and run `npm exec -w @mint/mobile -- expo install --check` and `npm exec -w @mint/mobile -- expo-doctor`. Shared presentation-only work does not require the full server setup guide.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Expo configuration, navigation shell, shared UI/theme/hooks and client account lifecycle.
- **Read before editing:** [agents/mobile-features.md](../mobile-features.md).
- **Imports from:** [`mobile-contracts`](mobile-contracts.md), [`mobile-playback`](mobile-playback.md), [`mobile-player`](mobile-player.md), [`mobile-playlists`](mobile-playlists.md)
- **Imported by:** [`mobile-albums`](mobile-albums.md), [`mobile-artists`](mobile-artists.md), [`mobile-home`](mobile-home.md), [`mobile-playback`](mobile-playback.md), [`mobile-player`](mobile-player.md), [`mobile-playlists`](mobile-playlists.md), [`mobile-search`](mobile-search.md), [`mobile-settings`](mobile-settings.md), [`mobile-your-music`](mobile-your-music.md)
- **Live detail:** `npm run agents -- map mobile` (exports, line counts, cross-domain import edges).

### Owned files (46)

- `apps/mobile/` `app.json`, `eas.json`, `eslint.config.cjs`, `metro.config.cjs`, `package.json`, `tsconfig.json`
- `apps/mobile/app/` `_layout.tsx`, `sign-in.tsx`
- `apps/mobile/src/api/` `create-api.ts`, `index.ts`
- `apps/mobile/src/auth/` `AuthProvider.tsx`, `SignInScreen.tsx`, `account-request.ts`, `index.ts`, `persistence.ts`, `storage.native.ts`, `storage.ts`
- `apps/mobile/src/components/music/` `CatalogCollectionSection.tsx`, `CollectionDetail.tsx`, `catalog-model.ts`, `catalog-requests.tsx`, `detail-model.ts`, `screen-styles.ts`
- `apps/mobile/src/components/ui/` `PageTitle.tsx`, `SongOptions.tsx`, `music.tsx`, `primitives.tsx`
- `apps/mobile/src/hooks/` `paged-model.ts`, `song-likes.ts`, `useDebouncedValue.ts`, `usePagedResource.ts`, `usePlaybackAction.tsx`, `useResource.ts`, `useSongLike.ts`
- `apps/mobile/src/shell/` `ConsumerShell.tsx`, `navigation.ts`
- `apps/mobile/src/theme/` `tokens.ts`
- `apps/mobile/tests/` `app-config.test.ts`, `auth-storage.test.ts`, `catalog-likes.test.ts`, `screens.test.ts`, `song-likes.test.ts`
- `apps/mobile/tests/helpers/` `hook-harness.ts`, `music-fixtures.ts`
- `docs/` `mobile-design.md`, `mobile.md`

### Validate

Owned tests: 5.

```bash
npm run typecheck -w @mint/mobile
npm run lint -w @mint/mobile
npm exec -w @mint/mobile -- tsx --test tests/app-config.test.ts tests/auth-storage.test.ts tests/catalog-likes.test.ts tests/screens.test.ts tests/song-likes.test.ts
```

<!-- agents:generated:end -->
