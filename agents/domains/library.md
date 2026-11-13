# Library catalog and metadata (`library`)

> Target read-only media identity alongside bounded browsing/search, artwork, artist metadata and Plex indexing.

## Boundaries

- Owns catalog paging/search, member album/artist/library pages, `/api/artwork/{trackId}`, worker art, Plex indexing and artist metadata. Public `/browse` is retired, not member UI or catalog/API capability.
- `@mint/domain-library` owns fresh root/media identity, verification evidence, imported tags, bounded PostgreSQL per-file listing/search and a Linux confined read-only handle; browser/Plex behavior remains. Plex is read-only: indexing never claims/scans libraries, writes playlists or modifies media.

## Invariants

- Bound catalog windows; never hydrate the whole library. Search tolerates reordered words, prefixes, accents and conservative typos.
- Artwork order: Plex album/parent thumb, saved public art, Cover Art Archive, then YouTube thumbnails. Artist portraits use Plex `grandparentThumb` only (`?variant=artist`), else a neutral tile, never album mosaics. Keep Plex tokens/URLs out of browsers. Bound fetch bytes/time, validate redirects/content and safe raster; coalesce, cool down and bound caches. Saved public URLs remain fallback metadata (never proxy paths); group album cards by album identity.
- Resolve artist MusicBrainz identity by exact normalized name or existing MBID only; ambiguity stays unresolved, sources explicit, failures retryable. Never open audio.
- The catalog bridge exchanges bounded metadata and verified library artist MBIDs only. Catalog-only recordings are requestable, not playable or auto-acquired; failed priority syncs retain prior state.
- Public source reads use `services/public-metadata.ts` and server-only shared cache policy, not bearer/private Plex caching. Validate content/redirects, preserve stale age and no-match versus failure, and exclude personal data from shared keys/values. See [coverage](../architecture.md#server-side-public-read-caches).
- Plex indexing uses bounded batches and read-only mounts; re-indexing never erases originals or accepted upgrades.
- Identity is unique by root/relative path. Root and Catalog recording foreign keys restrict deletion; use Catalog's public root export, not private files. Stored paths prove neither mount access nor safety.
- List only persisted `verified` files, one per file despite shared recordings; unknown/ambiguous recording IDs are null. Verification requires trusted positive audio stream/codec/decoded-frame evidence, not existence/open/stat. Unavailable outcomes retain identity, tags and prior positive evidence; older outcomes are rejected. Scanning is explicit-only; callers own continuation persistence, serialization and freshness policy.
- `createLibraryRepository` exposes root/file creation, imported-tag replacement, verification writes and `listFiles`; reads return only ID, nullable recording ID and display fields (not paths/technical evidence). Imported title/version precede Catalog; artist/album use imported tags or unknown labels (Catalog lacks these fields). Technical duration precedes Catalog; filename fallback is presentation, not identity.
- Pages default to 50 (max 100), use ascending immutable UUID keysets and fetch `limit + 1`. Versioned cursors bind normalized search, not page size. Search is capped at 200 characters and matches accent/case-insensitive reordered literal substrings, not fuzzy typos; traversal is not a snapshot under concurrent changes.
- Callers authorize fresh sessions; neither the opener nor verifier grants playback. The Linux opener confines descriptors under the persisted root, rejects unsafe paths and requires `/proc/self/fd`. `0001_library_listing.sql` is in the target journal, not a legacy migration; use public exports.
- Verification joins persisted root/file paths, opens read-only and requires full FFmpeg decode before positive evidence/tag writes. Definite missing/unreadable errors and no-audio are negative; tool/decode/read/resource/timeout/cancellation remain inconclusive. Root/containment/config/write/close failures propagate. Bounded ffprobe/framehash and dedicated ametadata provide stream/frame evidence; current-check tag updates preserve absent fields. Filesystem reads/close are not hard-abortable; no filesystem/DB atomicity, in-place mutation detection or playback authorization is provided.
- `openLibraryPlaybackMedia` (present at the P1 baseline) reopens verified originals through the confined reader and exposes bounded positional/range reads. It is neither HTTP authorization nor HTTP streaming, a playback grant, conversion or full playback-time re-decode.
- `scanLibraryRoot` supports opt-in private-worker `cursor`/`nextCursor` continuation with caller-owned persistence and per-root serialization. Fresh confinement/verification remain mandatory; no original writes, discovered symlinks or unseen-file sweep. Replay is O(active-prefix entries), bounded by `maxReplayEntries` (default/cap 100000), so huge directories may not finish. Stale identity/stamp/prefix rejects; timestamp collisions can hide unread-suffix changes and completed-directory additions need a fresh scan. No snapshot, universal mutation detection, full fairness, scheduling/leases/freshness, hard filesystem/SQL timeout or playback authorization. See [continuation contract](../../plan/migration/compatibility.md#library-scan-continuation).

Details: [playback and library](../playback-and-library.md#artwork) and [integrations](../integrations-and-charts.md#existing-library-safety).

## Entry points and gotchas

- Browsing: `components/app/music-browser.tsx`, `lib/browser-catalog.ts`; queries: `lib/data.ts`, `catalog-search.ts`.
- Worker: `library-index.ts`, `artwork.ts` (proxy/cache), `services/plex.ts`, `services/artist-metadata.ts`.
- Overview titles and counts stay independent of filtered or paginated results.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Target read-only root/media identity and bounded scanner, plus existing browsing/search, artwork, artist metadata and Plex indexing.
- **Read before editing:** [agents/playback-and-library.md](../playback-and-library.md), [agents/design.md](../design.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`acquisition`](acquisition.md), [`catalog`](catalog.md), [`collections`](collections.md), [`mobile-contracts`](mobile-contracts.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Imported by:** [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`collections`](collections.md), [`devices`](devices.md), [`mobile-contracts`](mobile-contracts.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Live detail:** `npm run agents -- map library` (exports, line counts, cross-domain import edges).

### Owned files (76)

- `apps/web/src/app/api/` `artwork/[id]/route.ts`, `catalog/[...path]/route.ts`, `library/files/route.ts`, `library/route.ts`, `music/search/collection/route.ts`, `music/search/requests/route.ts`, `music/search/route.ts`
- `apps/web/src/app/app/` `library/albums/[id]/page.tsx`, `library/artists/[id]/page.tsx`, `library/page.tsx`, `music/page.tsx`, `search/page.tsx`
- `apps/web/src/components/` `art-wall.tsx`, `artwork.tsx`, `fresh-shelf.tsx`, `library-browser.tsx`, `track-list.tsx`
- `apps/web/src/components/app/` `catalog-artist-albums.tsx`, `catalog-collection-songs.tsx`, `global-search.tsx`, `music-browser.tsx`, `music-links.tsx`
- `apps/web/src/lib/` `artwork-query.ts`, `browser-catalog.ts`, `catalog-connection-data.ts`, `catalog-connection.ts`, `catalog-search.ts`, `data.ts`
- `apps/web/tests/` `artwork.test.ts`, `catalog-connection.test.ts`
- `apps/worker/src/` `artwork-http.ts`, `artwork.integration.test.ts`, `artwork.test.ts`, `artwork.ts`, `catalog-priority.test.ts`, `catalog-priority.ts`, `library-index.ts`, `library-policy.ts`
- `apps/worker/src/jobs/` `artist-metadata.ts`, `artwork.ts`, `library-index.integration.test.ts`, `library-policy.test.ts`
- `apps/worker/src/services/` `artist-metadata.test.ts`, `artist-metadata.ts`, `artwork.test.ts`, `artwork.ts`, `plex.ts`, `public-metadata.test.ts`, `public-metadata.ts`
- `docs/` `catalog-connection.md`
- `packages/core/migrations/` `0003_track_artwork_url.sql`, `0004_existing_library.sql`, `0014_artist_metadata.sql`
- `packages/core/src/` `artwork.ts`, `catalog-bridge.test.ts`, `catalog-bridge.ts`
- `packages/domain-library/` `package.json`, `tsconfig.json`
- `packages/domain-library/migrations/` `0000_library_identity.sql`, `0001_library_listing.sql`
- `packages/domain-library/src/` `audio-probe.ts`, `index.ts`, `path-access.ts`, `playback-media.ts`, `repository.ts`, `scanner.ts`, `schema.ts`, `verify-media-file.ts`
- `packages/domain-library/tests/` `audio-probe.integration.test.ts`, `path-access.integration.test.ts`, `playback-media.integration.test.ts`, `repository.integration.test.ts`, `scanner-repository.integration.test.ts`, `scanner.test.ts`, `schema.test.ts`, `verify-media-file.integration.test.ts`

### Validate

Owned tests: 19.

```bash
corepack pnpm --filter @mint/web run typecheck
corepack pnpm --filter @mint/web run lint
corepack pnpm --filter @mint/web exec tsx --test --test-force-exit tests/artwork.test.ts tests/catalog-connection.test.ts
corepack pnpm --filter @mint/worker run typecheck
corepack pnpm --filter @mint/worker exec tsx --test --test-force-exit src/artwork.integration.test.ts src/artwork.test.ts src/catalog-priority.test.ts src/jobs/library-index.integration.test.ts src/jobs/library-policy.test.ts src/services/artist-metadata.test.ts src/services/artwork.test.ts src/services/public-metadata.test.ts
corepack pnpm --filter @mint/core run typecheck
corepack pnpm --filter @mint/core exec tsx --test src/catalog-bridge.test.ts
corepack pnpm --filter @mint/domain-library run typecheck
corepack pnpm --filter @mint/domain-library exec tsx --test tests/audio-probe.integration.test.ts tests/path-access.integration.test.ts tests/playback-media.integration.test.ts tests/repository.integration.test.ts tests/scanner-repository.integration.test.ts tests/scanner.test.ts tests/schema.test.ts tests/verify-media-file.integration.test.ts
corepack pnpm --filter @mint/domain-library exec tsx --test tests/audio-probe.integration.test.ts tests/path-access.integration.test.ts tests/playback-media.integration.test.ts tests/repository.integration.test.ts tests/schema.test.ts tests/scanner.test.ts tests/scanner-repository.integration.test.ts tests/verify-media-file.integration.test.ts
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
