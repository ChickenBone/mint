# Native playback and offline (`mobile-playback`)

## Boundaries

- Owns the Expo audio engine, native/web platform adapters, queue/lyrics logic, offline stores and expandable album-color player presentation.
- Consumes `@mint/client` and mobile auth/API contracts; dependency changes go through the shared mobile foundation/lockfile writer.
- Does not change the Next.js player, backend operations or shared schemas without coordinating with their owners.

## Invariants

- One engine remains mounted through navigation; restore paused, keep occurrence identities and never restart the current song when editing upcoming items.
- Account/server scope controls every snapshot/download. Auth logout and revocation call `revokePlaybackAccount` after stopping the presentation immediately.
- Stream/download only through authenticated public Mint proxies with header credentials, bounded file/metadata budgets and explicit cancellation/errors.
- The SDK 58 Android header/recovery patch must be compiled, not bypassed by Expo's stock Maven publication: keep `expo.autolinking.android.buildFromSource: ["expo-audio"]` in the mobile package. Real autolinking checks establish source selection; checksummed Kotlin/source tests alone do not establish APK contents. Distribution must verify the compiled patch before shipping; new native patches require a new APK/runtime.
- Native background play extends only through successfully loaded native queue horizons. Do not promise entire-library suspended playback or physical-device behavior from a web build.
- Cover palettes derive from actual proxied artwork using bounded processing/caches; failures retain an explicit neutral visual fallback without exposing secrets.
- Lockscreen artwork resolves against the selected public Mint origin, never a relative browser path, private worker host or bearer-bearing URL. Do not claim device display from a unit test; preserve the audited native audio plugin and its compatibility gate.
- Offline expiry/revalidation stays consistent with the server entitlement. Offline audio cannot be remotely revoked while disconnected.

## Validation

Run mobile typecheck/lint and `npm test -w @mint/mobile`. Native development builds and physical iOS/Android playback, suspension, lockscreen controls, codec and storage recovery need separate device evidence. See [technical setup](../../docs/mobile.md).

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Expo audio engine, progressive native queues, lyrics, account-scoped downloads and album-color player presentation.
- **Read before editing:** [docs/mobile.md](../../docs/mobile.md), [docs/mobile-playback.md](../../docs/mobile-playback.md), [agents/architecture.md](../architecture.md), [agents/playback-and-library.md](../playback-and-library.md).
- **Imports from:** [`mobile`](mobile.md)
- **Imported by:** [`mobile`](mobile.md)
- **Live detail:** `npm run agents -- map mobile-playback` (exports, line counts, cross-domain import edges).

### Owned files (30)

- `apps/mobile/src/components/player/` `LyricsPanel.tsx`, `PlayerSurface.tsx`, `SeekSlider.native.tsx`, `SeekSlider.tsx`, `SeekSlider.types.ts`, `SeekSlider.web.tsx`, `colors.native.ts`, `colors.ts`, `colors.web.ts`, `gesture.ts`, `palette.ts`
- `apps/mobile/src/offline/` `files.native.ts`, `files.ts`, `files.web.ts`, `store.ts`
- `apps/mobile/src/playback/` `PlayerProvider.tsx`, `account-cleanup.ts`, `engine.ts`, `lyrics.ts`, `playlist.native.ts`, `playlist.ts`, `playlist.web.ts`, `queue.ts`, `types.ts`, `with-audio-playlist.cjs`
- `apps/mobile/tests/` `offline-native.test.ts`, `playback-engine.test.ts`, `playback-native-patch.test.ts`, `playback.test.ts`
- `docs/` `mobile-playback.md`

### Validate

Owned tests: 4.

```bash
npm run typecheck -w @mint/mobile
npm run lint -w @mint/mobile
npm exec -w @mint/mobile -- tsx --test tests/offline-native.test.ts tests/playback-engine.test.ts tests/playback-native-patch.test.ts tests/playback.test.ts
```

<!-- agents:generated:end -->
