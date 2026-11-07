# Working on Mint

Mint is split into **domains** so an agent session loads only the context a task needs. Prompts do not need to name a domain; route every request yourself.

## Every task

1. Read the always-read guides: [product decisions](agents/product-decisions.md) and [engineering](agents/engineering.md).
2. **Route.** Pick the domains a request touches from the table below, or run `npm run agents -- route "<request>" [paths…]`. Read each chosen card in [`agents/domains/`](agents/domains/README.md) plus the guides that card lists. Skip guides and code of unrelated domains.
3. **Work within owned files.** Treat other domains' exports, API routes, events and schema as contracts. `npm run agents -- map <domain>` shows exports and cross-domain import edges; `npm run agents -- owner <path>` resolves ownership.
4. **Validate narrowly.** `npm run agents -- affected` lists the domains your changes touch and their focused typecheck/lint/test commands. Escalate to root scripts when a shared contract changes.
5. **Keep the map current.** After adding, moving, renaming or deleting files, or changing a domain's scope or invariants, update [`agents/domains.json`](agents/domains.json) or the card's hand-written section and run `npm run agents:sync`. CI runs `npm run agents:check`.

## Large or cross-domain tasks

When a request spans several domains or will not fit comfortably in one session:

1. **Plan by domain.** List one sub-task per domain and the shared contracts between them (`packages/core` schemas/types, migrations, API routes, realtime events).
2. **Contracts first.** Land contract changes in their owning domain before consumers depend on them.
3. **Fan out.** Give each domain sub-task to a separate sub-agent when your tooling supports it; run independent domains in parallel. Each brief contains the user's request verbatim, the card path, the agreed contract, the owned paths it may edit and its `affected` validation commands. A sub-agent that needs a contract change reports back instead of editing another domain.
4. **Integrate.** Review the combined diff, run `npm run agents -- affected`, and fix cross-domain breakage.
5. **Track progress** in the agent's session workspace, never in the repository.

See [working at scale](agents/working-at-scale.md) for adding or splitting domains and the size budgets.

## Domains

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

| Domain | Covers |
| --- | --- |
| [`mobile`](agents/domains/mobile.md) | Expo iOS/Android and responsive web consumer app, client-safe API contracts and native account transport |
| [`mobile-playback`](agents/domains/mobile-playback.md) | Expo audio engine, progressive native queues, lyrics, account-scoped downloads and album-color player presentation |
| [`platform`](agents/domains/platform.md) | Shared schemas, database, migrations, queues, crypto, env and worker runtime plumbing |
| [`playback`](agents/domains/playback.md) | Native player, progressive queues, DSP and Smart Fades, offline, lyrics, listening history and audio delivery |
| [`library`](agents/domains/library.md) | Bounded catalog browsing and search, album/artist views, artwork proxy and cache, artist metadata and Plex indexing |
| [`collections`](agents/domains/collections.md) | Native playlists, likes, smart rules, folders and imports, your-music views, discovery shelves, mixes, radios and playlist sleeves |
| [`providers`](agents/domains/providers.md) | Provider charts, Spotify playlist metadata, YouTube Music linking/sync and provider OAuth |
| [`acquisition`](agents/domains/acquisition.md) | Music requests, backlog, download/finalize jobs, Lidarr/TorBox/Prowlarr/Cobalt/MusicBrainz matching and pipeline stages |
| [`analysis`](agents/domains/analysis.md) | Measured audio analysis (mint-dsp), scheduling/backfills, remote analysis workers and analysis UI |
| [`devices`](agents/domains/devices.md) | Device registry, handoff, remote control and single-output listening parties |
| [`workers`](agents/domains/workers.md) | Optional mint-agent downloader, upload hub, agent protocol/API and worker onboarding UI |
| [`realtime`](agents/domains/realtime.md) | WebSocket service, Redis event channels, realtime tickets and live client components |
| [`web-shell`](agents/domains/web-shell.md) | App layout and navigation, design system/UI kit, auth and accounts, public pages, settings, admin and management views |
| [`deploy`](agents/domains/deploy.md) | Docker images, Compose stacks, deploy scripts, CI/release workflows, env examples and self-hosting docs |
| [`handbook`](agents/domains/handbook.md) | README, product/design contracts, agent handbook, domain routing tooling, UX docs and screenshots |

<!-- agents:generated:end -->

## Standing rules

Preserve existing functionality unless the current user explicitly authorizes a behavior change. These documents describe project intent, not authorization to access a deployment, use credentials, acquire copyrighted material, commit, push or deploy.

`PRODUCT.md` describes product scope; `DESIGN.md` is the current visual contract. The [handbook index](agents/README.md) lists every topic guide. Guides link to implementation and operational references rather than replacing them. Verify behavior against current code and tests; report discrepancies instead of silently treating an old note as current fact.

Do not copy personal deployment details, conversation transcripts, credentials, private library content or local session artifacts into this public repository.
