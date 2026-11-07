# Native playback and offline (`mobile-playback`)

## Boundaries

- Owns the Expo audio engine, native/web platform adapters, queue/lyrics logic and offline stores. [Player presentation](mobile-player.md) owns `src/features/player`, gestures, colors and visible lyrics/queue controls.
- Consumes [native DTO/transport contracts](mobile-contracts.md) and [foundation](mobile.md) auth/API exports; dependency changes go through the shared mobile foundation/lockfile writer.
- Does not change the Next.js player, backend operations or shared schemas without coordinating with their owners.

## Invariants

- One engine remains mounted through navigation; restore paused, keep occurrence identities and never restart the current song when editing upcoming items.
- Account/server scope controls every snapshot/download. Auth logout and revocation call `revokePlaybackAccount` after stopping the presentation immediately.
- Stream/download only through authenticated public Mint proxies with header credentials, bounded file/metadata budgets and explicit cancellation/errors.
- The SDK 58 Android header/recovery patch must be compiled, not bypassed by Expo's stock Maven publication: keep `expo.autolinking.android.buildFromSource: ["expo-audio"]` in the mobile package. Real autolinking checks establish source selection; checksummed Kotlin/source tests alone do not establish APK contents. Distribution must verify the compiled patch before shipping; new native patches require a new APK/runtime.
- Native background play extends only through successfully loaded native queue horizons. Do not promise entire-library suspended playback or physical-device behavior from a web build.
- Lockscreen artwork resolves against the selected public Mint origin, never a relative browser path, private worker host or bearer-bearing URL. Do not claim device display from a unit test; preserve the audited native audio plugin and its compatibility gate.
- Offline expiry/revalidation stays consistent with the server entitlement. Offline audio cannot be remotely revoked while disconnected.
- Diagnostics collect bounded local status/numeric events only when enabled; clear traces on disable/account/occurrence changes and preferences on logout/revocation. Observed buffering/cadence are not audible-stall/FPS/throughput/DSP measurements. Analysis reads are cancellable, visible-only and never schedule work.

## Validation

Use the focused generated engine/offline checks below; presentation-only tests are separate. Native development builds and physical iOS/Android playback, suspension, lockscreen controls, codec and storage recovery need separate device evidence. See [technical setup](../../docs/mobile.md).

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Expo audio engine, progressive queues, lyrics parsing, local diagnostics, native adapters and account-scoped offline storage.
- **Read before editing:** [docs/mobile-playback.md](../../docs/mobile-playback.md).
- **Imports from:** [`mobile`](mobile.md), [`mobile-contracts`](mobile-contracts.md)
- **Imported by:** [`mobile`](mobile.md), [`mobile-player`](mobile-player.md), [`mobile-search`](mobile-search.md), [`mobile-settings`](mobile-settings.md)
- **Live detail:** `npm run agents -- map mobile-playback` (exports, line counts, cross-domain import edges).

### Owned files (23)

- `apps/mobile/src/offline/` `files.native.ts`, `files.ts`, `files.web.ts`, `store.ts`
- `apps/mobile/src/playback/` `PlayerProvider.tsx`, `account-cleanup.ts`, `analysis-request.ts`, `diagnostics-preference.ts`, `diagnostics.ts`, `engine.ts`, `lyrics.ts`, `playlist.native.ts`, `playlist.ts`, `playlist.web.ts`, `queue.ts`, `types.ts`, `with-audio-playlist.cjs`
- `apps/mobile/tests/` `offline-native.test.ts`, `playback-diagnostics.test.ts`, `playback-engine.test.ts`, `playback-native-patch.test.ts`, `playback.test.ts`
- `docs/` `mobile-playback.md`

### Validate

Owned tests: 5.

```bash
npm run typecheck -w @mint/mobile
npm run lint -w @mint/mobile
npm exec -w @mint/mobile -- tsx --test tests/offline-native.test.ts tests/playback-diagnostics.test.ts tests/playback-engine.test.ts tests/playback-native-patch.test.ts tests/playback.test.ts
```

<!-- agents:generated:end -->
