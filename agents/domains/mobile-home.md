# Mobile Home (`mobile-home`)

## Boundaries and contracts

- Owns `src/features/home`, the root listener route and Home model tests.
- Reads existing discovery/catalog API contracts and shared music components. Shared styles belong to foundation, not Home exports.

## Invariants

- Keep recommendations, recent additions and album shelves bounded and backed by real music/history. No invented recommendations or popularity.
- Preserve album identity, empty/error/retry states, account/server resets and full-selection playback through the persistent provider.
- Home browsing never acquires missing music. Navigation and the player survive shelf updates.

Use the focused generated checks below; backend recommendation changes require the collections owner.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Listener Home recommendations, bounded album shelves and recent additions.
- **Read before editing:** [agents/mobile-features.md](../mobile-features.md).
- **Imports from:** [`mobile`](mobile.md), [`mobile-contracts`](mobile-contracts.md)
- **Imported by:** [`mobile-player`](mobile-player.md)
- **Live detail:** `npm run agents -- map mobile-home` (exports, line counts, cross-domain import edges).

### Owned files (4)

- `apps/mobile/app/` `index.tsx`
- `apps/mobile/src/features/home/` `HomeScreen.tsx`, `home-model.ts`
- `apps/mobile/tests/` `home-model.test.ts`

### Validate

Owned tests: 1.

```bash
npm --prefix apps/mobile run typecheck
npm --prefix apps/mobile exec -- eslint app/index.tsx src/features/home/HomeScreen.tsx src/features/home/home-model.ts tests/home-model.test.ts
npm --prefix apps/mobile exec -- tsx --test tests/home-model.test.ts
```

<!-- agents:generated:end -->
