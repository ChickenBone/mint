# Mobile Search and Discover (`mobile-search`)

## Boundaries and contracts

- Owns `src/features/search`, `/search`, `/browse/[facet]`, Browse all cards/hooks and focused search/browse tests. Discover is the existing Search browsing capability, not a new tab.
- Consumes native browse/chart/catalog/recording contracts; server browse belongs to `mobile-contracts`, catalog to `library`, charts to `providers`.

## Invariants

- Preserve independent local and recording search, debouncing/cancellation and partial source failures with retry. Reset pages when query/account/server changes; one page per source in flight.
- Browse categories, counts, sample covers and mixes are real playable-data results. Categories open distinct filtered destinations; no fabricated ranks or inert cards.
- Chart paging preserves provider scope/revisions. Available songs play; missing entries route to Search, never automatic acquisition.
- Only an explicit Add to library action on an identified recording may start acquisition; browsing and Play do not. A no-result Search intent can request metadata lookup only, never a speculative track or download. Requested does not mean playable.
- Full-selection Play/Shuffle stays complete while lists and category fetching remain bounded.

Use generated focused tests; new endpoints require native-contract and backend owners.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Local and recording Search, Browse all discovery/categories and read-only chart destinations.
- **Read before editing:** [agents/mobile-features.md](../mobile-features.md).
- **Imports from:** [`mobile`](mobile.md), [`mobile-contracts`](mobile-contracts.md), [`mobile-playback`](mobile-playback.md)
- **Imported by:** none
- **Live detail:** `npm run agents -- map mobile-search` (exports, line counts, cross-domain import edges).

### Owned files (14)

- `apps/mobile/app/` `search.tsx`
- `apps/mobile/app/browse/` `[facet].tsx`
- `apps/mobile/src/features/search/` `BrowseAll.tsx`, `BrowseCard.tsx`, `BrowseCategoryScreen.tsx`, `CatalogResults.tsx`, `SearchScreen.tsx`, `browse-model.ts`, `search-model.ts`, `useBrowseCatalog.ts`
- `apps/mobile/tests/` `search-browse-hooks.test.ts`, `search-browse.test.ts`, `search-catalog.test.ts`, `search-model.test.ts`

### Validate

Owned tests: 4.

```bash
npm --prefix apps/mobile run typecheck
npm --prefix apps/mobile exec -- eslint 'app/browse/[facet].tsx' app/search.tsx src/features/search/BrowseAll.tsx src/features/search/BrowseCard.tsx src/features/search/BrowseCategoryScreen.tsx src/features/search/CatalogResults.tsx src/features/search/SearchScreen.tsx src/features/search/browse-model.ts src/features/search/search-model.ts src/features/search/useBrowseCatalog.ts tests/search-browse-hooks.test.ts tests/search-browse.test.ts tests/search-catalog.test.ts tests/search-model.test.ts
npm --prefix apps/mobile exec -- tsx --test tests/search-browse-hooks.test.ts tests/search-browse.test.ts tests/search-catalog.test.ts tests/search-model.test.ts
```

<!-- agents:generated:end -->
