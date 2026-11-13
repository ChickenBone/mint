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
- List only persisted `verified` files, one per file despite shared recordings; unknown/ambiguous recording IDs are null. Verification requires trusted positive audio stream/codec/decoded-frame evidence, not existence/open/stat. Unavailable outcomes retain identity, tags and prior positive evidence; older outcomes are rejected. No scheduled scanner/freshness policy exists.
- `createLibraryRepository` exposes root/file creation, imported-tag replacement, verification writes and `listFiles`; reads return only ID, nullable recording ID and display fields (not paths/technical evidence). Imported title/version precede Catalog; artist/album use imported tags or unknown labels (Catalog lacks these fields). Technical duration precedes Catalog; filename fallback is presentation, not identity.
- Pages default to 50 (max 100), use ascending immutable UUID keysets and fetch `limit + 1`. Versioned base64url cursors bind normalized search, not page size; invalid input fails. Search caps at 200 characters; matches accent/case-insensitive reordered literal substrings in display tags, confirmed title and basename, not fuzzy typos. Traversal is not a snapshot under concurrent additions/availability changes.
- No HTTP authorization, scanner, playback grants or management; callers authorize fresh persisted sessions. The opener verifies its descriptor under root, rejects unsafe relative paths and fails closed without Linux `/proc/self/fd`; it proves neither persisted audio verification nor playback authorization. `0001_library_listing.sql` follows Catalog recording and Library identity in the platform journal, not a legacy migration; use public exports.
- `verifyLibraryMediaFile(repository, mediaFileId, options)` joins persisted root/file paths, opens confined/read-only; `verifyLibraryAudio` supplies full FFmpeg decode before PostgreSQL verification and optional metadata writes. Reject browser paths. Definite ENOENT/EACCES/EPERM mean missing/unreadable; no-audio means invalid audio. Root/containment/config/write failures throw; tool/decode/read/resource/timeout/cancellation stay inconclusive, never persisted as negative evidence. Post-write cancellation sets `verificationPersisted: true`, not verified success.
- `verifyLibraryAudio` uses dedicated `ametadata` stdout for decoded-frame totals, never stderr. Structured ffprobe JSON gives stream index/codec/rate; if unavailable, a separate bounded metadata-suppressed framehash header pass maps all streams and drops packets. Each fallback pass has its own explicit existing tool byte/output/time budgets; unsupported framehash-copy/filter formats remain inconclusive. ffprobe failure neither blocks positive decode evidence nor replaces tags. Merge non-null title/artist/album on the matching current check, preserving version/absent fields. Metadata-write failure throws `LibraryMediaMetadataWriteError` with persisted observation; close failures propagate (aggregated with verification failures). Pipe-only decoding has seek-format limits; filesystem reads/close aren't hard-abortable. No RLIMIT or filesystem/DB atomicity; no in-place mutation detection, mount freshness or playback authorization. Explicit paths; no packaging.

Details: [playback and library](../playback-and-library.md#artwork) and [integrations](../integrations-and-charts.md#existing-library-safety).

## Entry points and gotchas

- Browsing: `components/app/music-browser.tsx`, `lib/browser-catalog.ts`; queries: `lib/data.ts`, `catalog-search.ts`.
- Worker: `library-index.ts`, `artwork.ts` (proxy/cache), `services/plex.ts`, `services/artist-metadata.ts`.
- Overview titles and counts stay independent of filtered or paginated results.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Target read-only root/media identity, plus existing bounded browsing/search, artwork, artist metadata and Plex indexing.
- **Read before editing:** [agents/playback-and-library.md](../playback-and-library.md), [agents/design.md](../design.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`acquisition`](acquisition.md), [`catalog`](catalog.md), [`collections`](collections.md), [`mobile-contracts`](mobile-contracts.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Imported by:** [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`collections`](collections.md), [`devices`](devices.md), [`mobile-contracts`](mobile-contracts.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Live detail:** `npm run agents -- map library` (exports, line counts, cross-domain import edges).

### Owned files (71)

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
- `packages/domain-library/src/` `audio-probe.ts`, `index.ts`, `path-access.ts`, `repository.ts`, `schema.ts`, `verify-media-file.ts`
- `packages/domain-library/tests/` `audio-probe.integration.test.ts`, `path-access.integration.test.ts`, `repository.integration.test.ts`, `schema.test.ts`, `verify-media-file.integration.test.ts`

### Validate

Owned tests: 16.

```bash
corepack pnpm --filter @mint/web run typecheck
corepack pnpm --filter @mint/web run lint
corepack pnpm --filter @mint/web exec tsx --test --test-force-exit tests/artwork.test.ts tests/catalog-connection.test.ts
corepack pnpm --filter @mint/worker run typecheck
corepack pnpm --filter @mint/worker exec tsx --test --test-force-exit src/artwork.integration.test.ts src/artwork.test.ts src/catalog-priority.test.ts src/jobs/library-index.integration.test.ts src/jobs/library-policy.test.ts src/services/artist-metadata.test.ts src/services/artwork.test.ts src/services/public-metadata.test.ts
corepack pnpm --filter @mint/core run typecheck
corepack pnpm --filter @mint/core exec tsx --test src/catalog-bridge.test.ts
corepack pnpm --filter @mint/domain-library run typecheck
corepack pnpm --filter @mint/domain-library exec tsx --test tests/audio-probe.integration.test.ts tests/path-access.integration.test.ts tests/repository.integration.test.ts tests/schema.test.ts tests/verify-media-file.integration.test.ts
corepack pnpm --filter @mint/domain-library exec tsx --test tests/schema.test.ts
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
