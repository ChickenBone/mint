# Handbook and public docs (`handbook`)

> README, product/design contracts, agent handbook, domain routing tooling, UX docs and screenshots.

## Boundaries

- Owns `README.md`, `PRODUCT.md`, `DESIGN.md`, `AGENTS.md`, `agents/**`, `scripts/agents/**`, generated `.github/instructions/**` and docs that no feature domain owns.
- Feature docs (`docs/charts.md`, `docs/spotify.md`, `docs/devices.md` and `docs/self-hosting.md`) belong to their feature domains.

## Invariants

- The handbook is curated guidance, not transcripts. Keep it public-safe and use generic examples.
- `agents/domains.json` is the routing source of truth. Generated sections are never hand-edited; run `npm run agents:sync`.
- Card hand-written sections stay within the manifest's `cardBytes` budget. Move rationale into topic guides.
- Screenshots use fictional content and original or licensed assets.

Details: [working at scale](../working-at-scale.md) and [engineering](../engineering.md#maintaining-this-folder).

## Entry points and gotchas

- `scripts/agents/lib.mjs` contains pure, unit-tested helpers (`npm run test:agents`). `cli.mjs` handles I/O and rendering.
- Keep `AGENTS.md` lean because every agent loads it on every task.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** README, product/design contracts, agent handbook, domain routing tooling, UX docs and screenshots.
- **Read before editing:** [agents/README.md](../README.md), [agents/working-at-scale.md](../working-at-scale.md), [agents/browser-testing-and-mocks.md](../browser-testing-and-mocks.md).
- **Imports from:** none
- **Imported by:** none
- **Live detail:** `npm run agents -- map handbook` (exports, line counts, cross-domain import edges).

### Owned files (74)

- `./` `.gitignore`, `AGENTS.md`, `DESIGN.md`, `PRODUCT.md`, `README.md`
- `.github/instructions/` `acquisition.instructions.md`, `analysis.instructions.md`, `collections.instructions.md`, `deploy.instructions.md`, `devices.instructions.md`, `handbook.instructions.md`, `library.instructions.md`, `platform.instructions.md`, `playback.instructions.md`, `providers.instructions.md`, `realtime.instructions.md`, `web-shell.instructions.md`, `workers.instructions.md`
- `agents/` `README.md`, `architecture.md`, `browser-testing-and-mocks.md`, `design.md`, `domains.json`, `engineering.md`, `integrations-and-charts.md`, `playback-and-library.md`, `product-decisions.md`, `sleeves-and-shelves.md`, `workers-and-operations.md`, `working-at-scale.md`
- `agents/domains/` `README.md`, `acquisition.md`, `analysis.md`, `collections.md`, `deploy.md`, `devices.md`, `handbook.md`, `library.md`, `platform.md`, `playback.md`, `providers.md`, `realtime.md`, `web-shell.md`, `workers.md`
- `docs/` `ui-library.md`
- `docs/screenshots/` `admin.png`, `analysis.png`, `browse.png`, `chart-requested.png`, `charts.png`, `discover-mix.png`, `discover.png`, `home.png`, `jobs.png`, `landing-stats.png`, `landing.png`, `library.png`, `liked.png`, `mobile-charts.png`, `mobile-discover.png`, `mobile-home.png`, `mobile-landing.png`, `mobile-player.png`, `mobile-small-charts.png`, `mobile-small-discover.png`, `now-playing.png`, `search-missing.png`, `settings.png`, `workers.png`
- `docs/ux/` `current-state.md`, `target-ux.md`
- `scripts/agents/` `cli.mjs`, `lib.mjs`, `lib.test.mjs`

### Validate

Owned tests: 1.

```bash
node --test scripts/agents/lib.test.mjs
npm run agents:check
npm run test:agents
```

<!-- agents:generated:end -->
