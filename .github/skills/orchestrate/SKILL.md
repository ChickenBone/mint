---
name: orchestrate
description: Coordinate work across multiple sessions and repositories by spawning and steering child sessions. Use for multi-repo changes, cross-repo research, stacked dependent PRs, parallel independent workstreams, or forking the current session to explore an alternative.
---

# Orchestrate — multi-session & multi-repo coordination

Use this skill to act as a **coordinator**: instead of doing every change inline,
spawn one or more child sessions, give each a complete task, and steer them with
messages until the work lands. Child sessions nest under the session that created
them (visual grouping in the sidebar) and can message back and forth, so you can
fan work out and pull results back in.

This is the right tool when a request is bigger than one branch in one repo.

**Mental model: one session ≈ one branch ≈ one PR.** Each child session owns a single,
self-contained unit of work that lands as its own pull request. Use that 1:1 framing
to scope what each session does — if a chunk of work would naturally become its own
PR, it should be its own session. This keeps each session's task crisp and each diff
reviewable, and it's why breaking a big change into a stack of dependent PRs maps
cleanly onto one session per layer.

**When the user explicitly invokes `/orchestrate`, default to delegating.** They've
opted into orchestration, so your job is to **coordinate** child sessions — spawn
them, give each a complete task, and steer them — not to quietly do all the work
inline in this one session. Doing everything inline defeats the purpose. Before
spawning, **announce your plan** (how many sessions, which repos, and what each will
do); the only reason to skip orchestration is a genuinely trivial single-repo change,
which you should call out explicitly.

## Where research happens — match the tool to the scope

Research and context-gathering come **before** the real work. Put each in the right
place:

- **Cross-repo research → a separate research session per repo.** When you need to
  investigate a different repo (e.g. "find my merged PRs in github/github-app", "what
  are the good first issues in github/app", "how does repo X implement Y"), spin up
  a research session in that repo's project to investigate and report back. One
  research session per repo it spans.
- **Single-repo research → do it inline in this session.** If the research is
  confined to the repo you're already in, just do it here directly. Don't stand up a
  child session for it, and don't coerce sub-agent (`task`) usage for something this
  session can answer itself — that's unnecessary overhead.
- **The actual work → its own branch/session.** Once research tells you which
  concrete work to do, create a user-facing child session per unit of work (the
  selected bug fix, the repo slice, the stacked-PR layer). Don't implement it inline.

The goal: keep research where the relevant code is, and reserve user-facing sessions
for the work the user actually wants landed.

## When to reach for orchestration

| Pattern | What it looks like | Shape |
|---------|--------------------|-------|
| **Multi-repo change** | A feature needs edits in repo A and repo B (e.g. an SDK change plus its consumer). | One child session per repo, coordinated. |
| **Cross-repo research** | "How does repo X do Y?" or "find my merged PRs / good issues in another repo" while you work in repo A. | A separate research session in each other repo, reporting back. |
| **Stacked / dependent PRs** | One big change would be an unreviewable diff. Split it into a stack of smaller PRs. | One session per layer, each branched off the last. |
| **Parallel fan-out** | Several independent tasks with no ordering between them. | Multiple independent sessions, then aggregate. |
| **Explore an alternative** | "What if we did this a different way?" without disturbing current work. | Fork the current session to a new worktree. |

If the task is a single change in the current repo, **don't orchestrate** — just do
it.

## Step 0 — Clarify scope before spawning anything

A `/orchestrate` invocation is often under-specified. **Do not guess and spawn a
pile of sessions.** First make sure you know:

- **Which repos / projects** are involved. Run `list_repositories` to see what's
  available, and map each requested repo to a `project_id`. If the user named a repo
  that isn't a configured project, say so.
- **What each session should do** — a concrete, self-contained task per session.
- **Dependencies / ordering** — is this a parallel fan-out, or a stack where each
  layer depends on the previous one?
- **Whether you need results back** (coordinated) or the work is fire-and-forget
  (independent).

If any of this is unclear, ask **one focused question at a time** before creating
sessions. Prefer multiple-choice when you can derive the options from
`list_repositories`.

## The toolbox

| Tool | Use it for |
|------|------------|
| `list_repositories` | Discover configured repositories, folders, and collections and their project IDs. |
| `create_session` | Spawn a child session in a project. Pass a kickoff prompt to auto-start it. |
| `open_pr_session` | Spin up a session on an existing pull request. |
| `open_issue_session` | Spin up a session to work an existing issue. |
| `fork_session` | Branch the current session into a new worktree to explore an alternative. |
| `send_session_message` | Send a message to another session. |
| `respond_to_session_plan_v2` | Approve or reject a child's pending plan. |
| `get_session` | Inspect another session's state, branch, path, PR/issue, and pending plan. |
| `list_sessions_and_chats` | Enumerate existing sessions so you can reuse one instead of spawning a duplicate. |
| `navigate_to` | Switch the UI to a session or chat. |
| `archive_session` | Archive a child under the preserve-user-work rules. |

### Important `create_session` options

- **`project_id`** — which repo/project to create a session in. Use IDs from
  `list_repositories`.
- **`kickoff.prompt`** — the task. Child sessions start fresh and cannot see this
  conversation. Write a complete, standalone prompt; quote the user's request (or
  the relevant portion when splitting work), and add only context needed to execute
  it. Don't add unrequested scope or deliverables.
- **`kickoff.mode`** — `plan`, `interactive`, or `autopilot`. Default to `autopilot`
  for well-specified execution; use `plan` when you want a proposal first.
- **`coordinate_with_creator`** — when true, the child can report back to you.
- **`remote_host_id`** — optionally place a repository child on an eligible
  user-controlled host. Omit for normal local or inherited routing.
- **`base_branch`** — set only when stacking on in-progress work.
- **`notify_on_idle`** — notifies when a turn ends, not when the task is complete.
  Prefer `once` for a single handoff.
- **`execution_location`** — `local` by default, or `cloud` for a GitHub-hosted
  remote session.

## Core workflow

1. **Map work → sessions.** Choose one session per repo, PR layer, or independent
   workstream.
2. **Resolve projects.** Run `list_repositories` and pick the project ID for each.
3. **Announce the plan.** Tell the user how many sessions you'll spawn, where, and
   what each will do.
4. **Spawn with complete kickoff prompts.**
5. **Choose coordination.** Use coordinated sessions when you need results back.
6. **Steer.** Send follow-ups, corrections, or context as needed. When waiting for a
   child's output, say you're waiting and end your turn.
7. **Aggregate.** Summarize results. Apply the preserve-user-work rules before
   archiving children.

**Never block on `sleep` or watch loops** waiting for a child session. Hand off the
work, end the turn, and resume when the idle notification arrives.

Do not infer that a quiet child is stalled from an unchanged branch or PR. Check
live activity; an idle turn does not prove that the work is complete.

## Pattern playbooks

### Multi-repo change

1. Run `list_repositories` and identify each project.
2. Create one coordinated child per repo, with a kickoff prompt describing its slice.
3. If one repo depends on another's API, do the contract work first or have the
   consumer session request the final signature.
4. Collect both results, confirm they line up, and summarize.

### Cross-repo research

Cross-repo research belongs in a research session per other repo. Single-repo
research stays inline.

1. Run `list_repositories` and find the project for each repo.
2. Create a research session for each repo and ask for a findings report.
3. Run independent research sessions in parallel.
4. Use the results to decide which concrete user-facing work sessions to create.

### Stacked / dependent PRs

1. Create the first layer normally.
2. For each later layer, set `base_branch` to the previous layer's branch.
3. Relay the user's request to open each layer's PR only if they asked for PRs or a
   stack.

### Parallel fan-out

1. Create one session per independent task.
2. Use `notify_on_idle: "once"`.
3. Coordinate and aggregate when results are needed.

### Explore an alternative

Fork the current session into a new worktree, optionally from an earlier event, and
explore there without disturbing the original.

### Approve or redirect a child's plan

When a child is in plan mode, it pauses for approval and will not act on queued
messages.

1. Spawn with `kickoff.mode: "plan"` and a notification setting.
2. Read the plan and exact `request_id` with `get_session`.
3. Approve with `respond_to_session_plan_v2` only when authorized; otherwise redirect
   it with feedback.
4. Continue steering after it resumes.

## Best practices

- Give every child enough context to work independently.
- Reuse existing sessions before spawning duplicates.
- Don't over-orchestrate; keep each session's work crisp and reviewable.
- Prefer coordination when you need a result back.
- **Preserve user work.** Archive only after verifying the child is finished, has no
  persistent work, has no open PR or ongoing work, and has no attached automation.
  If uncertain, leave it alone. Never archive to silence notifications.
- **Interpret idle narrowly.** An idle turn does not establish that work or
  automation is complete.
