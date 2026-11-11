# Mobile Albums (`mobile-albums`)

## Boundaries and contracts

- Owns `src/features/albums`, `/album/[id]` and album detail tests.
- Uses shared `CollectionDetail` with an album-specific adapter and typed catalog/player contracts; catalog/indexing belongs to `library`.

## Invariants

- Album identity and song order remain distinct from artists/playlists and individual track artwork URLs.
- Navigation is separate from playback. Play/Shuffle selects the complete album, not its rendered page.
- Preserve bounded windows, available-song semantics, artwork fallbacks, account cancellation and recoverable empty/error states.

Use generated focused checks; shared detail changes coordinate with foundation and other detail consumers.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Album detail navigation, album identity and full-selection playback actions.
- **Read before editing:** [agents/mobile-features.md](../mobile-features.md).
- **Imports from:** [`mobile`](mobile.md), [`mobile-contracts`](mobile-contracts.md)
- **Imported by:** none
- **Live detail:** `npm run agents -- map mobile-albums` (exports, line counts, cross-domain import edges).

### Owned files (5)

- `apps/mobile/app/album/` `[id].tsx`
- `apps/mobile/src/features/albums/` `AlbumScreen.tsx`, `CatalogAlbumScreen.tsx`, `album-model.ts`
- `apps/mobile/tests/` `albums-detail.test.ts`

### Validate

Owned tests: 1.

```bash
npm run typecheck -w @mint/mobile
npm exec -w @mint/mobile -- eslint 'app/album/[id].tsx' src/features/albums/AlbumScreen.tsx src/features/albums/CatalogAlbumScreen.tsx src/features/albums/album-model.ts tests/albums-detail.test.ts
npm exec -w @mint/mobile -- tsx --test tests/albums-detail.test.ts
```

<!-- agents:generated:end -->
