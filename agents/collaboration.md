# GitHub tickets and dispatcher collaboration

GitHub Issues is the shared work board. An external, single dispatcher uses
SQLite transactions to grant exclusive ownership across all declared project
domains. Issue labels, assignment, comment ordering, old `CLAIM` comments and
idle agent status are **not locks**. Mint's application database and session todo
trackers are not the shared lock authority.

## Intake and scope

1. For code changes from any chat, reuse a matching issue or create one with a
   goal, observable acceptance criteria and bounded scope. Discussion/read-only
   research does not need a new ticket. Record dependent issues and relevant
   existing PRs; capture unrelated ideas as separate tickets.
2. Read the always-read guides and run `npm run agents -- context "<request>"
   [paths...]`. Inspect the chosen cards and current implementation. Resolve
   each intended path with `npm run agents -- owner <path>`; lock **all** touched
   domains, not only the primary feature. Root `AGENTS.md` prose belongs to
   `handbook`; manifest/generated maps and this guide belong to `agent-tooling`.
3. Inspect existing issues/PRs and coordinate active sessions, shared runtimes
   and unpublished branches. GitHub and the dispatcher cannot see uncommitted
   files or local unpublished work automatically. Reconcile earlier work with
   its owner/operator before overlapping edits, even if a new claim is granted.
   Pre-existing `in-progress`-labeled issues are conservative blockers, not grants.
   Human edits and unpublished local work cannot be forcibly prevented.
4. Shared schemas, DTOs, routes and events require a dependency issue under the
   contract owner's claim before consumers depend on the change. Record landing
   order and compatibility; a broad claim does not authorize changing contracts.

## GitHub comment transport

Agents use their existing `gh` login to post explicit commands on the ticket.
They need no Discord token, secret claim API token or tunnel to the dispatcher.
The operator enables the project and command authors by immutable GitHub author
ID; repository membership or a familiar display name alone is insufficient.
Discord is an operator surface, not a credential an agent needs.

Use a unique session identifier for the actual working session; do not reuse
another agent's identifier. IDs start alphanumeric and contain only letters,
digits, underscore, dot, colon or hyphen. Keep credentials and private
infrastructure details out of issue comments. Post the command as the exact
comment body, without prose or a Markdown fence:

```text
/dispatcher claim session=<unique-id> domains=<comma-separated-domain-ids>
/dispatcher check session=<unique-id>
/dispatcher heartbeat session=<unique-id>
/dispatcher release session=<unique-id>
/dispatcher reconcile session=<unique-id>
/dispatcher status
```

For example, post a claim with `gh issue comment <ticket> --repo ChickenBone/mint
--body "/dispatcher claim session=<unique-id> domains=handbook,agent-tooling"`.
Use the real ticket, session ID and complete domain set. Read issue comments with
`gh api --paginate repos/ChickenBone/mint/issues/<ticket>/comments`; a successful
comment post proves only submission, **not a grant**.

The poller runs immediately, then waits 30 seconds after each completed cycle.
Slow cycles, downtime and errors can delay responses; this cadence is not a
timeout guarantee or permission to proceed.

### Verify the response, then check ownership

The claim reply has this exact envelope, where `<JSON>` is the response object:

```text
Dispatcher claim for comment <request-comment-id>: <JSON>
<!-- dispatcher:github:<request-comment-id> -->
```

Require the response author's immutable GitHub `user.id` to equal the
operator-configured GitHub App bot ID. Verify the exact marker against the
requesting comment's `id`, not the reply's ID. A human spoof, quoted marker,
other session's response or old response never authorizes work. The operator
must supply the trusted bot ID before agents can verify it.

The claim object must match `issue`, `session` and the complete `domains` set,
with `granted: true`, `mirror: "synced"` and `expires` (Unix milliseconds) in the
future. **A claim alone is insufficient:** post a new `check` before edits,
including each bounded editing batch and resumption. Check/heartbeat objects
include `issue`, `session`, `domains`, `expires`, `checkedAt` (Unix milliseconds),
`stale`, `owned` and `mirror`. Verify the same author/correlation/identity/domain
conditions and require `owned: true`, `stale: false`, `mirror: "synced"` and future
expiry. Use a fresh response to the new request, inspect `checkedAt`, and never
reuse a previous response as a current check. `status` is informational, not a
grant or check.

Check current ownership before edits and when resuming or changing scope.
Never edit new domains on an old narrower grant. Pending/stale claims are not
automatically stolen or released. Conflict, denied/invalid commands, timeout,
unavailable dispatcher, stale ownership or bot errors block conflicting work;
report the blocker on the issue and request deliberate owner/operator resolution.
Read-only investigation can continue without representing it as ownership.

`reconcile` only retries the GitHub label mirror; it does not renew a stale
claim or authorize edits. A stale claim cannot heartbeat or be stolen. Its
owner must deliberately release it after reviewing and preserving unfinished
or unpublished work before a new claim can be requested.

## Working and handoff

Preserve app-managed branches/worktrees. Prefer a short-lived branch/PR per
ticket, but an existing app worktree is already a feature branch: do not
automatically switch away, use raw branch renames, reset unrelated changes or
blindly rebase dirty/active shared branches. Designate one manifest/generated-sync
writer and dependency-lockfile writer. Domain claims do not confer authority over
shared deployment processes, ports or databases; coordinate their owners and use
isolated fixtures.

The lease is 15 minutes; heartbeat at least every 5 minutes while owning active
work, not after every tiny edit. Verify the correlated heartbeat response as
above; submission alone does not renew ownership. If heartbeat/check fails,
stop edits and retain blocked ownership pending deliberate recovery. Ending a
turn, waiting for input or being idle is not completion; do not release active
unfinished work merely to clear a status.

An issue handoff should state changed files/domains/contracts, branch/PR refs
when published, acceptance evidence and exact checks run, limitations,
dependency/merge order, and whether ownership remains held. Completed but
unmerged PRs can still conflict: do not treat opening a PR as safe release.
Agree an explicit owner/operator merge handoff and check dispatcher ownership
before further changes or integration. Release only after work ends or a
deliberate handoff preserves unfinished work. Verify a trusted correlated reply
with `released: true` before declaring the session's claim released.

Release does **not** declare the domains free: completed, released but unmerged
PRs still block overlapping PR domains. Other domains can proceed; unknown
ownership remains blocking. Reconcile outstanding PRs with their owner/operator,
preserve integration order and obtain a new current grant/check before further
edits or integration. Never infer an unmerged PR is abandoned or merge-safe from
an idle session, released claim or missing label.

A ticket, grant or handoff is never current-user authorization to commit, push,
open a PR, merge, publish a build/update or deploy. Those actions retain Mint's
existing authorization rules.

## Installation boundary

The operator configures the external dispatcher, trusted bot identity, enabled
project/domains and allowed authors outside Mint. Keep secrets, host addresses,
SSH keys, Discord identifiers, private logs and personal paths out of this public
repository. No Mint runtime feature or CI service is required for comment claims.
Until the operator confirms the live protocol, code work stays blocked.

The initial documentation integration in [#14](https://github.com/ChickenBone/mint/issues/14)
is a narrowly approved installation/bootstrap exception while bringing the
dispatcher online, **not a live grant**. It does not bypass claims for later
tickets, concurrent product work or subsequent edits to this guide.
