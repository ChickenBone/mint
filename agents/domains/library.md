# Library catalog and metadata (`library`)

> Bounded catalog browsing and search, album/artist views, artwork proxy and cache, artist metadata and Plex indexing.

## Boundaries

- Owns catalog pagination and search, album/artist pages, public browse, `/api/artwork/{trackId}`, worker artwork fetching and caching, Plex indexing and the artist-metadata queue.
- Plex is read-only from Mint's side. Indexing never claims or scans libraries, writes playlists or modifies media.

## Invariants

- Never render or hydrate the whole library. Catalog windows are bounded. Search tolerates reordered words, prefixes, accents and conservative typos without exact titles.
- Artwork order: Plex album art (album/parent thumb) first, then saved public art, Cover Art Archive and YouTube thumbnails. Artist portraits use Plex `grandparentThumb` only (`?variant=artist`); otherwise show the neutral tile, never an album mosaic.
- Plex tokens and URLs never reach browsers. Fetches have byte and time bounds, validated redirects, safe raster content, coalescing, cooldowns and bounded caches.
- Stored public artwork URLs remain fallback metadata. Never overwrite them with proxy paths. Album cards group by album identity.
- Artist metadata resolves MusicBrainz identity only on exact normalized names or existing MBIDs. Ambiguous names stay unresolved. Sources stay explicit and failures retryable. It never opens audio.
- Plex indexing pages in bounded batches and maps paths to the read-only mount. Re-indexing never erases originals or accepted upgrades.

Details: [playback and library](../playback-and-library.md#artwork) and [integrations](../integrations-and-charts.md#existing-library-safety).

## Entry points and gotchas

- Browsing UI: `components/app/music-browser.tsx` and `lib/browser-catalog.ts`. Server queries: `lib/data.ts` and `catalog-search.ts`.
- Worker: `library-index.ts`, `artwork.ts` (proxy/cache), `services/plex.ts`, `services/artist-metadata.ts`.
- Overview titles and counts stay independent of filtered or paginated results.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Bounded catalog browsing and search, album/artist views, artwork proxy and cache, artist metadata and Plex indexing.
- **Read before editing:** [agents/playback-and-library.md](../playback-and-library.md), [agents/design.md](../design.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`acquisition`](acquisition.md), [`collections`](collections.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Imported by:** [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`collections`](collections.md), [`devices`](devices.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Live detail:** `npm run agents -- map library` (exports, line counts, cross-domain import edges).

### Owned files (41)

- `apps/web/src/app/(public)/` `browse/page.tsx`
- `apps/web/src/app/api/` `artwork/[id]/route.ts`, `library/route.ts`, `music/search/route.ts`
- `apps/web/src/app/app/` `library/albums/[id]/page.tsx`, `library/artists/[id]/page.tsx`, `library/page.tsx`, `music/page.tsx`, `search/page.tsx`
- `apps/web/src/components/` `art-wall.tsx`, `artwork.tsx`, `fresh-shelf.tsx`, `library-browser.tsx`, `track-list.tsx`
- `apps/web/src/components/app/` `global-search.tsx`, `music-browser.tsx`, `music-links.tsx`
- `apps/web/src/lib/` `artwork-query.ts`, `browser-catalog.ts`, `catalog-search.ts`, `data.ts`
- `apps/web/tests/` `artwork.test.ts`
- `apps/worker/src/` `artwork-http.ts`, `artwork.integration.test.ts`, `artwork.test.ts`, `artwork.ts`, `library-index.ts`, `library-policy.ts`
- `apps/worker/src/jobs/` `artist-metadata.ts`, `artwork.ts`, `library-index.integration.test.ts`, `library-policy.test.ts`
- `apps/worker/src/services/` `artist-metadata.test.ts`, `artist-metadata.ts`, `artwork.test.ts`, `artwork.ts`, `plex.ts`
- `packages/core/migrations/` `0003_track_artwork_url.sql`, `0004_existing_library.sql`, `0014_artist_metadata.sql`
- `packages/core/src/` `artwork.ts`

### Validate

Owned tests: 7.

```bash
npm run typecheck -w @mint/web
npm run lint -w @mint/web
npm exec -w @mint/web -- tsx --test tests/artwork.test.ts
npm run typecheck -w @mint/worker
npm exec -w @mint/worker -- tsx --test src/artwork.integration.test.ts src/artwork.test.ts src/jobs/library-index.integration.test.ts src/jobs/library-policy.test.ts src/services/artist-metadata.test.ts src/services/artwork.test.ts
npm run typecheck -w @mint/core
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
