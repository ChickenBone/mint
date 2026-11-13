import { and, asc, eq, gt, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { adminAccountListInputSchema } from "@mint/contracts";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AccountAuthenticationRepository } from "./authenticate-account";
import type { AdminBootstrapRepository } from "./bootstrap-admin";
import type { AccessRequestDecisionRepository, PendingAccessDecision } from "./decide-access-request";
import type { AccountAccessRequestRepository } from "./request-account-access";
import { sessions, users } from "./schema";
import type { SessionLifecycleRepository } from "./session-lifecycle";
import type { SessionLookupRepository } from "./session-lookup";
import type { MemberStatusInput, MemberStatusRepository } from "./member-status";
import { AdminAccountsInputError, type AdminAccountsRepository } from "./admin-accounts";

export interface AccountsRepository extends
  SessionLookupRepository,
  SessionLifecycleRepository,
  AccountAuthenticationRepository,
  AdminBootstrapRepository,
  AccountAccessRequestRepository,
  AccessRequestDecisionRepository,
  MemberStatusRepository,
  AdminAccountsRepository {}

const principalFields = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  status: users.status,
};

export function createAccountsRepository(
  db: NodePgDatabase<{ users: typeof users; sessions: typeof sessions }>,
): AccountsRepository {
  return {
    async findByTokenHash(tokenHash) {
      const [session] = await db.select({
        expiresAt: sessions.expiresAt,
        principal: principalFields,
      }).from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.id, tokenHash))
        .limit(1);
      return session ?? null;
    },
    async insertSession(session) {
      await db.insert(sessions).values(session);
    },
    async deleteByTokenHash(tokenHash) {
      await db.delete(sessions).where(eq(sessions.id, tokenHash));
    },
    async findByLowercaseEmail(email) {
      const [account] = await db.select({
        ...principalFields,
        passwordHash: users.passwordHash,
      }).from(users)
        .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
        .limit(1);
      return account ?? null;
    },
    async insertAdminIfAbsent(account) {
      // Drizzle's insert conflict target accepts columns, not this expression index.
      const inserted = await db.execute<{ id: string }>(sql`
        INSERT INTO ${users} (email, name, password_hash, role, status, approved_at)
        VALUES (${account.email}, ${account.name}, ${account.passwordHash},
          ${account.role}, ${account.status}, ${account.approvedAt})
        ON CONFLICT (lower(email)) DO NOTHING
        RETURNING id
      `);
      return inserted.rows.length === 1;
    },
    async insertPendingIfAbsent(account) {
      // The email expression index is the only conflict this operation may ignore.
      const inserted = await db.execute<{ id: string }>(sql`
        INSERT INTO ${users} (name, email, password_hash, request_note, role, status)
        VALUES (${account.name}, ${account.email}, ${account.passwordHash}, ${account.requestNote},
          'user', 'pending')
        ON CONFLICT (lower(email)) DO NOTHING
        RETURNING id
      `);
      return inserted.rows.length === 1;
    },
    async countPending() {
      return db.$count(users, eq(users.status, "pending"));
    },
    async listAccounts(input) {
      const parsed = adminAccountListInputSchema.safeParse(input);
      if (!parsed.success) throw new AdminAccountsInputError();
      const { limit = 50, cursor, status } = parsed.data;
      const search = (parsed.data.search ?? "").trim().toLowerCase();
      const filter = status ?? null;
      let after: string | undefined;
      if (cursor !== undefined) {
        let value: unknown;
        try {
          value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        } catch {
          throw new AdminAccountsInputError();
        }
        if (typeof value !== "object" || value === null
          || !("after" in value) || typeof value.after !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.after)
          || JSON.stringify(value) !== JSON.stringify({ v: 1, after: value.after, status: filter, search })
          || Buffer.from(JSON.stringify(value)).toString("base64url") !== cursor) {
          throw new AdminAccountsInputError();
        }
        after = value.after;
      }
      const escapedSearch = search.replace(/[\\%_]/g, "\\$&");
      const rows = await db.select({
        ...principalFields, requestNote: users.requestNote, createdAt: users.createdAt,
      }).from(users).where(and(
        after ? gt(users.id, after) : undefined,
        status === "members" ? inArray(users.status, ["active", "disabled"])
          : status ? eq(users.status, status) : undefined,
        search ? or(ilike(users.name, `%${escapedSearch}%`), ilike(users.email, `%${escapedSearch}%`)) : undefined,
      )).orderBy(asc(users.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
        nextCursor: rows.length > limit && last
          ? Buffer.from(JSON.stringify({ v: 1, after: last.id, status: filter, search })).toString("base64url")
          : null,
      };
    },
    async setMemberRole({ userId, role }) {
      await db.update(users).set({ role }).where(eq(users.id, userId));
    },
    async decidePendingAccess({ userId, decision }) {
      if (decision.status === "active") {
        await db.update(users)
          .set({
            status: "active",
            approvedAt: decision.approvedAt,
            approvedBy: decision.approvedBy,
          })
          .where(and(eq(users.id, userId), eq(users.status, "pending")));
      } else {
        await db.update(users)
          .set({ status: "denied" })
          .where(and(eq(users.id, userId), eq(users.status, "pending")));
      }
    },
    async setMemberStatus({ userId, status }: MemberStatusInput) {
      await db.transaction(async (tx) => {
        const [updated] = await tx.update(users)
          .set({ status })
          .where(and(eq(users.id, userId), ne(users.status, "pending")))
          .returning({ id: users.id });
        if (updated && status === "disabled") {
          await tx.delete(sessions).where(eq(sessions.userId, updated.id));
        }
      });
    },
  };
}
