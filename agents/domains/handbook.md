# Handbook and public docs (`handbook`)

> README, product/design decisions, curated engineering/topic guides, UX docs and screenshots.

## Boundaries

- Owns `README.md`, `PRODUCT.md`, `DESIGN.md`, root `AGENTS.md`, curated topic guidance and docs that no feature domain owns. [Agent tooling](agent-tooling.md) owns the manifest, cards, generated path instructions, context/memory tools and their guides.
- Feature docs (charts, Spotify, devices, self-hosting, Android builds and mobile/playback/design) belong to their feature domains; coordinate factual cross-surface updates with those owners.

## Invariants

- The handbook is curated guidance, not transcripts. Keep it public-safe and use generic examples.
- Generated sections are never hand-edited; coordinate the single map writer and run `npm run agents:sync`.
- Screenshots use fictional content and original or licensed assets.
- `context` packets reuse manifest routing, remain bounded metadata and exclude private/ignored paths. Do not build whole-repository source dumps or persist session history in public guidance.

Details: [working at scale](../working-at-scale.md) and [engineering](../engineering.md#maintaining-this-folder).

## Entry points and gotchas

- Changes to routing/tooling belong to `agent-tooling`, not a generic documentation task.
- `npm run agents -- context "<request>" [paths…] [--json]` supplies guidance, contract edges, validation and count-only Git state; [starter prompt](../starter-prompt.md) provides portable future-chat instructions.
- Keep `AGENTS.md` lean because every agent loads it on every task.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** README, product/design decisions, curated engineering/topic guides, UX docs and screenshots.
- **Read before editing:** [agents/README.md](../README.md), [agents/browser-testing-and-mocks.md](../browser-testing-and-mocks.md).
- **Imports from:** none
- **Imported by:** none
- **Live detail:** `npm run agents -- map handbook` (exports, line counts, cross-domain import edges).

### Owned files (44)

- `./` `.gitignore`, `AGENTS.md`, `DESIGN.md`, `PRODUCT.md`, `README.md`
- `agents/` `README.md`, `architecture.md`, `browser-testing-and-mocks.md`, `design.md`, `engineering.md`, `integrations-and-charts.md`, `playback-and-library.md`, `product-decisions.md`, `sleeves-and-shelves.md`, `workers-and-operations.md`
- `docs/` `ui-library.md`
- `docs/screenshots/` `admin.png`, `analysis.png`, `browse.png`, `chart-requested.png`, `charts.png`, `discover-mix.png`, `discover.png`, `expo-browse-phone.png`, `expo-browse-wide.png`, `home.png`, `jobs.png`, `landing-stats.png`, `landing.png`, `library.png`, `liked.png`, `mobile-charts.png`, `mobile-discover.png`, `mobile-home.png`, `mobile-landing.png`, `mobile-player.png`, `mobile-small-charts.png`, `mobile-small-discover.png`, `now-playing.png`, `search-missing.png`, `settings.png`, `workers.png`
- `docs/ux/` `current-state.md`, `target-ux.md`

### Validate

No owned automated tests; add focused tests with behavior changes.

```bash
npm run agents:check
```

<!-- agents:generated:end -->
