# Playback engine (`playback`)

> Native player, progressive queues, DSP and Smart Fades, offline, lyrics, listening history and audio delivery.

## Boundaries

- Owns the single native two-deck HTMLAudio/Web Audio engine, queue snapshots, player APIs (`/api/player/**`), offline service worker/PWA shell, lyrics providers and the private audio/transcode path.
- Does not own catalog search (`library`), collections (`collections`), analysis measurement (`analysis`) or device handoff (`devices`). It consumes their contracts.

## Invariants

- Keep one engine mounted across member navigation. Reload restores account-scoped queues **paused**. Sign-out, account change and revocation must not leak playback.
- Server-owned ID snapshots freeze queue membership and order, then hydrate later windows progressively. Play/Shuffle covers the full collection. Shuffle visits each occurrence once. Deliberate duplicates keep separate identities.
- Reorder, remove or clear upcoming without restarting the current song.
- Original audio streams unchanged. MP3 compatibility is a separate private cache. Audio uses short-lived signed worker requests with range support.
- Smart Fades are measured Mint transitions with Off/Fixed/Smart, album-safe boundaries and a `v1` fallback, never "Sweet Fades".
- Lyrics: on demand, prefer real word timing over line sync over plain text, never synthesize word timing, and never send audio, paths or credentials to providers.
- The service worker caches only the generic offline shell, never authenticated pages or APIs. Offline content is account-scoped IndexedDB with logout cleanup.

Details: [playback and library](../playback-and-library.md).

## Entry points and gotchas

- `apps/web/src/lib/native-player.ts` drives queue semantics. Read `tests/native-player.test.ts` and `playback-scale.test.ts` before editing.
- `player-protocol.ts` defines the `PlayerItem`/catalog shapes used by library, collections and devices; it is a cross-domain contract.
- UI: player bar and Now Playing must not duplicate transport on mobile. Sound settings live in Settings → Playback & sound (`web-shell`).

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Native player, progressive queues, DSP and Smart Fades, offline, lyrics, listening history and audio delivery.
- **Read before editing:** [agents/playback-and-library.md](../playback-and-library.md), [agents/design.md](../design.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`analysis`](analysis.md), [`collections`](collections.md), [`devices`](devices.md), [`library`](library.md), [`platform`](platform.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Imported by:** [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`collections`](collections.md), [`devices`](devices.md), [`library`](library.md), [`platform`](platform.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Live detail:** `npm run agents -- map playback` (exports, line counts, cross-domain import edges).

### Owned files (54)

- `apps/web/public/` `.gitkeep`, `offline.css`, `offline.html`, `offline.js`, `sw.js`
- `apps/web/src/app/api/` `player/audio/[id]/route.ts`, `player/catalog/route.ts`, `player/info/[id]/route.ts`, `player/items/route.ts`, `player/lyrics/[id]/matches/route.ts`, `player/lyrics/[id]/route.ts`, `player/offline/logout/route.ts`, `player/offline/route.ts`, `player/queue/[[...path]]/route.ts`, `player/session/route.ts`
- `apps/web/src/app/app/` `history/page.tsx`, `now-playing/page.tsx`
- `apps/web/src/app/listen/` `route.ts`
- `apps/web/src/components/app/` `listening-history.tsx`, `listening-spotlight.tsx`, `lyrics-match.tsx`, `now-playing.tsx`, `player-controls.tsx`, `player-panels.tsx`, `player-sheet-gesture.ts`, `player.tsx`
- `apps/web/src/lib/` `browser-dsp.ts`, `listening-history.ts`, `lyrics-provider.ts`, `lyrics.ts`, `native-player.ts`, `offline.ts`, `playback-queue-store.ts`, `player-catalog.ts`, `player-protocol.ts`, `progressive-queue.ts`, `smart-fades.ts`
- `apps/web/tests/` `listening.test.ts`, `lyrics.test.ts`, `native-player.test.ts`, `offline.test.ts`, `playback-scale.test.ts`, `player-sheet.test.ts`
- `apps/worker/src/` `playback.integration.test.ts`, `playback.test.ts`, `playback.ts`, `player-features.test.ts`, `transcode.test.ts`, `transcode.ts`
- `packages/core/migrations/` `0008_listening.sql`, `0009_playback_scale.sql`
- `packages/core/src/` `playback.ts`
- `packages/core/src/db/` `listening.ts`, `playback-queues.ts`

### Validate

Owned tests: 10.

```bash
npm run typecheck -w @mint/web
npm run lint -w @mint/web
npm exec -w @mint/web -- tsx --test tests/listening.test.ts tests/lyrics.test.ts tests/native-player.test.ts tests/offline.test.ts tests/playback-scale.test.ts tests/player-sheet.test.ts
npm run typecheck -w @mint/worker
npm exec -w @mint/worker -- tsx --test src/playback.integration.test.ts src/playback.test.ts src/player-features.test.ts src/transcode.test.ts
npm run typecheck -w @mint/core
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
