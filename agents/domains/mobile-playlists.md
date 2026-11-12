# Mobile Playlists (`mobile-playlists`)

## Boundaries and contracts

- Owns `src/features/playlists`, `/collection/[id]`, playlist action/model tests and liked-song detail presentation.
- Uses shared detail UI and existing collection DTOs/operations. Your Music owns the overview; `collections` owns server mutations/rules.

## Invariants

- Preserve native, smart, collaborative and source-managed collection distinctions. Imports remain read-only; copying creates a separate editable playlist.
- Mutations preserve revisions, owner/member permissions and duplicate occurrence IDs; reordering is not track-ID deduplication.
- Play/Shuffle selects complete frozen membership; editing upcoming entries never restarts the current item.
- Keep creation/rename/copy/add/remove/reorder/delete where supported, confirmation for destruction, visible errors and bounded rendering.

Use generated focused checks; schema/mutation changes coordinate with collections and native contracts.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Playlist and liked-song details, occurrence-based editing and collection actions.
- **Read before editing:** [agents/mobile-features.md](../mobile-features.md).
- **Imports from:** [`mobile`](mobile.md), [`mobile-contracts`](mobile-contracts.md)
- **Imported by:** [`mobile`](mobile.md)
- **Live detail:** `npm run agents -- map mobile-playlists` (exports, line counts, cross-domain import edges).

### Owned files (9)

- `apps/mobile/app/collection/` `[id].tsx`
- `apps/mobile/src/features/playlists/` `LikedImports.tsx`, `PlaylistScreen.tsx`, `SourcePicker.tsx`, `collection-model.ts`, `playlist-model.ts`, `usePlaylistActions.ts`
- `apps/mobile/tests/` `playlists-detail.test.ts`, `playlists-model.test.ts`

### Validate

Owned tests: 2.

```bash
npm run typecheck -w @mint/mobile
npm exec -w @mint/mobile -- eslint 'app/collection/[id].tsx' src/features/playlists/LikedImports.tsx src/features/playlists/PlaylistScreen.tsx src/features/playlists/SourcePicker.tsx src/features/playlists/collection-model.ts src/features/playlists/playlist-model.ts src/features/playlists/usePlaylistActions.ts tests/playlists-detail.test.ts tests/playlists-model.test.ts
npm exec -w @mint/mobile -- tsx --test tests/playlists-detail.test.ts tests/playlists-model.test.ts
```

<!-- agents:generated:end -->
