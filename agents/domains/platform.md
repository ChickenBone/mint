# Platform core (`platform`)

> Shared schemas, database, migrations, queues, crypto, env and worker runtime plumbing. Changes here ripple into every domain.

## Boundaries

- Owns legacy `@mint/core` plumbing, root/workspace configuration and worker-process plumbing.
- Owns `@mint/platform`: migrations, bounded PostgreSQL rate limits, pg-boss runtime, event replay and public-read cache.
- Owns `apps/api/**` for Fastify/tRPC composition and transport; business rules stay in domains. Its runtime owns a PostgreSQL pool, runs central migrations before serving, and composes Accounts/Library operations with fresh persisted-session authorization. Optional all-or-none `MINT_API_BOOTSTRAP_ADMIN_{EMAIL,NAME,PASSWORD}` uses Accounts Argon2 after migrations and before listen; it preserves existing accounts and fails closed.
- API requires an explicit canonical 32-byte base64url gateway token; constant-time service-header checks fail closed before procedures and framework errors. Service authentication is not user identity. `MINT_API_PUBLIC_AUTH_PROXY=gateway` explicitly permits public auth to consume one validated `x-mint-client-ip` from the authenticated gateway; unset disables public auth and other values reject startup. Fastify `trustProxy` remains false: ordinary forwarded headers never authorize IP-limited operations. Next's authenticated-ingress policy is documented in [web-shell](web-shell.md).
- `accounts.signIn`, `requestAccess` and `signOut` use Accounts services and existing session/rate-limit tables without new migrations. PostgreSQL limits are 20 login attempts/IP and 8/email per 900 seconds, and 5 access requests/IP per 3600 seconds. Addresses are canonicalized, including IPv4-mapped IPv6. Missing, malformed or duplicate IP evidence fails closed before admission; storage failures propagate rather than allowing attempts.
- Owns legacy public-cache plumbing and target `PostgresPublicReadCache`: bounded public-only values/leases, fenced writes and fresh/stale/negative/error states. Features own validation, freshness, pacing and invalidation; never cache credentials or account data.
- Feature-specific core files (for example `core/src/devices.ts`, `db/music.ts`) belong to their feature domain. Change them there.
- PostgreSQL and Redis stay on private networks. Nothing here may expose them or weaken [trust boundaries](../architecture.md#non-negotiable-boundaries).

## Invariants

- Legacy `@mint/core` migrations run through the pipeline worker. Add one with `npm run db:generate` and keep its journal consistent; never rewrite an applied migration.
- The target journal applies platform rate-limit/event/cache, Accounts, Catalog receipts/ListenBrainz ingestion, Library identity/listing/scan state and Playback history/queue SQL using fixed history and a dedicated-client advisory lock. API and local-job runtime invoke it; pg-boss manages its own schema. Deployment readiness remains open.
- `startLocalJobRuntime` validates explicit queue/retry/retention/concurrency policy and bounded JSON envelopes; handlers validate domain payloads. Same-client enqueue can share a caller's transaction, but singleton keys expire with active/queued/retrying jobs and are not durable receipts. It owns neither signals nor the pool.
- `PostgresEventLog` provides bounded public/admin/account replay and a durable floor. Callers own authorization, validation and retention; it is not WebSocket transport or producer integration.
- Cache keys/values are public only. Bounded payloads, coalescing, leases, retention and cleanup require caller-owned provider pacing and cleanup scheduling.
- Signing purposes stay separate: artwork claims must never authorize audio.
- Keep PostgreSQL with its original generated encryption/signing secrets. Never suggest deleting databases, volumes or secrets as a fix.
- Queue jobs remain deterministic and deduplicated: transactional and advisory locks, conflict-safe revisions.
- Cache coordination, leases, cooldowns and admission stay bounded. A Redis outage must not turn into unthrottled provider reads; stale/negative/error states remain distinct and cache invalidation must prevent stale in-flight repopulation.
- Adapters that must honor a provider refusal even for fresh entries use `respectCooldownForFresh`; the default cache behavior remains unchanged for other providers.

## Contracts

- `@mint/core` subpath exports in `packages/core/package.json` are the public API for apps. Adding or renaming one is a cross-domain change, so run root `npm run typecheck`.
- `@mint/platform` exports the migration/rate-limit APIs, `startLocalJobRuntime`, `PostgresEventLog`, `PostgresPublicReadCache` and `publicCacheKey`. PostgreSQL tests require `MINT_TEST_POSTGRES_BIN`; disposable clusters only.
- `apps/worker/src/local-job-{config,runtime,main}.ts` composes opted-in ListenBrainz ingestion and Library scans. JSON `MINT_LOCAL_WORKER_ENABLED_SOURCES=[]` opens nothing; Library needs bounded options and existing root UUIDs. Local build/start preserve legacy entry points; no worker image/deployment is supplied. See [runtime contract](../../plan/migration/compatibility.md#local-worker-runtime).
- `db/schema.ts` is imported by nearly every domain. Coordinate column changes with the owning feature domain.
- [Public cache coverage](../architecture.md#server-side-public-read-caches): the fixture is test-only, TTL/version/provider identity invalidates reads, and there is no manual purge or global Redis byte cap. Test core and affected adapters when contracts change.

## Entry points and gotchas

- Worker boot: `apps/worker/src/index.ts`, followed by `config.ts`. Migrations: `packages/core/src/db/migrate.ts`.
- `apps/web/src/lib/request.ts` (bounded JSON and public URL) and `rate-limit.ts` are shared web helpers.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Shared database primitives, central migrations, local pg-boss jobs, durable PostgreSQL events and public cache, workspace plumbing and target API composition.
- **Read before editing:** [agents/architecture.md](../architecture.md).
- **Imports from:** [`accounts`](accounts.md), [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`catalog`](catalog.md), [`library`](library.md), [`mobile-contracts`](mobile-contracts.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md), [`workers`](workers.md)
- **Imported by:** [`accounts`](accounts.md), [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`catalog`](catalog.md), [`collections`](collections.md), [`devices`](devices.md), [`library`](library.md), [`mobile-contracts`](mobile-contracts.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md), [`workers`](workers.md)
- **Live detail:** `npm run agents -- map platform` (exports, line counts, cross-domain import edges).

### Owned files (93)

- `./` `nx.json`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- `apps/api/` `LIBRARY-ROOT.md`, `package.json`, `tsconfig.json`
- `apps/api/src/` `index.ts`, `main.ts`, `provision-library-root.ts`, `runtime-config.ts`, `runtime.ts`, `server.ts`
- `apps/api/tests/` `admin-accounts.integration.test.ts`, `library.integration.test.ts`, `listening-history.integration.test.ts`, `main.integration.test.ts`, `member-status.integration.test.ts`, `provision-library-root.integration.test.ts`, `runtime.integration.test.ts`, `session.test.ts`
- `apps/web/` `eslint.config.mjs`, `next-env.d.ts`, `next.config.ts`, `package.json`, `postcss.config.mjs`, `tsconfig.json`
- `apps/web/src/lib/` `queues.ts`, `rate-limit.ts`, `request.ts`
- `apps/worker/` `package.json`, `tsconfig.json`
- `apps/worker/src/` `config.ts`, `files.ts`, `http.ts`, `index.ts`, `local-job-config.test.ts`, `local-job-config.ts`, `local-job-main.integration.test.ts`, `local-job-main.ts`, `local-job-runtime.integration.test.ts`, `local-job-runtime.ts`, `log.ts`, `queues.ts`
- `apps/worker/src/jobs/` `maintenance.ts`
- `packages/core/` `drizzle.config.ts`, `package.json`, `tsconfig.json`
- `packages/core/migrations/` `0000_init.sql`, `0015_issue_reports.sql`, `0016_matching_settings.sql`, `0017_openai_matching.sql`, `0018_search_requests.sql`, `0019_source_choices.sql`
- `packages/core/src/` `catalog-client.test.ts`, `catalog-client.ts`, `crypto.ts`, `env.ts`, `index.ts`, `matching.ts`, `public-cache-fixture.ts`, `public-cache.test.ts`, `public-cache.ts`, `queues.ts`, `redis.ts`, `youtube-pace.test.ts`, `youtube-pace.ts`
- `packages/core/src/db/` `index.ts`, `matching.ts`, `migrate-cli.ts`, `migrate.ts`, `schema.ts`
- `packages/platform/` `package.json`, `tsconfig.json`
- `packages/platform/migrations/` `0000_rate_limits.sql`, `0001_events.sql`, `0002_public_read_cache.sql`
- `packages/platform/migrations/meta/` `_journal.json`
- `packages/platform/src/` `events.ts`, `index.ts`, `jobs.ts`, `migrations.ts`, `public-cache.ts`, `rate-limit.ts`, `startup-migrations.ts`
- `packages/platform/tests/` `events.test.ts`, `jobs.test.ts`, `migrations.test.ts`, `public-cache.test.ts`, `rate-limit.test.ts`, `startup-migrations.test.ts`
- `scripts/workspace/` `workspace.test.mjs`

### Validate

Owned tests: 21.

```bash
corepack pnpm --filter @mint/api run typecheck
corepack pnpm --filter @mint/api exec tsx --test tests/admin-accounts.integration.test.ts tests/library.integration.test.ts tests/listening-history.integration.test.ts tests/main.integration.test.ts tests/member-status.integration.test.ts tests/provision-library-root.integration.test.ts tests/runtime.integration.test.ts tests/session.test.ts
corepack pnpm --filter @mint/web run typecheck
corepack pnpm --filter @mint/web run lint
corepack pnpm --filter @mint/worker run typecheck
corepack pnpm --filter @mint/worker exec tsx --test --test-force-exit src/local-job-config.test.ts src/local-job-main.integration.test.ts src/local-job-runtime.integration.test.ts
corepack pnpm --filter @mint/core run typecheck
corepack pnpm --filter @mint/core exec tsx --test src/catalog-client.test.ts src/public-cache.test.ts src/youtube-pace.test.ts
corepack pnpm --filter @mint/platform run typecheck
corepack pnpm --filter @mint/platform exec tsx --test tests/events.test.ts tests/jobs.test.ts tests/migrations.test.ts tests/public-cache.test.ts tests/rate-limit.test.ts tests/startup-migrations.test.ts
node --test scripts/workspace/workspace.test.mjs
corepack pnpm --filter @mint/platform exec tsx --test tests/migrations.test.ts tests/rate-limit.test.ts tests/startup-migrations.test.ts tests/jobs.test.ts tests/events.test.ts tests/public-cache.test.ts
corepack pnpm --filter @mint/api exec tsx --test tests/session.test.ts tests/main.integration.test.ts tests/runtime.integration.test.ts
corepack pnpm --filter @mint/worker exec tsx --test src/local-job-config.test.ts src/local-job-runtime.integration.test.ts src/local-job-main.integration.test.ts
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
