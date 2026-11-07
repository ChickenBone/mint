# Mobile Your Music (`mobile-your-music`)

## Boundaries and contracts

- Owns `src/features/your-music`, `/library` and Your Music model tests; the visible label remains Your Library.
- Owns overview browsing, folders/pins and playlist invitations. Playlist detail/editing belongs to `mobile-playlists`; backend collection operations belong to `collections`.

## Invariants

- Preserve liked songs, native/smart/collaborative/source-managed playlists, albums/artists/songs, folders/pins and invitations.
- Use typed entity destinations, not a universal collection schema or track-only identity.
- Bounded windows and account-scoped refreshes preserve working sections and actionable loading/empty/error states.
- Imports remain read-only; creation/invitation permissions follow existing server rules. Navigation does not acquire music or recreate playback.

Use generated focused checks; coordinate shared playlist action changes with the playlist owner.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Your Library overview, collection browsing, folders/pins and playlist invitations.
- **Read before editing:** [agents/mobile-features.md](../mobile-features.md).
- **Imports from:** [`mobile`](mobile.md), [`mobile-contracts`](mobile-contracts.md)
- **Imported by:** none
- **Live detail:** `npm run agents -- map mobile-your-music` (exports, line counts, cross-domain import edges).

### Owned files (4)

- `apps/mobile/app/` `library.tsx`
- `apps/mobile/src/features/your-music/` `LibraryScreen.tsx`, `library-model.ts`
- `apps/mobile/tests/` `your-music-model.test.ts`

### Validate

Owned tests: 1.

```bash
npm run typecheck -w @mint/mobile
npm exec -w @mint/mobile -- eslint app/library.tsx src/features/your-music/LibraryScreen.tsx src/features/your-music/library-model.ts tests/your-music-model.test.ts
npm exec -w @mint/mobile -- tsx --test tests/your-music-model.test.ts
```

<!-- agents:generated:end -->
