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
- Mobile-only `main` pushes skip Docker publication and optional server deployment; shared/client/core, backend or mixed changes still release. Tags and manual releases remain unfiltered, and required CI still runs for mobile changes. Keep exclusions limited to the mobile paths in `release.yml`, not global handbook/docs paths.
- Android distribution uses EAS Build and EAS Update. Compare the native fingerprint with a successfully built APK, not the previous commit; compatible JavaScript changes only publish an update, and missing native history builds conservatively.
- EAS baselines must be finished builds with the exact runtime/channel/fingerprint and validated signer; submitted or queued builds authorize no update. Do not restore the retired self-hosted OTA API/volume. EAS hosts application assets, not private media or backend secrets.
- Preserve stable APK signing, exact native runtimes, default-branch publication and embedded/offline recovery. Never distribute Expo's debug-signed release default or claim an APK/device check from prebuild alone. EAS quotas still apply. See [Android builds](../../docs/android-builds.md).

Details: [workers and operations](../workers-and-operations.md#self-hosting-and-upgrades).

## Entry points and gotchas

- CI (`.github/workflows/ci.yml`) runs typecheck, lint, `agents:check`, tests with Postgres, Redis and ffmpeg, build, audit and Compose validation.
- `deploy/docker/compose.test.mjs` and `caddy.test.mjs` cover Compose and proxy invariants. The Caddy test needs `CADDY_BINARY`.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Docker images, Compose stacks, deploy scripts, CI/release workflows, env examples and self-hosting docs.
- **Read before editing:** [agents/workers-and-operations.md](../workers-and-operations.md), [agents/architecture.md](../architecture.md), [docs/self-hosting.md](../../docs/self-hosting.md), [docs/android-builds.md](../../docs/android-builds.md).
- **Imports from:** none
- **Imported by:** none
- **Live detail:** `npm run agents -- map deploy` (exports, line counts, cross-domain import edges).

### Owned files (28)

- `./` `.dockerignore`, `.env.development.example`, `.env.example`, `.gitleaks.toml`, `Dockerfile`, `docker-compose.catalog.yml`, `docker-compose.dev.yml`, `docker-compose.musicbrainz.yml`, `docker-compose.nas-migrate.yml`, `docker-compose.nas.yml`, `docker-compose.vercel.yml`, `docker-compose.yml`
- `.github/workflows/` `android-apk.yml`, `ci.yml`, `release.yml`
- `apps/web/` `.env.vercel.example`
- `deploy/docker/` `caddy.test.mjs`, `catalog-network.yml`, `compose.test.mjs`, `entrypoint.sh`, `init.mjs`, `musicbrainz-network.yml`, `musicbrainz.mjs`, `musicbrainz.test.mjs`
- `deploy/mobile/` `eas-distribution.mjs`, `eas-distribution.test.mjs`
- `docs/` `android-builds.md`, `self-hosting.md`

### Validate

Owned tests: 4.

```bash
npm run typecheck -w @mint/web
npm run lint -w @mint/web
node --test deploy/docker/caddy.test.mjs deploy/docker/compose.test.mjs deploy/docker/musicbrainz.test.mjs deploy/mobile/eas-distribution.test.mjs
docker compose config --quiet
node --import tsx --test deploy/mobile/*.test.mjs
```

<!-- agents:generated:end -->
