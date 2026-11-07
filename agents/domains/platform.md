# Platform core (`platform`)

> Shared schemas, database, migrations, queues, crypto, env and worker runtime plumbing. Changes here ripple into every domain.

## Boundaries

- Owns `@mint/core` generic modules (`db/schema.ts`, `db/index.ts`, migrations runner, `queues.ts`, `redis.ts`, `crypto.ts`, `env.ts`, `index.ts`), root/workspace build config and the pipeline worker's entry, config, HTTP, logging and maintenance plumbing.
- Feature-specific core files (for example `core/src/devices.ts`, `db/music.ts`) belong to their feature domain. Change them there.
- PostgreSQL and Redis stay on private networks. Nothing here may expose them or weaken [trust boundaries](../architecture.md#non-negotiable-boundaries).

## Invariants

- Migrations run through the pipeline worker. Add a new migration with `npm run db:generate` and keep the journal consistent. Never rewrite an applied migration.
- Signing purposes stay separate: artwork claims must never authorize audio.
- Keep PostgreSQL with its original generated encryption/signing secrets. Never suggest deleting databases, volumes or secrets as a fix.
- Queue jobs remain deterministic and deduplicated: transactional and advisory locks, conflict-safe revisions.

## Contracts

- `@mint/core` subpath exports in `packages/core/package.json` are the public API for apps. Adding or renaming one is a cross-domain change, so run root `npm run typecheck`.
- `db/schema.ts` is imported by nearly every domain. Coordinate column changes with the owning feature domain.

## Entry points and gotchas

- Worker boot: `apps/worker/src/index.ts`, followed by `config.ts`. Migrations: `packages/core/src/db/migrate.ts`.
- `apps/web/src/lib/request.ts` (bounded JSON and public URL) and `rate-limit.ts` are shared web helpers.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Shared schemas, database, migrations, queues, crypto, env and worker runtime plumbing.
- **Read before editing:** [agents/architecture.md](../architecture.md).
- **Imports from:** [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`library`](library.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md), [`workers`](workers.md)
- **Imported by:** [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`collections`](collections.md), [`devices`](devices.md), [`library`](library.md), [`mobile-contracts`](mobile-contracts.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md), [`workers`](workers.md)
- **Live detail:** `npm run agents -- map platform` (exports, line counts, cross-domain import edges).

### Owned files (34)

- `./` `package.json`, `tsconfig.base.json`
- `apps/web/` `eslint.config.mjs`, `next-env.d.ts`, `next.config.ts`, `package.json`, `postcss.config.mjs`, `tsconfig.json`
- `apps/web/src/lib/` `queues.ts`, `rate-limit.ts`, `request.ts`
- `apps/worker/` `package.json`, `tsconfig.json`
- `apps/worker/src/` `config.ts`, `files.ts`, `http.ts`, `index.ts`, `log.ts`, `queues.ts`
- `apps/worker/src/jobs/` `maintenance.ts`
- `packages/core/` `drizzle.config.ts`, `package.json`, `tsconfig.json`
- `packages/core/migrations/` `0000_init.sql`, `0015_issue_reports.sql`
- `packages/core/src/` `crypto.ts`, `env.ts`, `index.ts`, `queues.ts`, `redis.ts`
- `packages/core/src/db/` `index.ts`, `migrate-cli.ts`, `migrate.ts`, `schema.ts`

### Validate

No owned automated tests; add focused tests with behavior changes.

```bash
npm run typecheck -w @mint/web
npm run lint -w @mint/web
npm run typecheck -w @mint/worker
npm run typecheck -w @mint/core
```

> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
