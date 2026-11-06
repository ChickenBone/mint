# Audio analysis (`analysis`)

> Measured audio analysis (mint-dsp), scheduling/backfills, remote analysis workers and analysis UI.

## Boundaries

- Owns the `mint-dsp` measurement engine, analysis job scheduling and backfill, the remote analysis HTTP protocol and worker entry (`analysis-worker.ts`), and the admin analysis UI and player analysis API.
- Remote analysis workers receive leased media only. They get no database, Redis or Plex credentials, and their secret is distinct from volunteer tokens.

## Invariants

- `v1` and `v2` results coexist through the discriminated union. Upgrading to `v2` keeps the `v1` result readable until `v2` completes.
- Execution modes (`remote-only`, `prefer-remote`, `hybrid`) switch at runtime. `ANALYSIS_REMOTE_ONLY=true` forces remote-only mode.
- Obey global enable/pause, the UTC schedule, concurrency, duration and time budgets. Remote slots range from 1 to 4. CPU, memory and container slots are independent controls.
- Backfills persist a cursor, enqueue batches of 500 and support `missing`, `upgrade-v1` and `all` modes. Cancellation stops queueing and processing without deleting originals or completed results. A new processor does not trigger reprocessing.
- Remote result bodies are capped at 1 MiB, with bounded retries on transient failures.
- This is Mint's measurement system, not Plex sonic analysis.

Details: [workers and operations](../workers-and-operations.md#analysis-behavior) and [DSP](../playback-and-library.md#dsp-analysis-and-lyrics).

## Entry points and gotchas

- `apps/worker/src/analysis-dsp.ts` is the largest worker file and contains the measurement math. Validate it with real media tests (`MINT_AUDIO_TEST`).
- `core/src/analysis.ts` defines the result schemas consumed by `playback` (Smart Fades and normalization) and `collections` (smart rules). It is a cross-domain contract.
- An unresolved remote "result not accepted fetch failed" report is documented as an observation, not a known cause.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Measured audio analysis (mint-dsp), scheduling/backfills, remote analysis workers and analysis UI.
- **Read before editing:** [agents/workers-and-operations.md](../workers-and-operations.md), [agents/playback-and-library.md](../playback-and-library.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`acquisition`](acquisition.md), [`library`](library.md), [`platform`](platform.md), [`playback`](playback.md), [`web-shell`](web-shell.md)
- **Imported by:** [`collections`](collections.md), [`platform`](platform.md), [`playback`](playback.md), [`web-shell`](web-shell.md)
- **Live detail:** `npm run agents -- map analysis` (exports, line counts, cross-domain import edges).

### Owned files (20)

- `./` `docker-compose.analysis.yml`
- `apps/web/src/app/api/` `player/analysis/[id]/route.ts`, `player/analysis/route.ts`
- `apps/web/src/app/app/` `admin/analysis/page.tsx`
- `apps/web/src/components/app/` `analysis-panel.tsx`, `track-analysis.tsx`
- `apps/web/src/lib/` `analysis-api.ts`
- `apps/worker/src/` `analysis-dsp.ts`, `analysis-engine.ts`, `analysis-http.ts`, `analysis-jobs.ts`, `analysis-worker.ts`, `analysis.integration.test.ts`, `analysis.test.ts`
- `apps/worker/src/jobs/` `sonic.ts`
- `packages/core/migrations/` `0005_analysis.sql`, `0011_analysis_backfill.sql`, `0013_analysis_v2.sql`
- `packages/core/src/` `analysis.ts`
- `packages/core/src/db/` `analysis.ts`

### Validate

Owned tests: 2.

```bash
npm run typecheck -w @mint/web
npm run lint -w @mint/web
npm run typecheck -w @mint/worker
npm exec -w @mint/worker -- tsx --test src/analysis.integration.test.ts src/analysis.test.ts
npm run typecheck -w @mint/core
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
