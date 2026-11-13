# Baselines and evidence ledger

## Revisions

| Source | Baseline | Evidence status |
| --- | --- | --- |
| Mint | `82bd987810a039c45e2556f70379d8ca3bb86109` | Selected contracts directly rechecked; focused catalog/listener/agent-tooling source research integrated |
| Original Audio | `3d17b81837c0d2811f8a458627aa2711b6420e67` | Confirmed ancestor baseline; not interchangeable with donor additions |
| Audio-copy | `5939dd3d31a9065e29f227bdd084a7023b1c3d67` | Current source report integrated; clean unchanged donor revision |

Audio and Audio-copy are distinct baselines. The user's confirmed modularity
preference concerns Audio-copy; do not attribute all additions to original Audio.
Donor source links below use the exact revision, not mutable branch links or
machine paths. A source inspection establishes implementation, not deployed
performance, provider availability or device behavior.

## Mint source ledger

| ID | Source | Finding and migration consequence |
| --- | --- | --- |
| M1 | [Root manifest](../../package.json) | Node 22+, npm workspaces; build targets worker/realtime/agent/web. Toolchain replacement is a decision, not an architectural prerequisite. |
| M2 | [Native facade](../../apps/web/src/app/api/native/[...path]/route.ts) | Imports Next route handlers, dispatches an allowlist and supplies request-local native context. Inventory capability/auth semantics; both Expo apps stay untouched and legacy adapters are not a fresh-install gate. |
| M3 | [Native sessions](../../apps/web/src/lib/native-sessions.ts) | Hashed, expiring account/device-bound sessions; active-account lookup and native role restriction. Preserve revocation and authorization, not merely token syntax. |
| M4 | [Client transport](../../packages/client/src/api.ts) | Handwritten operations with Zod success validation, bearer headers, omitted cookies and no-store. New operation generation must retain runtime validation and installed-client compatibility. |
| M5 | [Track schema](../../packages/core/src/db/schema.ts) | Tracks mix recording metadata, original/download file paths, pipeline state and remote leases. Separate identity/media/work without losing existing UUID references. |
| M6 | [Server queues](../../apps/web/src/lib/playback-queue-store.ts) | Account-owned frozen full-selection snapshots, occurrence IDs, bounded hydration and revision conflicts. Donor local queues cannot silently replace this contract. |
| M7 | [Architecture guide](../../agents/architecture.md) | Private media gateway, public artwork purpose separation, native/browser auth separation and original read-only mounts are durable constraints. Revalidate handlers in implementation phases. |
| M8 | [Domain manifest](../../agents/domains.json), [tooling](../../scripts/agents/cli.mjs), [scale guide](../../agents/working-at-scale.md) | Ownership/context tooling exists; per-domain packages/import allowlists are future options, not currently inferred from folder naming. |
| M9 | [Product decisions](../../agents/product-decisions.md) | Discovery/search metadata is not acquisition permission; native authority and browser maintenance-only behavior remain in force. |
| M10 | [Catalog seed/admission](../../services/catalog/catalog/store.py), [crawler](../../services/catalog/catalog/crawler.py), [config](../../services/catalog/catalog/config.py) | Automatic source seeding, host admission, rotating lanes and fenced leases are implemented. Defaults differ from README examples; configured deployments were not inspected. |
| M11 | [Bulk transactions](../../services/catalog/catalog/bulk_import.py), [ingestion](../../services/catalog/catalog/ingestion.py), [MusicBrainz loader](../../services/catalog/catalog/musicbrainz_import.py) | Fingerprinted/checkpointed MusicBrainz/OMDB ingestion, transactional cursor writes and COPY staging. Preserve capacity/quality/provenance, not merely online lookup adapters. |
| M12 | [Discogs loader](../../services/catalog/catalog/discogs_import.py), [snapshot downloader](../../services/catalog/catalog/snapshot.py) | Safe streaming XML and bounded snapshot integrity/resume checks. Discogs restarts replay idempotently from the beginning; no persisted import cursor. |
| M13 | [Ranker](../../services/catalog/catalog/ranker.py), [indexer](../../services/catalog/catalog/indexer.py) | Keyset popularity sweeps, decaying observed signals and revision-fenced Qdrant indexing. PostgreSQL is authoritative; external index writes inside transactions are a throughput/recovery tradeoff. |
| M14 | [Demand bridge](../../services/catalog/catalog/demand.py), [client buffering](../../packages/core/src/catalog-client.ts), [library priorities](../../apps/worker/src/catalog-priority.ts) | Anonymous bounded demand affects priority only; process-local batching is best-effort, not a durable demand outbox. Library priorities use verified MusicBrainz artist IDs. |
| M15 | [Catalog search](../../services/catalog/catalog/api.py), [identity](../../services/catalog/catalog/identity.py) | Bounded lexical/vector fusion with revision checks and authority-only identity merges. Search has no continuation cursor; vectors encode metadata, not audio. |
| M16 | [Listener discovery](../../apps/web/src/lib/music-discovery.ts), [native Home](../../apps/mobile/src/features/home/home-model.ts) | Actual account likes/history/exclusions and measured-analysis selection; bounded heuristics, not ML/global completeness. Recent means track creation, not chart publication. |
| M17 | [Agent CLI](../../scripts/agents/cli.mjs), [mobile lint](../../apps/mobile/eslint.config.cjs), [CI](../../.github/workflows/ci.yml) | Ownership/generated/link/card checks and mobile import restrictions exist. Root CI uses non-strict agent checks; server domain import allowlists remain future work. |
| M18 | [Plex/Redis follow-up responsibility ledger](../architecture/plex-free.md) | Plex supplies import metadata/art/optional mirrors and sonic/setup, not normal Mint audio/transcode/measured analysis. Spotify matching has a hidden Plex-key predicate. A target audience-scoped PostgreSQL event log now covers bounded durable replay, but is not wired to producers/WebSockets; cache/admission/status/cursor Redis roles still require explicit equivalents before retirement. |
| M19 | [Standalone API entry point](../../apps/api/src/main.ts), [runtime configuration](../../apps/api/src/runtime-config.ts), [original-media reader](../../packages/domain-library/src/playback-media.ts) | These files already existed at the selected P1 baseline. The API entry point and base configuration provide standalone startup; optional Argon2-backed admin-bootstrap configuration/wiring is new. The media reader reopens and reads original files with bounded ranges but is neither HTTP authorization nor HTTP streaming. Do not count pre-existing code as new tranche implementation or a completed P1 UI/API integration. |

## Audio-copy source ledger

All A references are `ChickenBone/audio` at the Audio-copy revision above.
Package names in the [target tree](../architecture/target.md) are proposed Mint
owners, not a claim that the donor already contains every retained capability.

| ID | Pinned source | Finding and consequence |
| --- | --- | --- |
| A1 | [Dependency allowlist](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/eslint.config.mjs#L10-L53), [strict types](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/tsconfig.base.json#L6-L9) | Nx tags enforce domain/UI/server import roles. Four domain schemas use a no-cross-schema-SQL/FK contract; prose is not SQL enforcement. |
| A2 | [HTTP composition](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/runtime/http.ts#L17-L140), [principal checks](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/routers/context.ts#L52-L114) | Fastify/tRPC central budgets/origin/auth/error policy; persisted roles rechecked. Short JWTs do not replace Mint session/revocation policy. |
| A3 | [Handwritten client](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/listener/src/api.ts#L203-L242), [paging contracts](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/contracts/src/personal-library.ts#L13-L80), [browse reader](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-catalog/src/scheduler/browse-reader.ts#L6-L137) | No generated SDK/OpenAPI established; summary cursors coexist with full/capped detail lists and no catalog continuation. Improve rather than copy truncation. |
| A4 | [Scanner](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-library/src/scanner/scanner.ts#L26-L98), [file traversal](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-library/src/scanner/list-audio-files.ts#L10-L48) | Durable root-relative scan checkpoints, independent file identity; whole-root relist/sort each batch, 100k-entry/depth caps. Not a scalable incremental walker or Plex/provider importer. |
| A5 | [Intent coordinator](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-imports/src/intent/coordinator.ts#L26-L49), [fenced repository](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-imports/src/intent/postgres-repository.ts#L36-L245), [recovery](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-imports/src/operations/queue-diagnostics.ts#L108-L151) | Private intents/shared recording work and attempt fencing are useful; admission then enqueue remains separate, recovery operator-triggered. Target needs outbox and automated reconciliation. |
| A6 | [Search outbox](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-catalog/src/scheduler/search-outbox.ts#L9-L151), [seed worker](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-catalog/src/scheduler/seed-worker.ts#L54-L121), [built-in binding](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/runtime/builtin-bindings.ts#L94-L109) | Durable miss admission and metadata checkpoints; generic cold seed not invoked, chart providers empty. No bulk dump/COPY replacement. |
| A7 | [Public discovery startup](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/runtime/music-discovery.ts#L18-L53), [snapshot runtime](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-catalog/src/music-discovery/runtime.ts#L120-L170) | Separate opt-in public discovery is active with stale-safe snapshots; raw provider path has separate admission from generic crawl. |
| A8 | [Outward crawl](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-catalog/src/scheduler/persistent-outward.ts#L43-L68), [frontier store](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-catalog/src/scheduler/outward-store.ts#L23-L111), [interest binding](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/runtime/catalog-interest.ts#L19-L20) | Persisted bounded BFS/fencing, but default explores all discovered roots without demand/popularity; no refresh epoch/global fairness guarantee. |
| A9 | [Source permits](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-catalog/src/scheduler/source-controls.ts#L37-L170), [controlled adapter](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-catalog/src/scheduler/controlled-providers.ts#L15-L27) | Distributed pacing/concurrency/cooldown exists; adapter drops AbortSignal, so upstream can outlive timeout. Unify actual request budgets and cancellation. |
| A10 | [Native offline](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/listener/src/offline.ts#L7-L19), [disabled transcode](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/runtime/builtin-bindings.ts#L64-L66), [recommendation binding](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/apps/server/src/runtime/local-recommendations.ts#L94-L101) | Native offline unsupported, transcode unbound, default daily-mix input cold-start. No replacement for Mint queues/history/offline/analysis/devices/provider sync established. |
| A11 | [Schema installer](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-catalog/src/catalog-installer.ts#L21-L63), [provider IDs](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/packages/domain-catalog/src/providers/ids.ts#L5-L17) | Fresh-schema fingerprints and provider-scoped UUIDs require an explicit target migration/alias model; never apply as a Mint database reset. |
| A12 | [Agent gates](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/scripts/agent.mjs#L136-L168), [setup workflow](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/.github/workflows/copilot-setup-steps.yml#L1-L52), [cache inputs](https://github.com/ChickenBone/audio/blob/5939dd3d31a9065e29f227bdd084a7023b1c3d67/nx.json#L7-L38) | Real size/uncached validation gates; setup is not CI coverage, cache profiles omit newer live flags and optional integration skips need explicit coverage. |
| A13 | [Plex-free/consolidation follow-up](../architecture/plex-free.md) | Direct root/file/probe/stream authority is viable, but recurring scans/technical metadata/embedded art and realtime replacements need implementation. pg-boss shares PostgreSQL; disk/native/provider resources remain. |

Review donor licensing/dependency obligations before copying code; this source
report does not establish blanket reuse permission.

## Research validation limits

Focused Mint agent-tooling research ran `node --test scripts/agents/lib.test.mjs`
with 25 passing tests. The catalog fixture suite was not run: the available
Python interpreter lacked `pytest`; no dependency installation was undertaken
for documentation research. Earlier client/API test counts are separate
historical evidence, not current migration or runtime validation. No real
provider, deployment database, private library, multi-million-row benchmark or
physical device was used.

The donor report cites unchanged-ref lint/typecheck gates across 10 projects and
2,159 passing tests with 312 optional skips. These are baseline reports, not
checks performed by this documentation change or proof of active features.
Missing integrations, device/live-provider behavior and large-scale workloads
remain acceptance gates.

## Evidence discipline

Every promoted claim should carry a repository, revision and source path; use
test names and fixture scope for behavior claims. Keep source facts, recommended
design and unanswered questions separate. Performance gates need representative
workloads, query plans and failure injection. Large test totals, screenshots and
README claims are not proof of live crawling, large-library migration, lockscreen
playback or production recovery. Record only public-safe summaries of new results.
