# Collections and discovery (`collections`)

> Native playlists, likes, smart rules, folders and imports, your-music views, discovery shelves, mixes, radios and playlist sleeves.

## Boundaries

- Owns the member's collections API (`/api/music/**` except search), `music-store`/`music-discovery` server logic, Your music and collection pages, Discover shelves and generated playlist sleeves, and the shared `MusicItem` context-menu surface.
- Charts and their rows belong to `providers`. Playback of a collection goes through `playback`.

## Invariants

- Preserve editable, smart and collaborative playlists, duplicates and order, folders and pins, and separately owned source-managed imports. Copying an import creates an editable Mint copy and never edits upstream.
- Likes, playlists and history are account-owned. Public events never reveal who liked a track. History deletion is honored even against stale client work.
- Recommendations are bounded and never silently acquire music.
- Sleeves are original generated art for real virtual collections only. Never fabricate chart badges, ranks or curation claims. Library album art follows `library`'s pipeline.
- Context menus work through right-click, an options button, a 550ms touch/pen hold and the keyboard. Movement cancels holds, and editing fields keep native gestures.

Details: [sleeves and shelves](../sleeves-and-shelves.md) and [playback and library](../playback-and-library.md#collections-devices-and-offline).

## Entry points and gotchas

- `lib/music-store.ts` handles collection CRUD and smart rules. `core/src/music.ts` defines mutation and smart-rule schemas, which form a contract with the API.
- `components/app/discovery-shelves.tsx` contains `PlaylistCover` and mix definitions, with styles in `globals.css` (`discovery-cover`).
- `your-music.tsx` and `native-collection-editor.tsx` are the largest files. Use `npm run agents -- map collections` to find the relevant part.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Native playlists, likes, smart rules, folders and imports, your-music views, discovery shelves, mixes, radios and playlist sleeves.
- **Read before editing:** [agents/playback-and-library.md](../playback-and-library.md), [agents/sleeves-and-shelves.md](../sleeves-and-shelves.md), [agents/design.md](../design.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`library`](library.md), [`mobile-contracts`](mobile-contracts.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Imported by:** [`acquisition`](acquisition.md), [`library`](library.md), [`mobile-contracts`](mobile-contracts.md), [`playback`](playback.md), [`providers`](providers.md), [`web-shell`](web-shell.md), [`workers`](workers.md)
- **Live detail:** `npm run agents -- map collections` (exports, line counts, cross-domain import edges).

### Owned files (29)

- `apps/web/src/app/api/` `music/[...path]/route.ts`
- `apps/web/src/app/app/` `collection/[id]/page.tsx`, `collection/page.tsx`, `collections/[id]/page.tsx`, `collections/page.tsx`, `discover/mixes/page.tsx`, `discover/page.tsx`, `liked/page.tsx`, `playlists/[id]/page.tsx`
- `apps/web/src/components/app/` `collection-actions.tsx`, `discovery-shelves.tsx`, `music-discovery.tsx`, `music-item.tsx`, `music-track-list.tsx`, `native-collection-editor.tsx`, `native-likes.tsx`, `playlist-toggle.tsx`, `recommendation-shelf.tsx`, `track-music-actions.tsx`, `your-music.tsx`
- `apps/web/src/lib/` `music-client.ts`, `music-discovery.ts`, `music-gestures.ts`, `music-store.ts`
- `apps/web/tests/` `music-gestures.test.ts`, `music-platform.test.ts`
- `packages/core/migrations/` `0006_music.sql`
- `packages/core/src/` `music.ts`
- `packages/core/src/db/` `music.ts`

### Validate

Owned tests: 2.

```bash
corepack pnpm --filter @mint/web run typecheck
corepack pnpm --filter @mint/web run lint
corepack pnpm --filter @mint/web exec tsx --test --test-force-exit tests/music-gestures.test.ts tests/music-platform.test.ts
corepack pnpm --filter @mint/core run typecheck
```

> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
