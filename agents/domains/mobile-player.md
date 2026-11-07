# Mobile Player presentation (`mobile-player`)

## Boundaries and contracts

- Owns `src/features/player`, `/player`, mini-player/sheet, lyrics/queue UI, seek controls, gestures, artwork colors and presentation tests.
- Consumes the single `mobile-playback` provider/engine and shared mobile components; never implements a second transport or queue.
- `PlayerScreen` composes Home as the existing deep-link background while opening the same sheet. This is an explicit route contract, not shared styles or primitives imported from Home.

## Invariants

- Opening/closing the sheet only changes presentation. Routes, queue editing and lyrics navigation preserve the current item and paused/playing intent.
- Gesture tracking is interruptible, honors reduced motion and excludes controls/seeking; lyrics/queue retain scrolling. Back/Escape and a labeled close dismiss.
- Palettes derive from bounded proxied artwork processing/cache with readable neutral fallback; no random colors or credential-bearing image URLs.
- Lyrics use actual plain/line/word timing without fabrication, with scroll/follow/seek/report/retry.
- Preserve accessible seek/transport controls and native/web adapters. Native background/DSP/Smart Fades parity is not inferred from browser UI tests.

Use focused generated presentation checks; engine, offline or native patch changes require `mobile-playback`.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Persistent mini-player and expanded sheet, lyrics/queue UI, seek controls, gestures and artwork colors.
- **Read before editing:** [agents/mobile-features.md](../mobile-features.md).
- **Imports from:** [`mobile`](mobile.md), [`mobile-home`](mobile-home.md), [`mobile-playback`](mobile-playback.md)
- **Imported by:** [`mobile`](mobile.md)
- **Live detail:** `npm run agents -- map mobile-player` (exports, line counts, cross-domain import edges).

### Owned files (14)

- `apps/mobile/app/` `player.tsx`
- `apps/mobile/src/features/player/` `LyricsPanel.tsx`, `PlayerScreen.tsx`, `PlayerSurface.tsx`, `SeekSlider.native.tsx`, `SeekSlider.tsx`, `SeekSlider.types.ts`, `SeekSlider.web.tsx`, `colors.native.ts`, `colors.ts`, `colors.web.ts`, `gesture.ts`, `palette.ts`
- `apps/mobile/tests/` `player-presentation.test.ts`

### Validate

Owned tests: 1.

```bash
npm run typecheck -w @mint/mobile
npm exec -w @mint/mobile -- eslint app/player.tsx src/features/player/LyricsPanel.tsx src/features/player/PlayerScreen.tsx src/features/player/PlayerSurface.tsx src/features/player/SeekSlider.native.tsx src/features/player/SeekSlider.tsx src/features/player/SeekSlider.types.ts src/features/player/SeekSlider.web.tsx src/features/player/colors.native.ts src/features/player/colors.ts src/features/player/colors.web.ts src/features/player/gesture.ts src/features/player/palette.ts tests/player-presentation.test.ts
npm exec -w @mint/mobile -- tsx --test tests/player-presentation.test.ts
```

<!-- agents:generated:end -->
