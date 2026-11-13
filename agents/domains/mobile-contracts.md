# Native client and server contracts (`mobile-contracts`)

## Boundaries

- Owns server-free `@mint/contracts` shared schemas and native `@mint/client` DTOs, runtime validation and HTTP transport; native API/auth routes and request-local native session/browse adapters/tests. Also owns the separate `@mint/sdk`, a runtime-validated wrapper over the official tRPC client.
- UI feature owners consume exports rather than loading backend implementation. Backend catalog, collections, acquisition, playback and account rules remain in their current domains.

## Invariants and contracts

- Native bearer sessions are expiring, revocable and account/installation-bound. Store only token hashes server-side; installation metadata is not authorization.
- The native facade delegates only allowlisted consumer handlers, even for admins. Preserve web cookie/Origin/CSRF behavior; never forge Origin or expose management capabilities.
- Browse categories/counts come from real playable data; charts are GET-only. Explicit Search acquisition remains distinct from browse/play.
- Analysis is GET-only with existing member/playable-track checks. Client DTOs expose measured v1/v2 scalars and bounded envelopes/contours, never worker notes/errors, fingerprints or embeddings; admin membership does not widen native fields.
- Preserve DTO entity kinds, revisions, frozen queue/occurrence identity and bounded pagination. The browser player shares client schemas rather than diverging.
- Do not conflate `@mint/sdk` with native `@mint/client`: it wraps the official tRPC client for session, approval, member-status, admin account listing/role changes and Library listing operations, not a generated router SDK. Admin listing defaults to 50 and caps at 100, with strict status/members and search filters bound to its UUID cursor; results expose only id, email, name, role, status, request note and ISO creation time. The SDK requires an explicit URL and `gatewayToken`, with an optional canonical browser-session token forwarded as its dedicated cookie. Runtime depends only on `@mint/contracts` and `@trpc/client`, not the server app, Node, core or a database; Expo and `@mint/client` remain unchanged.
- Contracts define the canonical 32-byte base64url gateway-credential grammar and `x-mint-gateway-token` header. The secret value belongs only in a trusted server consumer, never a browser bundle; this service credential is not user authentication.
- No database, Redis, Node/server-only modules or worker secrets in runtime source for `@mint/contracts`, `@mint/client` or `@mint/sdk`. Contracts must not depend on the client; schema validation does not assert authorization. Public artwork and authenticated media retain separate signing purposes.
- `scripts/workspace/workspace.test.mjs` checks all three packages' runtime dependency metadata, public-export imports and own-source confinement using one AST scanner; it is not a security sandbox or transitive dependency analysis.
- Shared-package changes require root consumer typechecks. Database/native session integrations require isolated fixtures; skipped tests are not verified behavior.

Use the generated focused checks below and inspect current allowlists before adding transport.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Shared contracts, native @mint/client transport, a separate runtime-validated @mint/sdk wrapper, and allowlisted native API.
- **Read before editing:** [agents/architecture.md](../architecture.md), [docs/mobile.md](../../docs/mobile.md).
- **Imports from:** [`analysis`](analysis.md), [`collections`](collections.md), [`devices`](devices.md), [`library`](library.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`web-shell`](web-shell.md)
- **Imported by:** [`accounts`](accounts.md), [`collections`](collections.md), [`devices`](devices.md), [`library`](library.md), [`mobile`](mobile.md), [`mobile-albums`](mobile-albums.md), [`mobile-artists`](mobile-artists.md), [`mobile-home`](mobile-home.md), [`mobile-playback`](mobile-playback.md), [`mobile-player`](mobile-player.md), [`mobile-playlists`](mobile-playlists.md), [`mobile-search`](mobile-search.md), [`mobile-your-music`](mobile-your-music.md), [`platform`](platform.md), [`playback`](playback.md), [`web-shell`](web-shell.md)
- **Live detail:** `npm run agents -- map mobile-contracts` (exports, line counts, cross-domain import edges).

### Owned files (41)

- `apps/web/src/app/api/` `native/[...path]/route.ts`, `native/auth/[action]/route.ts`
- `apps/web/src/lib/` `native-browse.ts`, `native-context.ts`, `native-http.ts`, `native-sessions.ts`
- `apps/web/tests/` `native-auth.test.ts`, `native-http.integration.test.ts`, `native-sessions.test.ts`
- `packages/client/` `package.json`, `tsconfig.json`
- `packages/client/src/` `analysis.ts`, `api.ts`, `auth.ts`, `catalog.ts`, `devices.ts`, `index.ts`, `music.ts`, `playback.ts`, `search-identity.ts`
- `packages/client/tests/` `analysis.test.ts`, `client.test.ts`
- `packages/contracts/` `package.json`, `tsconfig.json`
- `packages/contracts/src/` `account-inputs.ts`, `accounts.ts`, `admin-accounts.ts`, `browser-session.ts`, `gateway-auth.ts`, `index.ts`, `library.ts`
- `packages/contracts/tests/` `account-inputs.test.ts`, `accounts.test.ts`, `browser-session.test.ts`, `gateway-auth.test.ts`
- `packages/sdk/` `package.json`, `tsconfig.json`
- `packages/sdk/src/` `index.ts`
- `packages/sdk/tests/` `library.test.ts`, `member-status.test.ts`, `session.test.ts`

### Validate

Owned tests: 12.

```bash
corepack pnpm --filter @mint/web run typecheck
corepack pnpm --filter @mint/web run lint
corepack pnpm --filter @mint/web exec tsx --test --test-force-exit tests/native-auth.test.ts tests/native-http.integration.test.ts tests/native-sessions.test.ts
corepack pnpm --filter @mint/client run typecheck
corepack pnpm --filter @mint/client exec tsx --test tests/analysis.test.ts tests/client.test.ts
corepack pnpm --filter @mint/contracts run typecheck
corepack pnpm --filter @mint/contracts exec tsx --test tests/account-inputs.test.ts tests/accounts.test.ts tests/browser-session.test.ts tests/gateway-auth.test.ts
corepack pnpm --filter @mint/sdk run typecheck
corepack pnpm --filter @mint/sdk exec tsx --test tests/library.test.ts tests/member-status.test.ts tests/session.test.ts
corepack pnpm --filter @mint/sdk exec tsx --test tests/session.test.ts
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).

<!-- agents:generated:end -->
