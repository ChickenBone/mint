# Accounts (`accounts`)

## Boundaries and invariants

- Owns `@mint/domain-accounts`, a server-side target domain for account and session policy. It depends on public contracts, Node built-ins and public Drizzle exports, not legacy core, apps or another domain's private files.
- Browser session lookup, issuance/revocation, authentication policy, Drizzle repository and fresh accounts schema are implemented behind explicit ports. `argon2Passwords` binds `@node-rs/argon2` to the existing hash/verify port for authentication, access requests and initial-admin bootstrap. `bootstrapAdmin` is wired only through the API's explicit all-or-none bootstrap environment variables; it runs after migrations and before listen, atomically creates an active admin when the case-insensitive email is absent, and never modifies an existing account. This is provisioning, not a login or access-request HTTP flow.
- Access-request policy uses input validation and injected IP admission, password hashing and notification ports. Existing emails receive the same success response; inserts stay pending and case-insensitive concurrent duplicates are conflict-safe. API `accounts.signIn`/`requestAccess` compose these services only with explicitly configured authenticated-gateway IP evidence. Successful sign-in issues a hashed, 30-day persisted session for the authenticated principal, never an input user ID; `signOut` revokes the presented token.
- `createAccessRequestDecider` requires an active admin supplied by trusted fresh persisted-session composition; an actor DTO is not authentication and must never be browser-controlled HTTP input. It conditionally changes pending accounts, preserves approval fields on denial, and counts and notifies even for no-op updates. API and same-origin Next.js approval bindings exist; the existing admin UI is not migrated.
- `createMemberStatusUpdater` requires the same trusted active-admin principal, rejects self-status changes, and delegates non-pending status changes to a PostgreSQL transaction that preserves approval fields and atomically revokes all sessions when disabling. API and same-origin Next.js bindings are accepted; the existing admin UI is not migrated.
- `createAdminAccountsService` lists safe account fields in bounded UUID-cursor pages and changes roles only for a trusted active admin resolved from a fresh persisted session. Self-role changes reject either role with the existing error copy; pending accounts can change role and missing targets are no-ops. The API and SDK expose these operations; the existing admin UI is not migrated.
- The API and SDK also expose the pending access-request count only to a freshly resolved active admin. Repository failures and invalid output fail explicitly rather than returning a fabricated zero.
- Lookup hashes opaque browser tokens, excludes native bearer tokens, admits only active accounts with strictly unexpired sessions, projects the public principal and propagates repository failures. Do not cache authorization or expose session evidence.
- The target schema is fresh, not a legacy migration. Any future data migration must preserve account/session fields, approval rules, password hashing and session lifetimes.

## Contract

Consumers use the public `@mint/domain-accounts` root export for services, the Argon2 binding, repository/bootstrap ports and schema tables. The package exposes Drizzle-backed repository operations but does not choose a database pool or web framework.

<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->

## Generated map

- **Scope:** Target account policy, browser sessions, Argon2 binding, optional initial-admin bootstrap and fresh account schema.
- **Read before editing:** [agents/architecture.md](../architecture.md).
- **Imports from:** [`mobile-contracts`](mobile-contracts.md), [`platform`](platform.md)
- **Imported by:** [`platform`](platform.md), [`playback`](playback.md)
- **Live detail:** `npm run agents -- map accounts` (exports, line counts, cross-domain import edges).

### Owned files (24)

- `packages/domain-accounts/` `package.json`, `tsconfig.json`
- `packages/domain-accounts/migrations/` `0000_accounts.sql`
- `packages/domain-accounts/src/` `admin-accounts.ts`, `argon2-passwords.ts`, `authenticate-account.ts`, `bootstrap-admin.ts`, `decide-access-request.ts`, `index.ts`, `member-status.ts`, `repository.ts`, `request-account-access.ts`, `schema.ts`, `session-lifecycle.ts`, `session-lookup.ts`
- `packages/domain-accounts/tests/` `argon2-passwords.test.ts`, `authenticate-account.test.ts`, `bootstrap-admin.test.ts`, `decide-access-request.test.ts`, `repository.test.ts`, `request-account-access.test.ts`, `schema.test.ts`, `session-lifecycle.test.ts`, `session-lookup.test.ts`

### Validate

Owned tests: 9.

```bash
corepack pnpm --filter @mint/domain-accounts run typecheck
corepack pnpm --filter @mint/domain-accounts exec tsx --test tests/argon2-passwords.test.ts tests/authenticate-account.test.ts tests/bootstrap-admin.test.ts tests/decide-access-request.test.ts tests/repository.test.ts tests/request-account-access.test.ts tests/schema.test.ts tests/session-lifecycle.test.ts tests/session-lookup.test.ts
corepack pnpm --filter @mint/domain-accounts test
```

> Changing owned `packages/*` files affects every consumer: run root `npm run typecheck` (`npm run agents -- affected` does this automatically).

<!-- agents:generated:end -->
