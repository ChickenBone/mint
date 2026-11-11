# Acquisition pipeline (`acquisition`)

> Music requests, backlog, download/finalize jobs, Lidarr/TorBox/Prowlarr/Cobalt/MusicBrainz matching and pipeline stages.

## Boundaries

- Owns member requests (`lib/music-requests.ts`), backlog and downloads views, pipeline stages and track state, acquire/finalize jobs and acquisition services.
- Only explicit authorized member requests or explicitly enabled YouTube sync enter acquisition. Public visitors cannot request music.

## Invariants

- Originals are read-only. Confident upgrades are stored separately and verified by media inspection. A FLAC codec does not prove lossless provenance.
- Matching is conservative: artist, title, compatible album/version and duration. Ambiguous editions are never silently reused or replaced. A pinned recording carries through downstream matching.
- Requests are signed, account-bound, deduplicated and use the existing job lifecycle. If identity or source is insufficient, expose a resolution flow instead of success-shaped queueing.
- Keep requested, processing, failed and ambiguous states distinct and observable with retry. Do not advertise broken indexers as configured.
- Do not bypass CAPTCHAs or entitlements. Support only acquisition the operator is authorized to perform.
- Add-only integration wiring never overwrites operator settings.
- Admin dismissal is failure-version-specific; only matching failed acquire/finalize records may be removed. Preserve tracks, memberships, live jobs and flow dependencies; expose partial cleanup failures.

Details: [integrations and charts](../integrations-and-charts.md).

## Entry points and gotchas

- Flow: request (`lib/music-requests.ts`) → `jobs/acquire.ts` → services → `jobs/finalize.ts`. `track-state.ts` updates stages and emits public-safe events (`realtime`).
- `core/src/stages.ts` defines the stage vocabulary shared with UI badges and the pipeline board.
- `integrations.ts` handles zero-config wiring for bundled Plex and Lidarr at worker startup.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Music requests, backlog, download/finalize jobs, Lidarr/TorBox/Prowlarr/Cobalt/MusicBrainz matching and pipeline stages.
- **Read before editing:** [agents/integrations-and-charts.md](../integrations-and-charts.md), [agents/architecture.md](../architecture.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`collections`](collections.md), [`library`](library.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Imported by:** [`analysis`](analysis.md), [`collections`](collections.md), [`library`](library.md), [`platform`](platform.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md), [`workers`](workers.md)
- **Live detail:** `npm run agents -- map acquisition` (exports, line counts, cross-domain import edges).

### Owned files (37)

- `apps/web/src/app/app/` `downloads/page.tsx`, `jobs/page.tsx`
- `apps/web/src/components/` `pipeline-board.tsx`, `stage-badge.tsx`
- `apps/web/src/components/app/` `downloads.tsx`, `retry-button.tsx`
- `apps/web/src/lib/` `admin-failed-jobs.ts`, `backlog.ts`, `failed-pipeline-jobs.ts`, `music-requests.ts`
- `apps/web/tests/` `admin-failed-jobs.test.ts`, `backlog.test.ts`, `failed-pipeline-jobs.test.ts`, `music-requests.test.ts`
- `apps/worker/src/` `existing-track.ts`, `integrations.ts`, `media.ts`, `music-requests.test.ts`, `parse.test.ts`, `parse.ts`, `track-state.ts`
- `apps/worker/src/jobs/` `acquire.ts`, `finalize.ts`, `media.integration.test.ts`, `torbox-bridge.integration.test.ts`, `torbox-bridge.ts`
- `apps/worker/src/services/` `cobalt.ts`, `lidarr.ts`, `matching-classifier.ts`, `musicbrainz.ts`, `prowlarr.test.ts`, `prowlarr.ts`, `torbox.test.ts`, `torbox.ts`
- `packages/core/migrations/` `0002_drop_previews.sql`
- `packages/core/src/` `stages.ts`, `track-state.ts`

### Validate

Owned tests: 10.

```bash
npm run typecheck -w @mint/web
npm run lint -w @mint/web
npm exec -w @mint/web -- tsx --test tests/admin-failed-jobs.test.ts tests/backlog.test.ts tests/failed-pipeline-jobs.test.ts tests/music-requests.test.ts
npm run typecheck -w @mint/worker
npm exec -w @mint/worker -- tsx --test src/jobs/media.integration.test.ts src/jobs/torbox-bridge.integration.test.ts src/music-requests.test.ts src/parse.test.ts src/services/prowlarr.test.ts src/services/torbox.test.ts
npm run typecheck -w @mint/core
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
