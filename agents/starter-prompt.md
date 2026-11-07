# Portable starter prompt

Paste this before a future request. It intentionally reads current repository
contracts instead of freezing a release, model, tool vendor or private deployment.

> Use the current checkout, not assumed chat history. Read AGENTS.md and always-read guides; route with context tooling and relevant cards. Preserve listening, backend/admin capabilities, playback continuity, account isolation and media security. Inspect contracts/tests. Honor delegation preferences: subagents-only means delegated implementation and coordinator review. Make focused changes, update durable docs/maps and validate narrowly; escalate shared-contract checks. Report evidence and limits. Protect private deployment details, secrets and session artifacts. Commit, push or deploy only with explicit current authorization.

## Optional task suffix

```text
Request: <desired outcome>
Scope: <paths or capabilities, if known>
Delegation: <direct / focused subagents / subagents-only implementation>
Delivery: <review only / explicitly authorized commit and push>
Acceptance: <observable outcome and required verification>
```

Deployment authorization is separate from Git publication. A passing test, APK
build, export or workflow is not proof that a running backend or physical device
has received and verified the change. Do not attach private logs or filled
configuration to a public handoff.
