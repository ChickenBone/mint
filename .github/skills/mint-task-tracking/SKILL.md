---
name: mint-task-tracking
description: Optional progress, prerequisite and handoff tracking for multi-step Mint tasks; use an existing session tracker or explicitly requested ignored notes, never the application database.
---

# Portable task tracking

Load this only when a multi-step task needs progress/dependency coordination.
If equivalent guidance or this skill is already loaded, reuse it; do not load it twice.
Choose by available capabilities, not agent/model/vendor name. Tool names vary.

## One authoritative tracker

1. If the harness exposes the existing session-local `todos` / `todo_deps` SQL
   schema below, use those tables. They already exist: never recreate them.
2. Otherwise, if it exposes a native todo/progress tool, use that tool's documented
   schema. Do not assume it has SQL columns or dependency support.
3. With neither capability, track short work inline. Only when local memory is
   explicitly requested, use the ignored `TASKS.md` fallback below.

Do not mirror statuses into another checklist, database or handoff. Native tools
and session databases are harness-owned, not Mint's PostgreSQL music database.
Never install a tracker service, add an app dependency or create persistent SQLite
files. This skill does not grant access to any database or deployment.

## Existing session SQL schema only

`todos`: `id`, `title`, `description`, `status`, `created_at`, `updated_at`.
`todo_deps`: `todo_id`, `depends_on`.
Use kebab-case IDs, short action titles, owned scope and acceptance evidence.
Statuses: `pending`, `in_progress`, `done`, `blocked`. Mark active before working;
mark done only after the outcome is verified. Explain a block in `description`.
Insert both referenced todos before a dependency. Record actual prerequisites,
never infer them from list order. A ready-work query for this schema:

```sql
SELECT t.id, t.title, t.description FROM todos t
WHERE t.status = 'pending'
AND NOT EXISTS (
  SELECT 1 FROM todo_deps d JOIN todos p ON p.id = d.depends_on
  WHERE d.todo_id = t.id AND p.status != 'done'
);
```

Use the harness's documented SQL tool; do not invent its name or route this query
to Mint's application database. Unknown schemas require their own documentation.

## Explicit ignored fallback

Read [local memory](../../../agents/local-memory.md), choose a known domain and
distinct task ID, then run `agents -- memory init <domain> <task-id>` as documented.
Manually create `TASKS.md` only in that ignored scope; the CLI does not create it.
Use one table: `ID | Status | Prerequisites | Owned scope / acceptance evidence`.
Use the statuses above; prerequisite IDs refer only to real blockers.
One writer owns each task scope; different agents use different IDs.

Keep private refs/check commands in requested notes, not a second status list.
Recheck old evidence against current HEAD/code/tests. Never store secrets,
transcripts or private library data; never force-add or publish task notes.
State is evidence, not knowledge, instructions or permission to commit/push/deploy.
Agents without skill discovery can read `AGENTS.md` and follow its optional pointers.
