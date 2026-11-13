# Charts and provider sync (`providers`)

> Provider charts, Spotify playlist metadata, YouTube Music linking/sync and provider OAuth.

## Boundaries

- Owns chart providers, cache and service (`lib/chart*.ts`, `/api/charts`, `services/chart-source/**`), chart pages, Spotify linking and matching, Google/YouTube OAuth and sync jobs.
- Chart **acquisition** requests hand off to `acquisition` through its request lifecycle. This domain never downloads anything itself.
- Expo Search consumes these contracts through the mobile domain's read-only native chart facade. Do not expose `/api/charts/request` as a native chart handler; missing songs may lead to the existing explicit Search request flow.

## Invariants

- Report honest scope. Apple Music RSS covers country storefront Top 50 charts, ListenBrainz covers worldwide community listening, and Audius covers platform trending. Never aggregate countries into a "global" chart or call genre labels independent rankings.
- Bound charts to 50 entries and 25 per page, and keep rank order across revision-aware pagination. Keep Redis caching, refresh leases, throttles, timeouts and Retry-After handling.
- Configured chart-source reads cache validated public snapshots with embedded age bounds; account matches/choices/player items remain outside shared values and final GET privacy stays no-store. Do not imply direct chart image URLs are newly proxied. See [cache coverage](../architecture.md#server-side-public-read-caches).
- Show provider, territory, period, publication and check times separately. Distinguish empty, disabled, unavailable, stale and old states.
- Match recording identities, including version qualifiers and duration. Missing songs are muted and get an explicit **Add to library** action. **Play local songs** never acquires.
- Spotify is read-only metadata only: no audio, no analysis API and no automatic downloads. YouTube/Google is read-only import and never posts upstream.
- Research provider terms, coverage and rate limits before adding a source. Ask before adding paid requirements.

Details: [integrations and charts](../integrations-and-charts.md).

## Entry points and gotchas

- `lib/chart-providers.ts` provides transport, `chart-service.ts` provides orchestration, `chart-cache.ts` uses Redis, and `charts.ts` defines shared types.
- Spotify developer-app restrictions require verification; see [docs/spotify.md](../../docs/spotify.md).

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Provider charts, Spotify playlist metadata, YouTube Music linking/sync and provider OAuth.
- **Read before editing:** [agents/integrations-and-charts.md](../integrations-and-charts.md), [docs/charts.md](../../docs/charts.md), [docs/spotify.md](../../docs/spotify.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`acquisition`](acquisition.md), [`collections`](collections.md), [`library`](library.md), [`platform`](platform.md), [`playback`](playback.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Imported by:** [`acquisition`](acquisition.md), [`collections`](collections.md), [`library`](library.md), [`mobile-contracts`](mobile-contracts.md), [`platform`](platform.md), [`playback`](playback.md), [`web-shell`](web-shell.md)
- **Live detail:** `npm run agents -- map providers` (exports, line counts, cross-domain import edges).

### Owned files (42)

- `apps/web/src/app/(public)/` `charts/page.tsx`
- `apps/web/src/app/actions/` `spotify.ts`
- `apps/web/src/app/api/` `charts/request/route.ts`, `charts/route.ts`, `oauth/google/callback/route.ts`, `oauth/google/start/route.ts`, `oauth/spotify/callback/route.ts`, `oauth/spotify/start/route.ts`
- `apps/web/src/app/app/` `discover/charts/[chart]/page.tsx`, `discover/charts/page.tsx`, `spotify/[id]/page.tsx`, `spotify/page.tsx`
- `apps/web/src/components/app/` `chart-browser.tsx`, `link-youtube.tsx`, `spotify-controls.tsx`, `sync-panel.tsx`
- `apps/web/src/lib/` `chart-cache.ts`, `chart-match-queue.ts`, `chart-providers.ts`, `chart-service.ts`, `chart-source.ts`, `charts.ts`, `spotify-queue.ts`
- `apps/web/tests/` `charts-db.test.ts`, `charts-source.test.ts`, `charts.test.ts`
- `apps/worker/src/` `chart-acquisition.test.ts`, `spotify-jobs.ts`, `spotify.integration.test.ts`, `spotify.test.ts`
- `apps/worker/src/jobs/` `sync.ts`
- `apps/worker/src/services/` `youtube.ts`
- `docs/` `charts.md`, `spotify.md`
- `packages/core/migrations/` `0010_spotify.sql`, `0012_charts.sql`
- `packages/core/src/` `spotify-store.ts`, `spotify.ts`
- `packages/core/src/db/` `spotify.ts`
- `services/chart-source/` `main.mts`, `service.mts`, `tsconfig.json`

### Validate

Owned tests: 6.

```bash
corepack pnpm --filter @mint/web run typecheck
corepack pnpm --filter @mint/web run lint
corepack pnpm --filter @mint/web exec tsx --test --test-force-exit tests/charts-db.test.ts tests/charts-source.test.ts tests/charts.test.ts
corepack pnpm --filter @mint/worker run typecheck
corepack pnpm --filter @mint/worker exec tsx --test --test-force-exit src/chart-acquisition.test.ts src/spotify.integration.test.ts src/spotify.test.ts
corepack pnpm --filter @mint/core run typecheck
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
