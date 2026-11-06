# Deployment and CI (`deploy`)

> Docker images, Compose stacks, deploy scripts, CI/release workflows, env examples and self-hosting docs.

## Boundaries

- Owns `Dockerfile`, all `docker-compose*.yml`, `deploy/**`, `.github/workflows/**`, `.env*.example` files and [self-hosting](../../docs/self-hosting.md).
- Never commit filled settings, real hosts, LAN addresses, tokens or personal paths. Use placeholders such as `mint.example.com`.

## Invariants

- The public web app has no music mount, Plex admin token or media-network access. The pipeline worker bridges private `data` and `media` networks, while PostgreSQL and Redis stay private.
- All-in-one Compose is the recommended deployment. Vercel split hosting needs separately validated private connectivity.
- Upgrade order: update the pipeline worker first, wait for migrations and health, then update web.
- Never use volume or data deletion, host or none network modes, or static container IPs as generic fixes.
- A successful push does not prove CI passed or images were published. Verify the Release workflow before claiming GHCR availability.

Details: [workers and operations](../workers-and-operations.md#self-hosting-and-upgrades).

## Entry points and gotchas

- CI (`.github/workflows/ci.yml`) runs typecheck, lint, `agents:check`, tests with Postgres, Redis and ffmpeg, build, audit and Compose validation.
- `deploy/docker/compose.test.mjs` and `caddy.test.mjs` cover Compose and proxy invariants. The Caddy test needs `CADDY_BINARY`.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Docker images, Compose stacks, deploy scripts, CI/release workflows, env examples and self-hosting docs.
- **Read before editing:** [agents/workers-and-operations.md](../workers-and-operations.md), [agents/architecture.md](../architecture.md), [docs/self-hosting.md](../../docs/self-hosting.md).
- **Imports from:** none
- **Imported by:** none
- **Live detail:** `npm run agents -- map deploy` (exports, line counts, cross-domain import edges).

### Owned files (17)

- `./` `.dockerignore`, `.env.development.example`, `.env.example`, `Dockerfile`, `docker-compose.dev.yml`, `docker-compose.nas-migrate.yml`, `docker-compose.nas.yml`, `docker-compose.vercel.yml`, `docker-compose.yml`
- `.github/workflows/` `ci.yml`, `release.yml`
- `apps/web/` `.env.vercel.example`
- `deploy/docker/` `caddy.test.mjs`, `compose.test.mjs`, `entrypoint.sh`, `init.mjs`
- `docs/` `self-hosting.md`

### Validate

Owned tests: 2.

```bash
npm run typecheck -w @mint/web
npm run lint -w @mint/web
node --test deploy/docker/caddy.test.mjs deploy/docker/compose.test.mjs
docker compose config --quiet
```

<!-- agents:generated:end -->
