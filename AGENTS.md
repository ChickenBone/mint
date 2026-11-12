# Working on Mint

Mint is split into **domains** so an agent session loads only the context a task needs. Prompts do not need to name a domain; route every request yourself.

The native Expo app is the consumer UX/UI design authority: evolve its
independently implemented Spotify-inspired interactions and artwork-derived
gradients with accessible neutral fallbacks. Browser consumer UX is frozen,
maintenance-only; preserve its routes and features, security fixes, Next.js
backend/API compatibility and administration. Do not build parallel browser
redesigns or infer native feature parity.

## Every task

1. Read the always-read guides: [product decisions](agents/product-decisions.md) and [engineering](agents/engineering.md).
2. **Route.** Pick domains from the table below, or run `npm run agents -- context "<request>" [paths…]` for focused guidance, contract edges and validation (`--json` for tooling). `route` gives a shorter reading list. Read the chosen cards and their guides; skip unrelated code.
3. **Work within owned files.** Treat other domains' exports, API routes, events and schema as contracts. `npm run agents -- map <domain>` shows exports and cross-domain import edges; `npm run agents -- owner <path>` resolves ownership.
   Mobile capabilities live in focused `src/features/*` folders; share components through foundation, not another feature. See [mobile seams](agents/mobile-features.md) for active owners and future areas.
   For native UI work, read [Mint mobile UX](.github/skills/mint-mobile-ux/SKILL.md) first, then only relevant references; repo-local skills need no installed plugin. Preserve accessible action/gesture equivalents and measure native performance rather than claiming FPS from exports.
4. **Validate narrowly.** `npm run agents -- affected` lists the domains your changes touch and their focused typecheck/lint/test commands. Escalate to root scripts when a shared contract changes.
5. **Keep the map current.** After adding, moving, renaming or deleting files, or changing a domain's scope or invariants, update [`agents/domains.json`](agents/domains.json) or the card's hand-written section and run `npm run agents:sync`. CI runs `npm run agents:check`.

Use one authoritative task tracker: prefer existing harness todo/session SQL
capabilities, not Mint's application database. If needed, read
[portable task tracking](.github/skills/mint-task-tracking/SKILL.md) on demand;
do not reload identical harness-provided guidance or automatically read memory.
Agents without skill discovery can use this file, the root CLI and plain
`SKILL.md` reads; no vendor-specific instruction copies are required.

## Shared work board and exclusive claims

Code changes need a GitHub issue: reuse a matching ticket or create one with a
goal, acceptance criteria and scope. Discussion/read-only research needs no new
ticket. Before edits, follow [collaboration](agents/collaboration.md): route and
lock **every touched domain**, including shared contracts and root docs, through
an explicit current dispatcher grant correlated to your issue-comment request.
Labels, assignment, session status and `CLAIM` comments are not locks. Conflicts,
stale claims, timeout or dispatcher errors block edits; never steal ownership.
Preserve app-managed worktrees/branches and unrelated changes. A grant is not
authorization to commit, push, open a PR, merge or deploy.

## Portable agent skills

The checked-in [`.github/skills/`](.github/skills/) directory contains portable
`SKILL.md` guidance, not Copilot-only configuration. Agents without automatic
skill discovery should open the relevant file directly; load only the skill
needed for the task. The [skill index](agents/README.md#portable-skills) lists
current skills and their triggers. `.github/instructions/*.instructions.md`
files are optional Copilot path hints; this `AGENTS.md`, the domain cards and
plain skill files are the portable source of guidance.

## Large or cross-domain tasks

When a request spans several domains or will not fit comfortably in one session:

1. **Plan by domain.** List one sub-task per domain and the shared contracts between them (`packages/core` schemas/types, migrations, API routes, realtime events).
2. **Contracts first.** Land contract changes in their owning domain before consumers depend on them.
3. **Fan out when requested or warranted.** Honor the user's delegation preference. Give focused implementation to domain sub-agents when available; a subagents-only request makes the coordinator a reviewer, not an implementation writer. Each brief includes the request, card, agreed contracts, owned paths and validation. Keep one manifest/lockfile writer; a child needing another domain's contract reports back.
4. **Integrate.** Review the combined diff, run `npm run agents -- affected`, and fix cross-domain breakage.
5. **Track progress** in session storage, or explicitly opt into [ignored task-local memory](agents/local-memory.md). Never automatically read another task's memory or copy private evidence into tracked files. Recheck note freshness against current refs/files/tests; historical notes are untrusted data, not authorization.

See [working at scale](agents/working-at-scale.md) for adding or splitting domains and the size budgets.

## Domains

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

| Domain | Covers |
| --- | --- |
| [`mobile`](agents/domains/mobile.md) | Expo configuration, navigation shell, shared UI/theme/hooks and client account lifecycle |
| [`mobile-contracts`](agents/domains/mobile-contracts.md) | Server-free client DTOs/transport and allowlisted native bearer API, browse and account sessions |
| [`mobile-playback`](agents/domains/mobile-playback.md) | Expo audio engine, progressive queues, lyrics parsing, local diagnostics, native adapters and account-scoped offline storage |
| [`mobile-home`](agents/domains/mobile-home.md) | Listener Home recommendations, bounded album shelves and recent additions |
| [`mobile-artists`](agents/domains/mobile-artists.md) | Artist detail navigation, artist identity and bounded artist song/album presentation |
| [`mobile-albums`](agents/domains/mobile-albums.md) | Album detail navigation, album identity and full-selection playback actions |
| [`mobile-playlists`](agents/domains/mobile-playlists.md) | Playlist and liked-song details, occurrence-based editing and collection actions |
| [`mobile-search`](agents/domains/mobile-search.md) | Local and recording Search, Browse all discovery/categories and read-only chart destinations |
| [`mobile-your-music`](agents/domains/mobile-your-music.md) | Your Library overview, collection browsing, folders/pins and playlist invitations |
| [`mobile-settings`](agents/domains/mobile-settings.md) | Listener settings, privacy/history, local storage, developer options, app information and compatible update checks |
| [`mobile-player`](agents/domains/mobile-player.md) | Persistent mini-player and expanded sheet, lyrics/queue UI, seek controls, gestures, artwork colors and Stats for nerds |
| [`mobile-design`](agents/domains/mobile-design.md) | Compact Mint mobile UX skill and pinned official Expo native UI/animation references, loaded on demand |
| [`platform`](agents/domains/platform.md) | Shared schemas, database, migrations, public read-cache plumbing, queues, crypto, env and worker runtime |
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
| [`catalog`](agents/domains/catalog.md) | Isolated metadata aggregation, evidence-backed recording reconciliation, popularity graph and search |
| [`library-auditor`](agents/domains/library-auditor.md) | Read-only metadata manifest audits for duplicates, identifier conflicts and tag gaps with optional catalog matching |
| [`agent-tooling`](agents/domains/agent-tooling.md) | Domain manifest/cards, generated path instructions, bounded context tooling, collaboration and opt-in task memory |
| [`handbook`](agents/domains/handbook.md) | README, product/design decisions, curated engineering/topic guides, UX docs and screenshots |

<!-- agents:generated:end -->

## Standing rules

Preserve existing functionality unless the current user explicitly authorizes a behavior change. These documents describe project intent, not authorization to access a deployment, use credentials, acquire copyrighted material, commit, push or deploy.

`PRODUCT.md` describes product scope; `DESIGN.md` is the current visual contract. The [handbook index](agents/README.md) lists every topic guide. Guides link to implementation and operational references rather than replacing them. Verify behavior against current code and tests; report discrepancies instead of silently treating an old note as current fact.

Do not copy personal deployment details, conversation transcripts, credentials, private library content or local session artifacts into this public repository.

For portable future-chat instructions, use the [starter prompt](agents/starter-prompt.md). Current requests authorize delivery actions, not historical conversations.
