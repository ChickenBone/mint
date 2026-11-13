# Platform core (`platform`)

> Shared schemas, database, migrations, queues, crypto, env and worker runtime plumbing. Changes here ripple into every domain.

## Boundaries

- Owns `@mint/core` generic modules (`db/schema.ts`, `db/index.ts`, migrations runner, `queues.ts`, `redis.ts`, `crypto.ts`, `env.ts`, `index.ts`), root/workspace build config and the pipeline worker's entry, config, HTTP, logging and maintenance plumbing.
- Owns target `@mint/platform`: server-only migration/startup primitives and a fixed-window PostgreSQL rate limiter with bounded cleanup.
- Owns `apps/api/**` for target Fastify/tRPC composition and transport only; business rules remain in their domain packages. The callable runtime owns a PostgreSQL pool, runs serialized startup migrations before listening, and composes Accounts and Library repositories for session, approval, member-status, admin account listing/role changes and bounded library operations. Admin operations require a fresh persisted active-admin session. It requires explicit settings, a notification callback and an error logger; it is not a standalone executable.
- API construction requires an explicit canonical 32-byte base64url `gatewayToken`. The `x-mint-gateway-token` service header is checked with constant-time comparison and fails closed before procedures, including framework fallbacks. Service authentication is not user identity: account/session policy is checked through the repository on every valid session lookup. A server-only Next.js binding exists, but forwarded-IP protocol, environment/secret lifecycle and Argon2 HTTP onboarding are not wired.
- Owns server-only `@mint/core/public-cache` read-cache plumbing. Feature owners supply validated public payloads, key identity, freshness/stale/negative policy and invalidation; this module never caches credentials, authorization or account-specific responses.
- Feature-specific core files (for example `core/src/devices.ts`, `db/music.ts`) belong to their feature domain. Change them there.
- PostgreSQL and Redis stay on private networks. Nothing here may expose them or weaken [trust boundaries](../architecture.md#non-negotiable-boundaries).

## Invariants

- Legacy `@mint/core` migrations run through the pipeline worker. Add one with `npm run db:generate` and keep its journal consistent; never rewrite an applied migration.
- The target runner applies platform rate limits, Accounts, Catalog, Library identity and Library listing SQL through one explicit central Drizzle journal. The startup helper uses a dedicated client/session advisory lock and timeout, fixed `mint_migrations.__drizzle_migrations` history and explicit package SQL root/mappings. The callable API invokes it before listening; there is no executable entrypoint or default configuration, and it does not establish Docker artifact readiness.
- Signing purposes stay separate: artwork claims must never authorize audio.
- Keep PostgreSQL with its original generated encryption/signing secrets. Never suggest deleting databases, volumes or secrets as a fix.
- Queue jobs remain deterministic and deduplicated: transactional and advisory locks, conflict-safe revisions.
- Cache coordination, leases, cooldowns and admission stay bounded. A Redis outage must not turn into unthrottled provider reads; stale/negative/error states remain distinct and cache invalidation must prevent stale in-flight repopulation.
- Adapters that must honor a provider refusal even for fresh entries use `respectCooldownForFresh`; the default cache behavior remains unchanged for other providers.

## Contracts

- `@mint/core` subpath exports in `packages/core/package.json` are the public API for apps. Adding or renaming one is a cross-domain change, so run root `npm run typecheck`.
- `@mint/platform` exports `runMigrations`, `MigrationJournal`, `MigrationOptions`, `PostgresRateLimiter`, `rateLimits`, `runStartupMigrations` and `StartupMigrationOptions`. PostgreSQL integration tests skip unless `MINT_TEST_POSTGRES_BIN` names existing local binaries; the opt-in creates and cleans a disposable cluster, never using a deployment database URL. API runtime invokes the helper; worker boot and deployment artifact wiring remain separate work.
- `db/schema.ts` is imported by nearly every domain. Coordinate column changes with the owning feature domain.
- `PublicReadCache` policies/coverage are documented in [architecture](../architecture.md#server-side-public-read-caches); injected `public-cache-fixture.ts` is test-only. TTL/version/provider identity invalidates reads; there is no manual purge API or global Redis byte cap. Run core cache tests and actual feature-adapter regressions for contract changes.

## Entry points and gotchas

- Worker boot: `apps/worker/src/index.ts`, followed by `config.ts`. Migrations: `packages/core/src/db/migrate.ts`.
- `apps/web/src/lib/request.ts` (bounded JSON and public URL) and `rate-limit.ts` are shared web helpers.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Shared schemas, database and platform primitives, workspace plumbing, and target API composition/transport.
- **Read before editing:** [agents/architecture.md](../architecture.md).
- **Imports from:** [`accounts`](accounts.md), [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`catalog`](catalog.md), [`library`](library.md), [`mobile-contracts`](mobile-contracts.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md), [`workers`](workers.md)
- **Imported by:** [`accounts`](accounts.md), [`acquisition`](acquisition.md), [`analysis`](analysis.md), [`catalog`](catalog.md), [`collections`](collections.md), [`devices`](devices.md), [`library`](library.md), [`mobile-contracts`](mobile-contracts.md), [`playback`](playback.md), [`providers`](providers.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md), [`workers`](workers.md)
- **Live detail:** `npm run agents -- map platform` (exports, line counts, cross-domain import edges).

### Owned files (72)

- `./` `nx.json`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- `apps/api/` `package.json`, `tsconfig.json`
- `apps/api/src/` `index.ts`, `runtime.ts`, `server.ts`
- `apps/api/tests/` `admin-accounts.integration.test.ts`, `library.integration.test.ts`, `member-status.integration.test.ts`, `runtime.integration.test.ts`, `session.test.ts`
- `apps/web/` `eslint.config.mjs`, `next-env.d.ts`, `next.config.ts`, `package.json`, `postcss.config.mjs`, `tsconfig.json`
- `apps/web/src/lib/` `queues.ts`, `rate-limit.ts`, `request.ts`
- `apps/worker/` `package.json`, `tsconfig.json`
- `apps/worker/src/` `config.ts`, `files.ts`, `http.ts`, `index.ts`, `log.ts`, `queues.ts`
- `apps/worker/src/jobs/` `maintenance.ts`
- `packages/core/` `drizzle.config.ts`, `package.json`, `tsconfig.json`
- `packages/core/migrations/` `0000_init.sql`, `0015_issue_reports.sql`, `0016_matching_settings.sql`, `0017_openai_matching.sql`, `0018_search_requests.sql`, `0019_source_choices.sql`
- `packages/core/src/` `catalog-client.test.ts`, `catalog-client.ts`, `crypto.ts`, `env.ts`, `index.ts`, `matching.ts`, `public-cache-fixture.ts`, `public-cache.test.ts`, `public-cache.ts`, `queues.ts`, `redis.ts`, `youtube-pace.test.ts`, `youtube-pace.ts`
- `packages/core/src/db/` `index.ts`, `matching.ts`, `migrate-cli.ts`, `migrate.ts`, `schema.ts`
- `packages/platform/` `package.json`, `tsconfig.json`
- `packages/platform/migrations/` `0000_rate_limits.sql`
- `packages/platform/migrations/meta/` `_journal.json`
- `packages/platform/src/` `index.ts`, `migrations.ts`, `rate-limit.ts`, `startup-migrations.ts`
- `packages/platform/tests/` `migrations.test.ts`, `rate-limit.test.ts`, `startup-migrations.test.ts`
- `scripts/workspace/` `workspace.test.mjs`

### Validate

Owned tests: 12.

```bash
corepack pnpm --filter @mint/api run typecheck
corepack pnpm --filter @mint/api exec tsx --test tests/admin-accounts.integration.test.ts tests/library.integration.test.ts tests/member-status.integration.test.ts tests/runtime.integration.test.ts tests/session.test.ts
corepack pnpm --filter @mint/web run typecheck
corepack pnpm --filter @mint/web run lint
corepack pnpm --filter @mint/worker run typecheck
corepack pnpm --filter @mint/core run typecheck
corepack pnpm --filter @mint/core exec tsx --test src/catalog-client.test.ts src/public-cache.test.ts src/youtube-pace.test.ts
corepack pnpm --filter @mint/platform run typecheck
corepack pnpm --filter @mint/platform exec tsx --test tests/migrations.test.ts tests/rate-limit.test.ts tests/startup-migrations.test.ts
node --test scripts/workspace/workspace.test.mjs
corepack pnpm --filter @mint/api exec tsx --test tests/session.test.ts
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
