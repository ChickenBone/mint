# Playwright, mocking and screenshot workflow

## Reuse the committed fixture

The reproducible listening-room fixture is:

- `apps/web/tests/fixtures/redesign-preview.mjs`: fictional database seed, cached charts, synthetic WAV/PNG gateway, browser assertions and screenshot capture.
- `apps/web/tests/fixtures/redesign-network.mjs`: explicitly preloaded test-only MusicBrainz transport adapter.
- [Fixture setup](../docs/charts.md#upgrading-and-validation): current supported prerequisites.

Do not depend on a prior agent's home directory, browser cache path, session state, installed services or ephemeral screenshots. Those are not portable repository tools.

The preview enforces `MINT_REDESIGN_FIXTURE=true`, a database named `mint_demo` or `mint_redesign_demo`, and loopback Redis. Use a fresh migrated database and a dedicated Redis process/port; queue/cache writes share that instance. Never relax its guards to use a real library.

The fixture does not create PostgreSQL/Redis or start web for you. Provision those separately, run migrations against the disposable database, and give both web and fixture the same connection/signing settings.

### Example process setup

Run from the repository root, replacing the local database/Redis ports with your isolated services:

```bash
export DATABASE_URL=postgres://mint@127.0.0.1:55432/mint_redesign_demo
export REDIS_URL=redis://127.0.0.1:56379
export PUBLIC_URL=http://127.0.0.1:3087
export PLAYBACK_WORKER_URL=http://127.0.0.1:3088
export MINT_REDESIGN_FIXTURE=true
export MINT_SIGNING_SECRET="$(openssl rand -hex 32)"
npm run db:migrate
npm run build -w @mint/web
```

In the web process's environment, also set the explicit test preload:

```bash
NODE_OPTIONS="--import=$PWD/apps/web/tests/fixtures/redesign-network.mjs" \
  npm run start -w @mint/web -- --hostname 127.0.0.1 --port 3087
```

In a second terminal with the **same exported settings**, run:

```bash
npm exec -w @mint/web -- tsx tests/fixtures/redesign-preview.mjs
```

This requires Playwright, its Chromium binary and `sharp` in the tooling environment. If Playwright is installed outside the project, `PLAYWRIGHT_MODULE` accepts its resolvable module location; do not commit a personal absolute path. Inspect the installed toolchain and report missing prerequisites instead of assuming they exist or adding unrelated runtime dependencies.

The fixture is a one-shot seed/test/capture tool: it closes its gateway/connections on normal completion, and refuses an already populated track database. Reruns need a new disposable database or the fixture's narrowly guarded reset, never a production truncate. It writes tracked screenshots, so review their diff.

## What stays real and what is mocked

| Layer | Preview behavior |
| --- | --- |
| Next.js app, auth/session lookup, catalog and chart API | Real application routes and database behavior |
| Chart rankings | Redis-seeded, explicitly labeled fictional snapshots, not live provider evidence |
| MusicBrainz recording lookup | One explicitly intercepted hostname forwarded to a local fixture endpoint |
| Acquisition request | Real signed/member request, ownership/deduplication and BullMQ enqueue |
| Download/processing completion | Simulated database stage changes; no third-party media acquisition |
| Private media/artwork gateway | Test server checking signed claims and serving synthetic bytes/ranges; not the production worker implementation |
| Browser | Real Chromium, real navigation and audio element behavior |

Do not describe the preview as proof of live Plex, TorBox, Cobalt, provider availability or production private-network connectivity.

For production gateway behavior use existing worker integrations such as `artwork.integration.test.ts` and `playback.integration.test.ts`. These exercise actual worker handlers with isolated databases and controlled upstream responses. For scale use the playback/library-index regressions. Match the test to the claim.

## Mock at the narrowest boundary

- Keep mocks in explicit test/fixture code. Never add production query flags or silent fallback rankings to make screenshots work.
- Mock external providers, not the internal feature being verified.
- Preserve request method, headers, body, abort signals, URL identity and relevant redirects/ranges.
- Validate that public provider fetches never carry Plex/auth secrets.
- Restore global fetch/time mocks after tests; use unique identities or isolated processes to avoid cache contamination.
- Exercise failure, cooldown, stale recovery and eventual success, not only the first happy response.
- Advance controlled time for cache expiry; do not sleep through hours of TTL.
- Route-specific `page.route()` mocks can verify stale/empty/error UI. Remove them before checking real acquisition/availability behavior.
- Do not intercept every network request with a generic success response; unexpected requests should remain visible.

The existing network adapter redirects only MusicBrainz in explicitly enabled demo mode. It is not a general production provider shim.

## Browser assertions that caught real regressions

Prefer role/label selectors and explicit readiness over CSS position and arbitrary timeouts:

```javascript
await page.getByRole("button", { name: "Play Daily blend", exact: true }).click();
await page.waitForFunction(() =>
  [...document.querySelectorAll("audio")].some(
    (audio) => !audio.paused && audio.currentTime > 0.1
  )
);
```

Verify **audio continuity**, not just a changed Play icon: mark the playing audio element, navigate through the app and confirm that the same element's time continues. Check it remains mounted during chart status refresh and recording selection.

Use separate unauthenticated, pending-member and approved-member contexts. Assert public/pending audio and acquisition are rejected, public chart items contain no playable member payload, and cross-origin mutations fail.

For chart requests assert one track/job is created, repeat requests deduplicate, processing becomes playable without document reload, and ambiguous editions open resolution rather than silently acquiring. Play-local must preserve rank order and not create missing tracks.

When using session cookies, generate an ephemeral test session and store its hash through the normal schema. Never use a real member cookie or password.

## Readiness and diagnostics

- Match the browser origin exactly to `PUBLIC_URL`, including hostname and port. Mixing `localhost` and `127.0.0.1` can cause genuine same-origin rejection.
- Confirm each owned server is responsive before browser work. A ready HTTP response alone is not image/player readiness.
- Wait for expected headings/API-backed rows and `document.fonts.ready`.
- For visible images, check `complete && naturalWidth > 0`. Count intersections on **both axes**; horizontally offscreen/lazy shelf images may correctly remain unloaded.
- Inspect image status, actual bytes, cache headers and source counters when testing artwork priority. A plausible placeholder is not proof of loaded Plex art.
- Capture `pageerror`, failed requests and relevant HTTP failures. Browser console output alone does not distinguish an intentional error-state test from an application failure.
- A `200` health response does not prove signed media access, a lease does not prove result submission, and a screenshot does not prove audio.

Some fixture screenshots use short fixed waits. For new regression checks, use event/state-based assertions where possible rather than copying the timing shortcut.

## Bounded screenshot pass

Build the implementation, then inspect one batched set: desktop (around 1440px), phone (390px) and narrow phone (320px), including long content and active player. Use reduced motion for stable capture, but test motion preferences separately when changing animation.

Capture Home, Discover shelves, a selected chart, Library, Now Playing and affected management/public screens. Ensure images/fonts have loaded and the page has no unintended horizontal overflow. A horizontally scrollable shelf is intentional; the entire document overflowing is not.

Review a contact sheet plus key full-resolution views. Batch actual fixes and confirm at most once; do not enter an unbounded screenshot/polish loop. Keep the final images consistent with the final code.

Finally stop owned web/gateway/Redis processes, close browsers/connections and remove only owned disposable databases. Restore only generated files you created; do not revert someone else's work.
