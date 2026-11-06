# Engineering, validation and delivery

## Working approach

- Inspect the current code, shared helpers and tests before editing. Follow existing patterns and retain type safety.
- Prefer precise root-cause fixes and reusable existing contracts over shortcuts, broad rewrites or duplicate state.
- Preserve unrelated work and existing behavior. UI redesign does not authorize feature removal, permission changes or schema resets.
- Ask for decisions that materially change product behavior, provider cost, deployment exposure or scope.
- Surface failures explicitly with actionable states and repository-standard logging. Never swallow errors into success-shaped defaults.
- Respect source/service terms and only support acquisition the operator is authorized to perform.

This handbook does not authorize Git publication or deployment. Commit, push, tag, change branches or deploy only when the current user requests it. A past request to push does not authorize future pushes.

## Validation by change

Use the smallest existing command covering the change; expand when results require it. Root scripts are `npm run typecheck`, `npm run lint`, `npm test` and `npm run build`; workspace selectors allow focused checks. Node.js 22+ is required.

| Change | Evidence to preserve |
| --- | --- |
| Player/queues | Progressive loading, full-collection selection, shuffle uniqueness, duplicate occurrences, cancellation/races, navigation continuity, paused restoration and account isolation |
| Audio/artwork | Signed-purpose separation, access/range behavior, private credentials, fallback/cache/coalescing, invalid upstream content and response budgets |
| Library/acquisition | Large-library paging, conservative recording/version matching, deduplication, source pinning and read-only originals |
| Analysis | Real media measurements where applicable, leases/result handling, resource/schedule limits, resumable backfills, cancellation and remote authentication |
| Charts | Provider shape/rank semantics, cache/failure states, bounded DB matching, explicit request lifecycle and public/member separation |
| UI | Desktop/mobile, keyboard/focus, reduced motion, overflow, state/error recovery and persistent playback |
| Deployment | Compose validation, relevant `deploy/docker` tests, migration startup/order, private networks and secret separation |
| Documentation | Correct relative links/anchors, current screenshots, accurate commands, generic examples and honest limitations |

Some integration tests skip without PostgreSQL/Redis/audio environment settings. Inspect the test and `.github/workflows/ci.yml`; a skipped integration is not a passed integration. Never point destructive fixture/database tests at a real deployment.

Use isolated disposable databases and Redis namespaces. Start only owned test processes, verify readiness and stop them afterward. Clean generated build artifacts without reverting unrelated edits.

## Verify the actual outcome

- A build passing does not prove playback, acquisition, provider reachability or physical Android behavior.
- Fixture charts/media prove defined local flows, not a live third-party download or NAS installation.
- A successful Git push does not prove CI passed, images published or the server updated.
- A UI status or Compose file does not establish actual network connectivity.
- State the exact evidence and remaining uncertainty; never claim an unresolved incident was fixed by unrelated changes.

For frontend work, use one batched desktop/mobile inspection, fix actual defects together, and perform a bounded confirmation rather than an open-ended polish loop.

## Public documentation and screenshots

Keep the README approachable: what Mint does, requirements, installation choices, first session, upgrades and troubleshooting. Detailed operational instructions belong in `docs/self-hosting.md`; provider/device details have their own guides.

Update search/social metadata and stale product wording when changing public positioning. Do not keyword-stuff or promise unsupported Spotify/Plex functionality.

Screenshots use fictional names/accounts/tracks/activity and original generated or properly licensed assets. See the gated fixture instructions in [chart documentation](../docs/charts.md#upgrading-and-validation). Keep demo transport gated and outside production behavior.

The [browser testing guide](browser-testing-and-mocks.md) explains Playwright setup, mock boundaries, image readiness and persistent-audio assertions. The [sleeves and shelves guide](sleeves-and-shelves.md) covers generated virtual-collection artwork and discovery behavior.

Do not commit filled Compose settings, `.env`, exported cookies, credentials, private logs, personal paths, backups, database contents, or local session evidence. Document secret *names and handling*, never real values. Use redacted scans that do not print findings into public output.

## Maintaining this folder

Update only the guides directly affected by a new durable decision. Durable per-area invariants belong in the owning [domain card](domains/README.md). After adding, moving or deleting files, run `npm run agents:sync`; `npm run agents:check` must pass. Mark superseded decisions and unresolved observations honestly. Keep `PRODUCT.md`, `DESIGN.md` and operational references aligned; avoid copying implementation constants into multiple sources without a reason.
