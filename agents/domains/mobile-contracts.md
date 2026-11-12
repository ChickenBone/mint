# Native client and server contracts (`mobile-contracts`)

## Boundaries

- Owns server-free `@mint/client` DTOs, runtime validation and HTTP transport; native API/auth routes and request-local native session/browse adapters/tests.
- UI feature owners consume exports rather than loading backend implementation. Backend catalog, collections, acquisition, playback and account rules remain in their current domains.

## Invariants and contracts

- Native bearer sessions are expiring, revocable and account/installation-bound. Store only token hashes server-side; installation metadata is not authorization.
- The native facade delegates only allowlisted consumer handlers, even for admins. Preserve web cookie/Origin/CSRF behavior; never forge Origin or expose management capabilities.
- Browse categories/counts come from real playable data; charts are GET-only. Explicit Search acquisition remains distinct from browse/play.
- Analysis is GET-only with existing member/playable-track checks. Client DTOs expose measured v1/v2 scalars and bounded envelopes/contours, never worker notes/errors, fingerprints or embeddings; admin membership does not widen native fields.
- Preserve DTO entity kinds, revisions, frozen queue/occurrence identity and bounded pagination. The browser player shares client schemas rather than diverging.
- No database, Redis, Node/server-only modules or worker secrets in `@mint/client`. Public artwork and authenticated media retain separate signing purposes.
- Shared-package changes require root consumer typechecks. Database/native session integrations require isolated fixtures; skipped tests are not verified behavior.

Use the generated focused checks below and inspect current allowlists before adding transport.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Server-free client DTOs/transport and allowlisted native bearer API, browse and account sessions.
- **Read before editing:** [agents/architecture.md](../architecture.md), [docs/mobile.md](../../docs/mobile.md).
- **Imports from:** [`analysis`](analysis.md), [`collections`](collections.md), [`library`](library.md), [`platform`](platform.md), [`playback`](playback.md), [`providers`](providers.md), [`web-shell`](web-shell.md)
- **Imported by:** [`collections`](collections.md), [`library`](library.md), [`mobile`](mobile.md), [`mobile-albums`](mobile-albums.md), [`mobile-artists`](mobile-artists.md), [`mobile-home`](mobile-home.md), [`mobile-playback`](mobile-playback.md), [`mobile-player`](mobile-player.md), [`mobile-playlists`](mobile-playlists.md), [`mobile-search`](mobile-search.md), [`mobile-your-music`](mobile-your-music.md), [`playback`](playback.md), [`web-shell`](web-shell.md)
- **Live detail:** `npm run agents -- map mobile-contracts` (exports, line counts, cross-domain import edges).

### Owned files (19)

- `apps/web/src/app/api/` `native/[...path]/route.ts`, `native/auth/[action]/route.ts`
- `apps/web/src/lib/` `native-browse.ts`, `native-context.ts`, `native-http.ts`, `native-sessions.ts`
- `apps/web/tests/` `native-auth.test.ts`, `native-http.integration.test.ts`, `native-sessions.test.ts`
- `packages/client/` `package.json`, `tsconfig.json`
- `packages/client/src/` `analysis.ts`, `api.ts`, `auth.ts`, `index.ts`, `music.ts`, `playback.ts`
- `packages/client/tests/` `analysis.test.ts`, `client.test.ts`

### Validate

Owned tests: 5.

```bash
npm run typecheck -w @mint/web
npm run lint -w @mint/web
npm exec -w @mint/web -- tsx --test --test-force-exit tests/native-auth.test.ts tests/native-http.integration.test.ts tests/native-sessions.test.ts
npm run typecheck -w @mint/client
npm exec -w @mint/client -- tsx --test tests/analysis.test.ts tests/client.test.ts
```

> Integration/DB tests skip without PostgreSQL/Redis/audio env vars; see `.github/workflows/ci.yml`. A skip is not a pass.
> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).

<!-- agents:generated:end -->
