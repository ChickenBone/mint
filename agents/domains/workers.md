# Volunteer workers and upload hub (`workers`)

> Optional mint-agent downloader, upload hub, agent protocol/API and worker onboarding UI.

## Boundaries

- Owns `apps/agent`, the upload hub entry (`apps/worker/src/hub.ts`), agent API routes (`/api/agent/v1/**`), generated volunteer Compose (`/worker.yml`) and the workers panel.
- Volunteer agents use outbound HTTPS claims, progress and uploads only. They get no private library access. The hub never receives Plex, acquisition-provider or analysis secrets.

## Invariants

- A volunteer registration token never authenticates analysis. Volunteer counts do not measure built-in worker or analysis connectivity.
- Uploads are lease-validated and media-validated.
- Generated volunteer Compose uses an explicit public `MINT_URL`, never build-time `localhost`.
- Remote workers are optional. Mint must work fully without them.

Details: [workers and operations](../workers-and-operations.md).

## Entry points and gotchas

- `core/src/agent-protocol.ts` defines the wire contract shared by `apps/agent`, web API routes and the hub. Change all three together.
- `lib/worker-compose.ts` renders volunteer Compose, with tests in `tests/worker-compose.test.ts`.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Optional mint-agent downloader, upload hub, agent protocol/API and worker onboarding UI.
- **Read before editing:** [agents/workers-and-operations.md](../workers-and-operations.md), [agents/architecture.md](../architecture.md) (UI: also check desktop/mobile per DESIGN.md).
- **Imports from:** [`acquisition`](acquisition.md), [`collections`](collections.md), [`platform`](platform.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Imported by:** [`platform`](platform.md), [`realtime`](realtime.md), [`web-shell`](web-shell.md)
- **Live detail:** `npm run agents -- map workers` (exports, line counts, cross-domain import edges).

### Owned files (21)

- `./` `docker-compose.agent.yml`
- `apps/agent/` `package.json`, `tsconfig.json`
- `apps/agent/src/` `connection.test.ts`, `connection.ts`, `heartbeat.test.ts`, `index.ts`
- `apps/web/src/app/actions/` `workers.ts`
- `apps/web/src/app/api/` `agent/v1/claim/route.ts`, `agent/v1/heartbeat/route.ts`, `agent/v1/jobs/[trackId]/fail/route.ts`, `agent/v1/jobs/[trackId]/progress/route.ts`
- `apps/web/src/app/app/` `workers/page.tsx`
- `apps/web/src/app/worker.yml/` `route.ts`
- `apps/web/src/components/app/` `workers-panel.tsx`
- `apps/web/src/lib/` `agent.ts`, `worker-compose.ts`
- `apps/web/tests/` `worker-compose.test.ts`
- `apps/worker/src/` `hub.ts`
- `packages/core/migrations/` `0001_workers.sql`
- `packages/core/src/` `agent-protocol.ts`

### Validate

Owned tests: 3.

```bash
npm run typecheck -w @mint/agent
npm exec -w @mint/agent -- tsx --test src/connection.test.ts src/heartbeat.test.ts
npm run typecheck -w @mint/web
npm run lint -w @mint/web
npm exec -w @mint/web -- tsx --test --test-force-exit tests/worker-compose.test.ts
npm run typecheck -w @mint/worker
npm run typecheck -w @mint/core
```

> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).
> If you change the schema, add a new migration via `npm run db:generate`; never rewrite applied migrations.

<!-- agents:generated:end -->
