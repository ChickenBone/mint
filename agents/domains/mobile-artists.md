# Mobile Artists (`mobile-artists`)

## Boundaries and contracts

- Owns `src/features/artists`, `/artist/[id]` and artist detail tests.
- Uses shared `CollectionDetail` presentation with an artist-specific adapter and existing typed catalog/player contracts. Metadata/indexing/artwork services belong to `library`.

## Invariants

- Keep artist identity distinct from album/playlist identity. Artist navigation does not start playback.
- Artist portraits never substitute album art; absent portraits use the shared neutral fallback.
- Render bounded song/album windows while Play/Shuffle selects all matching songs. Preserve genuine metadata, loading/empty/error/retry states and account cancellation.

Use generated focused checks; service metadata changes require the library owner.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Artist detail navigation, artist identity and bounded artist song/album presentation.
- **Read before editing:** [agents/mobile-features.md](../mobile-features.md).
- **Imports from:** [`mobile`](mobile.md), [`mobile-contracts`](mobile-contracts.md), [`mobile-playback`](mobile-playback.md)
- **Imported by:** none
- **Live detail:** `npm run agents -- map mobile-artists` (exports, line counts, cross-domain import edges).

### Owned files (5)

- `apps/mobile/app/artist/` `[id].tsx`
- `apps/mobile/src/features/artists/` `ArtistScreen.tsx`, `CatalogArtistAlbums.tsx`, `artist-model.ts`
- `apps/mobile/tests/` `artists-detail.test.ts`

### Validate

Owned tests: 1.

```bash
npm run typecheck -w @mint/mobile
npm exec -w @mint/mobile -- eslint 'app/artist/[id].tsx' src/features/artists/ArtistScreen.tsx src/features/artists/CatalogArtistAlbums.tsx src/features/artists/artist-model.ts tests/artists-detail.test.ts
npm exec -w @mint/mobile -- tsx --test tests/artists-detail.test.ts
```

<!-- agents:generated:end -->
