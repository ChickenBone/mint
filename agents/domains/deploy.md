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
- Android distribution compares the native fingerprint with the last successfully uploaded signed APK, not the previous commit. OTA-only changes publish signed exports without Gradle; missing native history builds conservatively.
- Preserve stable APK signing, certificate-bound runtimes, default-branch publication and embedded/offline recovery. Never distribute Expo's debug-signed release default or claim an APK/device check from prebuild alone. See [Android builds](../../docs/android-builds.md).

Details: [workers and operations](../workers-and-operations.md#self-hosting-and-upgrades).

## Entry points and gotchas

- CI (`.github/workflows/ci.yml`) runs typecheck, lint, `agents:check`, tests with Postgres, Redis and ffmpeg, build, audit and Compose validation.
- `deploy/docker/compose.test.mjs` and `caddy.test.mjs` cover Compose and proxy invariants. The Caddy test needs `CADDY_BINARY`.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Docker images, Compose stacks, deploy scripts, CI/release workflows, env examples and self-hosting docs.
- **Read before editing:** [agents/workers-and-operations.md](../workers-and-operations.md), [agents/architecture.md](../architecture.md), [docs/self-hosting.md](../../docs/self-hosting.md).
- **Imports from:** [`mobile`](mobile.md)
- **Imported by:** none
- **Live detail:** `npm run agents -- map deploy` (exports, line counts, cross-domain import edges).

### Owned files (34)

- `./` `.dockerignore`, `.env.development.example`, `.env.example`, `Dockerfile`, `docker-compose.dev.yml`, `docker-compose.musicbrainz.yml`, `docker-compose.nas-migrate.yml`, `docker-compose.nas.yml`, `docker-compose.updates.yml`, `docker-compose.vercel.yml`, `docker-compose.yml`
- `.github/workflows/` `android-apk.yml`, `ci.yml`, `release.yml`
- `apps/web/` `.env.vercel.example`
- `deploy/docker/` `caddy.test.mjs`, `compose.test.mjs`, `entrypoint.sh`, `init.mjs`, `musicbrainz-network.yml`, `musicbrainz.mjs`, `musicbrainz.test.mjs`
- `deploy/mobile/` `android-build.mjs`, `android-build.test.mjs`, `native-runtime.integration.test.mjs`, `native-runtime.mjs`, `native-runtime.test.mjs`, `ota-compose.test.mjs`, `ota-integration.test.mjs`, `ota-publish.mjs`, `ota-publish.test.mjs`, `release-signing.gradle`
- `docs/` `android-builds.md`, `self-hosting.md`

### Validate

Owned tests: 9.

```bash
npm run typecheck -w @mint/web
npm run lint -w @mint/web
node --test deploy/docker/caddy.test.mjs deploy/docker/compose.test.mjs deploy/docker/musicbrainz.test.mjs deploy/mobile/android-build.test.mjs deploy/mobile/native-runtime.integration.test.mjs deploy/mobile/native-runtime.test.mjs deploy/mobile/ota-compose.test.mjs deploy/mobile/ota-integration.test.mjs deploy/mobile/ota-publish.test.mjs
docker compose config --quiet
node --import tsx --test deploy/mobile/*.test.mjs
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.

<!-- agents:generated:end -->
