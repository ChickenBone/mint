# Working at scale: domains for agent sessions

Mint is too large for one agent session to hold. The repository is divided into **domains**: bounded contexts with owned files, a short card, focused validation and explicit contracts with neighbors. Human prompts do not change. The root [AGENTS.md](../AGENTS.md) tells every agent to route, load only relevant cards and decompose cross-domain work.

## How the pieces fit

| Layer | File | Loaded |
| --- | --- | --- |
| Router | [`AGENTS.md`](../AGENTS.md) | Always, by every agent that reads AGENTS.md. Contains the protocol and the generated domain table. |
| Manifest | [`agents/domains.json`](domains.json) | Source of truth: ids, summaries, keywords, owned path globs, guides, extra validation, budgets. |
| Domain cards | [`agents/domains/<id>.md`](domains/README.md) | On demand after routing. Hand-written boundaries/invariants above the marker; generated map below it. |
| Path instructions | `.github/instructions/<id>.instructions.md` | Automatically by Copilot surfaces that support `applyTo`, when a domain's files are in play. Each points to its card. |
| Topic guides | `agents/*.md` | Only the guides a chosen card lists. |
| Tooling | [`scripts/agents/`](../scripts/agents/cli.mjs) | `npm run agents -- <context\|route\|affected\|map\|owner>`, `agents:sync`, `agents:check`. Dependency-free Node. |

Generated content (card maps, [domain index](domains/README.md), the AGENTS.md table and path instructions) is deterministic and committed so it works on every surface, including GitHub's web UI. Volatile detail such as line counts and exports is computed live by `npm run agents -- map <id>` instead of committed.

## Ownership rules

- Every tracked file, other than the manifest's `ignore` list, has exactly one owning domain. `agents:check` fails on unowned or ambiguous files and on patterns that match nothing.
- The most specific matching pattern wins. An exact path beats any glob; otherwise the pattern with more literal characters wins. A tie between domains is an error, not a silent choice.
- Broad fallbacks such as `apps/web/**` (`web-shell`) are allowed; more specific patterns carve feature files out of them.
- Domains are vertical slices. A feature's web UI, API routes, worker jobs and its `packages/core` schema/DB files belong together, so one session sees the whole feature. Truly shared plumbing belongs to `platform`.

## Budgets and when to split

`budgets` in the manifest keeps each domain session-sized:

| Budget | Meaning | On breach |
| --- | --- | --- |
| `cardBytes` | Hand-written card section size | Error. Move detail to a topic guide and link it. |
| `domainFiles` / `domainLines` | Owned text files and their lines; binary assets are excluded | Warning, or an error with `--strict`. Split the domain. |

To split a domain:

1. Run `npm run agents -- map <id>` and find a seam with few import edges across it, usually one user-facing capability and its worker/core support.
2. Add the new domain to `domains.json` with its own summary, keywords, guides and specific path patterns; narrow the old patterns.
3. Run `npm run agents:sync`. It creates a skeleton card and path instructions. Replace each `TODO` with real boundaries and invariants, moving relevant lines from the old card.
4. Run `npm run agents:check` and review the regenerated *Imports from/Imported by* lists to confirm the seam.

Add a domain the same way for a new app, package or major feature. New files inside an existing domain usually need only `npm run agents:sync`.

## Writing a good card

The hand-written part is the highest-value context an agent receives, so keep it short and specific:

- **Boundaries:** what the domain owns, and what it must never do or reach into.
- **Invariants:** behavior that must survive any change. Link the topic guide for rationale instead of copying it.
- **Contracts:** exports, routes, events or tables that other domains rely on.
- **Entry points and gotchas:** where to start reading, plus non-obvious traps.

Do not duplicate implementation constants. Point to the owning file. Never include deployment-specific details, credentials or private data.

## Optimization notes

- Routing reads the manifest, a few kilobytes, instead of the whole handbook. Agents load two always-read guides, one to three cards and their listed guides.
- `affected` maps changed files to focused test files and workspace scripts, so validation scales with the change rather than the repository. Shared-package changes still typecheck every consumer.
- The generated dependency lists show the blast radius before an agent edits a contract.
- `--json` output on `context`, `route`, `affected` and `owner` lets orchestration tooling consume routing without parsing prose.

## Portable context packets

From a checkout with Node.js 22+, before installing dependencies:

```bash
node scripts/agents/cli.mjs context "improve native search" apps/mobile/src/screens/SearchScreen.tsx
npm run agents -- context "improve native search" apps/mobile/src/screens/SearchScreen.tsx --json
npm run agents -- route "improve native search"
npm run agents -- owner apps/mobile/src/screens/SearchScreen.tsx
npm run agents -- map mobile
npm run agents -- affected
```

`context` reuses the router and manifest, listing always-read guidance, chosen cards/guides, up to twelve outgoing contract edges per domain, incoming/outgoing domain relationships, suggested validation and a count/domain-only working-tree summary. Keyword suggestions are capped at four; explicit path owners are retained even for larger cross-domain requests. New domains need no command changes.

It emits metadata, not file bodies, environment values, commit authors or a whole-code prompt. Ignored/private paths, local data/build/session directories, credentials, logs and symlinks are excluded. Never paste private URLs or secrets into the request itself; the filter is not a secret scanner. Read the indicated contracts and tests directly, and split overly broad requests rather than increasing the dump size. Commands are suggestions, not executed checks.

Use the [starter prompt](starter-prompt.md) for new conversations. Keep evidence and handoffs in the session workspace; promote only public-safe durable requirements into cards. When several agents share a checkout, assign non-overlapping files and one writer for the manifest/generated sync and dependency lockfile; review the combined state before authorized publication.

## Future options

These options are not implemented. Adopt them when growth justifies the change:

- **Feature folders:** co-locate domain files under paths such as `apps/web/src/features/<domain>/`, so globs become one line per domain and nested `AGENTS.md` files become natural. This is a large mechanical refactor; do it one domain at a time.
- **Per-domain packages:** extract stable contracts into `packages/<domain>` with explicit `exports`. TypeScript then enforces boundaries that are currently documented.
- **Boundary linting:** turn the import graph into an allowlist, such as "`devices` may import `playback` contracts only", and fail CI on new edges.
- **Generated CODEOWNERS:** emit `.github/CODEOWNERS` from the manifest if the project gains maintainers per area.
- **Session handoff template:** standardize a short handoff note format in the agent session workspace for tasks that span multiple sessions.
