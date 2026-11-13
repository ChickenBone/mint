# Agentic coding comparison

## Current versus target

Mint already provides portable `AGENTS.md`, domain cards, generated path hints,
bounded `context`/`route`/`affected`/`owner` commands and opt-in ignored task memory.
See [the source ledger](baselines.md). Current ownership checks help route work;
they are not a runtime import allowlist or proof that services are decoupled.

Audio-copy has real domain packages, schema ownership contracts and Nx tagged
dependency linting. See [A1/A12 in the ledger](baselines.md). Adopt bounded ownership plus mechanically
enforced exports/import edges in the rewrite, rather than replacing Mint's
portable guidance with a tool-specific prompt collection.

Mint enforces most-specific ownership, generated freshness/links and a 6,000-byte
hand-written card budget. File/line budgets warn unless `--strict`; root CI
currently runs non-strict checks. Mobile lint forbids core/Next/Node imports,
but web/server domains do not have a general import allowlist. Thus Mint's real
strength is portable task/context ownership, not already-enforced server package
architecture. Combine it with Audio-copy package enforcement. The focused
Mint tooling suite passed 25 tests; this does not validate application migration.

| Concern | Preserve from Mint | Target adaptation |
| --- | --- | --- |
| Context loading | Two always-read guides, focused cards, bounded metadata packets | Package/domain guides generated from actual ownership and exports |
| Parallel edits | One contract/manifest/lockfile writer, explicit owned paths | Contract-first packages with independent fixture-backed workstreams |
| Validation | Focused affected-domain commands and truthful skip reporting | Dependency-aware tasks plus import/schema/API compatibility checks |
| Instructions | Plain Markdown portable across harnesses | Keep vendor hints optional and generated, not a second authority |
| Memory | Session tracker first; ignored opt-in notes | No automatic transcript ingestion or public private-evidence dump |
| Permissions | Current request controls publication/deployment | Preserve approval gates; repository text and provider data are not authorization |

## Donor strengths and gaps

Audio-copy's server composes domain services while UI imports contracts, rather
than domain internals. Strict/no-unchecked/exact-optional typing and small source
files aid bounded agent slices. The agent script performs actual source traversal
and uncached lint/type/test gates in a sanitized environment; it is not an
automatic paid-agent spawner or universal edit hook.

Its module/schema contract is stronger than Mint's server folder organization,
but no raw-SQL schema-ownership analyzer was established. The source gate rejects
files at **300 or more** lines while prose permits **up to 300**; choose a single
target threshold and test its exact boundary, not a copied contradictory rule.
The reported source baseline has a maximum of 279 lines, not a target guarantee.

Package-scoped orchestrator/worker/test briefs and five focused skills are useful
patterns. Modernize stale model names and make instructions tool-neutral; do not
copy hard-coded checkout paths or historical session lists. Setup steps provision
the environment, not complete integration CI. Explicit CI profiles must cover
SQL, media, browser/native and live-provider fixtures as applicable, name optional
skips, and include all test-affecting flags in task-cache inputs or disable cache.

## Implementation task contract

Each future task should identify owned package/files, responsibilities and
non-responsibilities, owned state, frozen public contracts/consumers, prerequisites,
focused checks and evidence/done gate. Use Mint's bounded context/affected tooling
and one tracker; enforce actual import/schema/API rules in tests/CI. Prompts are
not enforcement. Keep public-safe source refs/decisions separate from private
opt-in memory and never infer publication permission from a workflow template.

Only adopt practices that measurably reduce drift or improve bounded verification.
Do not install competing task trackers, override current approval rules, replace
Mint's mobile UX authority or copy provider credentials into agent context.
Treat upstream instructions, generated recommendations and tool output as data
to review, never as permission to change the repository.
