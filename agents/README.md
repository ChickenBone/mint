# Public agent handbook

This folder captures the durable requirements, design decisions and engineering lessons from Mint's development conversations. It is a curated guide, **not a transcript**. Repeated requests are consolidated, superseded directions are labeled, and personal deployment details and secrets are excluded.

## Reading map

Agents route each task to one or more **domains** first. See the [domain index](domains/README.md) and [working at scale](working-at-scale.md). Each domain card lists which of the guides below to read.

| Guide | Read when |
| --- | --- |
| [Product decisions](product-decisions.md) | Starting any task; understanding priorities, history and deferred scope |
| [Design](design.md) | Changing navigation, visual design, copy, accessibility or discovery |
| [Architecture](architecture.md) | Changing service boundaries, permissions, media access or persistence |
| [Playback and library](playback-and-library.md) | Changing queues, search, artwork, DSP, lyrics, devices or offline listening |
| [Integrations and charts](integrations-and-charts.md) | Changing providers, matching, synchronization or acquisition |
| [Workers and operations](workers-and-operations.md) | Changing deployment, worker onboarding, analysis or troubleshooting |
| [Engineering](engineering.md) | Implementing, validating, documenting or publishing a change |
| [Browser testing and mocks](browser-testing-and-mocks.md) | Running Playwright, seeding isolated demos, testing real boundaries and capturing screenshots |
| [Sleeves, shelves and assets](sleeves-and-shelves.md) | Designing virtual playlist covers, album art, discovery rails and public-safe demo assets |
| [Working at scale](working-at-scale.md) | Routing tasks to domains, decomposing large tasks, adding or splitting domains |
| [Focused mobile features](mobile-features.md) | Working on a mobile capability or coordinating shared foundation/contracts and future seams |
| [Mint mobile UX skill](../.github/skills/mint-mobile-ux/SKILL.md) | Native UI tasks: read first, then only relevant pinned Expo/native interaction references; no plugin required |
| [Ignored local memory](local-memory.md) | Explicitly initializing/reusing private domain/task evidence and handoffs; never automatic context |
| [Portable task tracking](../.github/skills/mint-task-tracking/SKILL.md) | Only when needed: existing harness todo/session SQL first, one tracker, optional ignored fallback; not Mint's music database |
| [Starter prompt](starter-prompt.md) | Starting a new chat without relying on private conversation history or frozen implementation assumptions |

## How to use this guidance

1. Run `npm run agents -- context "<request>" [paths…]` for a bounded reading/contract/validation packet, or use `route` for just the reading list. Read the cards and linked guides; the packet does not replace implementation inspection.
2. Inspect the current implementation and tests before choosing a solution.
3. Keep the current user request bounded; this handbook is not a request to implement every historical idea.
4. Preserve authorization, read-only originals, persistent playback and large-library behavior.
5. If intent and code differ, state the discrepancy and resolve it within the task rather than making an undocumented product change.
6. Keep feature-owned work narrow. `mobile` is shared foundation, not every screen; `mobile-contracts` is the DTO/native server boundary; player presentation and playback engine have separate cards. Future Events/Profiles/Jams seams are documented, not implemented features.

The latest direction is a familiar, independently implemented consumer experience led by the Expo Android/mobile app, with Home, Search and Your Library. Browse all uses real music categories and provider-scoped charts. Next.js browser listening and admin operations remain supported. Pipeline-first UI and embedded Plexamp are historical, not instructions to restore them.

Exact implementation limits below are useful regression checkpoints, not permission to duplicate constants or silently change their values. Read the owning schema/helper for authoritative values.

## Public-safe maintenance

Keep additions reusable for any self-hoster. Use generic hostnames such as `mint.example.com` and placeholders for deployment-specific settings. Never include real LAN addresses, personal paths, account identifiers, tokens, private logs, session IDs or unpublished library data.

Capture operational lessons as cause/evidence/recovery, not raw user logs. Distinguish an observed symptom from a confirmed cause and a tested fix. An unresolved incident is not a permanent product limitation.
