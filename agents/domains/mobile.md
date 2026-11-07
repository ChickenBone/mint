# Native consumer app (`mobile`)

## Boundaries

- Owns Expo foundation, auth/API and consumer routes/screens, the server-free `@mint/client` package and explicit `/api/native/**` transport facade. The [native playback domain](mobile-playback.md) owns engine, offline and player presentation files.
- The Expo app is consumer-only: Home, Search, Your Library, personal collections, listening and personal settings. Charts, provider machinery and administrator/management screens stay out of its navigation. Existing Next.js features remain intact.
- Reuse existing backend operations through the native adapter; do not duplicate catalog, collection, acquisition or authorization business logic.

## Invariants

- SDK versions come from the official Expo template and `expo install`. Only one dependency/lockfile writer works at a time.
- Never import `@mint/core`, Next.js, database/Redis, worker secrets or Node modules into native runtime files. `@mint/client` contains only public DTOs, runtime validation and HTTP transport.
- Native bearer credentials are revocable, expiring account/installation-bound sessions. Installation IDs are public metadata, not authorization. Store credentials in platform SecureStore, never AsyncStorage; Expo web keeps them in memory only.
- Native requests enter a request-local, consumer-only server adapter. Cookie web authentication and Origin/CSRF protections stay unchanged. Never forge Origin or expose admin handlers through the facade.
- Audio and downloads use the public Mint authenticated proxy, including range requests. Worker URLs/signing secrets never reach clients. Artwork is the existing public, separate-purpose proxy.
- Keep one player across routes, restore queues paused, isolate account/server state and clear media/offline state on logout/revocation. Disconnected downloaded audio cannot be remotely revoked.
- Server-dependent and native background/device behavior requires actual integration/device evidence; a web export is not native production certification.
- Self-hosted Expo updates serve exact signed runtime/channel/platform manifests from isolated persistent web storage. Publish immutable verified assets before atomic activation; keep signing keys out of the server and preserve embedded/offline recovery. See [OTA server](../../docs/mobile-updates-server.md) and [Actions setup](../../docs/android-builds.md).

## Contracts and validation

- `@mint/client` owns shared playback/catalog/queue schemas; the web player reexports them rather than creating a divergent protocol.
- `src/auth` exports `AuthProvider`/`useAuth`; `src/api` exports `useApi`. Only the auth adapter retains raw credentials.
- `npm run typecheck`, `npm run lint -w @mint/mobile`, `npm test -w @mint/client`, `npm test -w @mint/mobile`, `npm exec -w @mint/web -- tsx --test tests/native-auth.test.ts`.
- Run `npm exec -w @mint/mobile -- expo install --check` and `npm exec -w @mint/mobile -- expo-doctor`. See [technical setup](../../docs/mobile.md) for build/toolchain limits and server configuration.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Expo iOS/Android and responsive web consumer app, client-safe API contracts and native account transport.
- **Read before editing:** [docs/mobile.md](../../docs/mobile.md), [agents/architecture.md](../architecture.md), [agents/playback-and-library.md](../playback-and-library.md).
- **Imports from:** [`collections`](collections.md), [`library`](library.md), [`mobile-playback`](mobile-playback.md), [`platform`](platform.md), [`playback`](playback.md), [`web-shell`](web-shell.md)
- **Imported by:** [`collections`](collections.md), [`deploy`](deploy.md), [`library`](library.md), [`mobile-playback`](mobile-playback.md), [`playback`](playback.md), [`web-shell`](web-shell.md)
- **Live detail:** `npm run agents -- map mobile` (exports, line counts, cross-domain import edges).

### Owned files (71)

- `apps/mobile/` `app.config.js`, `app.json`, `eas.json`, `eslint.config.cjs`, `metro.config.cjs`, `package.json`, `tsconfig.json`
- `apps/mobile/app/` `_layout.tsx`, `index.tsx`, `library.tsx`, `player.tsx`, `search.tsx`, `settings.tsx`, `sign-in.tsx`
- `apps/mobile/app/album/` `[id].tsx`
- `apps/mobile/app/artist/` `[id].tsx`
- `apps/mobile/app/collection/` `[id].tsx`
- `apps/mobile/src/api/` `create-api.ts`, `index.ts`
- `apps/mobile/src/auth/` `AuthProvider.tsx`, `account-request.ts`, `index.ts`, `persistence.ts`, `storage.native.ts`, `storage.ts`
- `apps/mobile/src/components/ui/` `PageTitle.tsx`, `SongOptions.tsx`, `music.tsx`, `primitives.tsx`
- `apps/mobile/src/hooks/` `useDebouncedValue.ts`, `usePlaybackAction.tsx`, `useResource.ts`
- `apps/mobile/src/screens/` `ConsumerShell.tsx`, `DetailScreen.tsx`, `HomeScreen.tsx`, `LibraryScreen.tsx`, `SearchScreen.tsx`, `SettingsScreen.tsx`, `SignInScreen.tsx`, `collection-model.ts`, `navigation.ts`, `search-model.ts`
- `apps/mobile/src/theme/` `tokens.ts`
- `apps/mobile/tests/` `app-config.test.ts`, `auth-storage.test.ts`, `screens.test.ts`
- `apps/web/src/app/api/` `native/[...path]/route.ts`, `native/auth/[action]/route.ts`, `updates/assets/[hash]/route.ts`, `updates/publish/assets/[hash]/route.ts`, `updates/publish/route.ts`, `updates/route.ts`
- `apps/web/src/lib/` `native-context.ts`, `native-http.ts`, `native-sessions.ts`, `ota-updates.ts`
- `apps/web/tests/` `native-auth.test.ts`, `native-http.integration.test.ts`, `native-sessions.test.ts`, `ota-updates.test.ts`
- `docs/` `mobile-design.md`, `mobile-updates-server.md`, `mobile.md`
- `packages/client/` `package.json`, `tsconfig.json`
- `packages/client/src/` `api.ts`, `auth.ts`, `index.ts`, `music.ts`, `playback.ts`
- `packages/client/tests/` `client.test.ts`

### Validate

Owned tests: 8.

```bash
npm run typecheck -w @mint/mobile
npm run lint -w @mint/mobile
npm exec -w @mint/mobile -- tsx --test tests/app-config.test.ts tests/auth-storage.test.ts tests/screens.test.ts
npm run typecheck -w @mint/web
npm run lint -w @mint/web
npm exec -w @mint/web -- tsx --test tests/native-auth.test.ts tests/native-http.integration.test.ts tests/native-sessions.test.ts tests/ota-updates.test.ts
npm run typecheck -w @mint/client
npm exec -w @mint/client -- tsx --test tests/client.test.ts
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).

<!-- agents:generated:end -->
