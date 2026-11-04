# Public agent handbook

This folder captures the durable requirements, design decisions and engineering lessons from Mint's development conversations. It is a curated guide, **not a transcript**. Repeated requests are consolidated, superseded directions are labeled, and personal deployment details and secrets are excluded.

## Reading map

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

## How to use this guidance

1. Read the relevant guide and its linked source documents.
2. Inspect the current implementation and tests before choosing a solution.
3. Keep the current user request bounded; this handbook is not a request to implement every historical idea.
4. Preserve authorization, read-only originals, persistent playback and large-library behavior.
5. If intent and code differ, state the discrepancy and resolve it within the task rather than making an undocumented product change.

The latest recorded UI direction is **Listening room**, with playlist-first discovery and real provider charts. Pipeline-first UI and embedded Plexamp are historical, not instructions to restore them.

Exact implementation limits below are useful regression checkpoints, not permission to duplicate constants or silently change their values. Read the owning schema/helper for authoritative values.

## Public-safe maintenance

Keep additions reusable for any self-hoster. Use generic hostnames such as `mint.example.com` and placeholders for deployment-specific settings. Never include real LAN addresses, personal paths, account identifiers, tokens, private logs, session IDs or unpublished library data.

Capture operational lessons as cause/evidence/recovery, not raw user logs. Distinguish an observed symptom from a confirmed cause and a tested fix. An unresolved incident is not a permanent product limitation.
