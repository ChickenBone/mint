import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GATEWAY_TOKEN_HEADER_NAME, type AdminAccountListInput } from "@mint/contracts";
import { createMintSdk, MintSdkError } from "@mint/sdk";
import pg from "pg";
import { startApiRuntime } from "../src/runtime";
import { createApiServer } from "../src/server";

const exec = promisify(execFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));
const rpcError = (error: unknown) => error instanceof MintSdkError && error.code === "RPC_ERROR";

test("pending-access count authenticates before reads and sanitizes invalid storage output and failures", async (t) => {
  const gatewayToken = randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const state = {
    actor: { id: randomUUID(), email: "admin@fixture.test", name: "Admin", role: "admin" as "admin" | "user", status: "active" as "active" | "disabled" },
    expiresAt: new Date(now.getTime() + 60_000),
    sessionFailure: false, countFailure: false, count: 7, reads: 0,
    errors: [] as { name: string }[],
  };
  const app = createApiServer({
    gatewayToken, now: () => now,
    sessions: { async findByTokenHash(value) {
      if (state.sessionFailure) throw new Error("private-session-connection");
      return value === hash(token) ? { principal: state.actor, expiresAt: state.expiresAt } : null;
    } },
    decisions: {
      decidePendingAccess: async () => {},
      async countPending() {
        state.reads++;
        if (state.countFailure) throw new Error("private-count-SQL-password");
        return state.count;
      },
    },
    notifyAccessRequests: async () => {},
    errors: { error: (event) => { state.errors.push(event); } },
  });
  t.after(() => app.close());
  const query = (cookie = `mint_session=${token}`, serviceToken = gatewayToken) => app.inject({
    method: "GET", url: "/trpc/accounts.pendingAccessRequestCount",
    headers: {
      [GATEWAY_TOKEN_HEADER_NAME]: serviceToken, cookie,
      "x-user-role": "admin", "x-user-id": state.actor.id,
    },
  });
  const initial = await query();
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json(), { result: { data: 7 } });
  assert.match(initial.headers["cache-control"]!, /private, no-store/);
  assert.equal(initial.headers["set-cookie"], undefined);
  assert.equal(initial.headers["access-control-allow-origin"], undefined);
  assert.equal(state.reads, 1);
  for (const cookie of ["", "mint_session=unknown", `mint_session=${token}; mint_session=${token}`, "mint_session=mn1.native"]) {
    assert.equal((await query(cookie)).statusCode, 403);
  }
  assert.equal((await query(`mint_session=${token}`, randomBytes(32).toString("base64url"))).statusCode, 401);
  state.actor.role = "user";
  assert.equal((await query()).statusCode, 403);
  state.actor.role = "admin";
  state.actor.status = "disabled";
  assert.equal((await query()).statusCode, 403);
  state.actor.status = "active";
  state.expiresAt = now;
  assert.equal((await query()).statusCode, 403);
  state.expiresAt = new Date(now.getTime() + 60_000);
  assert.equal(state.reads, 1, "Forbidden requests must not read account totals.");
  for (const count of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    state.count = count;
    const response = await query();
    assert.equal(response.statusCode, 500);
    assert.doesNotMatch(response.body, /Zod|issues|password|SQL|stack|connection/);
  }
  state.count = 0;
  assert.deepEqual((await query()).json(), { result: { data: 0 } });
  state.countFailure = true;
  const countFailure = await query();
  assert.equal(countFailure.statusCode, 500);
  assert.doesNotMatch(countFailure.body, /private|SQL|password/);
  state.countFailure = false;
  state.sessionFailure = true;
  const sessionFailure = await query();
  assert.equal(sessionFailure.statusCode, 500);
  assert.doesNotMatch(sessionFailure.body, /private|connection/);
  assert.equal(state.errors.length, 7);
  assert.ok(state.errors.every(({ name }) => name === "Error"));
});

test("admin accounts SDK to HTTP to migrated PostgreSQL preserves bounded reads and fresh authorization", {
  timeout: 90_000,
}, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL binaries");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-admin-accounts-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "sock");
  const database = {
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
    max: 2, connectionTimeoutMillis: 2000, ssl: false as const,
  };
  const observer = new pg.Pool(database);
  const gatewayToken = randomBytes(32).toString("base64url");
  const logged: string[] = [];
  let started = false;
  let runtime: Awaited<ReturnType<typeof startApiRuntime>> | undefined;
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ]);
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-w", "start",
    ]);
    started = true;
    assert.match((await observer.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.equal((await observer.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    runtime = await startApiRuntime({
      database, migrations: { packagesRoot, lockTimeoutMs: 5000 },
      listen: { host: "127.0.0.1", port: 0 }, gatewayToken,
      notifyAccessRequests: async () => {},
      errors: { error: ({ name }) => logged.push(name) },
    });
    const url = `${runtime.address}/trpc`;
    const sdk = (sessionToken?: string) => createMintSdk({ url, gatewayToken, sessionToken });
    const account = async (label: string, role = "user", status = "active") => {
      const { rows } = await observer.query<{ id: string }>(
        `INSERT INTO accounts.users (email, name, password_hash, role, status, request_note)
         VALUES ($1, $2, 'fixture-private-password', $3, $4, $5) RETURNING id`,
        [`${label}@fixture.test`, label, role, status, status === "pending" ? "request note" : null],
      );
      return rows[0]!.id;
    };
    const session = async (id: string, expiresAt = new Date(Date.now() + 60_000)) => {
      const token = randomBytes(32).toString("base64url");
      await observer.query("INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ($1, $2, $3)",
        [hash(token), id, expiresAt]);
      return token;
    };
    const raw = (operation: "listAccounts" | "setMemberRole", input: unknown, token?: string,
      headers: Record<string, string> = {}) => {
      const list = operation === "listAccounts";
      return fetch(`${url}/accounts.${operation}${list ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}`, {
        method: list ? "GET" : "POST",
        headers: {
          [GATEWAY_TOKEN_HEADER_NAME]: gatewayToken,
          ...(token ? { cookie: `mint_session=${token}` } : {}),
          ...(!list ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(list ? {} : { body: JSON.stringify(input) }),
      });
    };
    const adminId = await account("admin", "admin");
    const adminToken = await session(adminId);
    const admin = sdk(adminToken);
    const memberId = await account("member");
    const memberToken = await session(memberId);
    const member = sdk(memberToken);
    const pendingId = await account("pending", "user", "pending");
    const inactiveToken = await session(await account("inactive-admin", "admin", "disabled"));
    const pendingToken = await session(pendingId);
    const expiredToken = await session(adminId, new Date(Date.now() - 60_000));
    const revokedToken = await session(adminId);
    await observer.query("DELETE FROM accounts.sessions WHERE id = $1", [hash(revokedToken)]);
    await observer.query(`
      INSERT INTO accounts.users (email, name, password_hash, status, request_note)
      SELECT 'fixture-' || n || '@fixture.test', 'fixture-' || n, 'fixture-private-password',
        (ARRAY['pending', 'active', 'disabled', 'denied']::accounts.user_status[])[1 + n % 4],
        CASE WHEN n % 4 = 0 THEN 'request note' ELSE NULL END
      FROM generate_series(1, 120) n
    `);

    await t.test("pending count reads real storage and fresh active-admin authorization", async () => {
      const expected = async () => Number((await observer.query(
        "SELECT count(*) FROM accounts.users WHERE status = 'pending'",
      )).rows[0].count);
      assert.equal(await admin.accounts.pendingAccessRequestCount(), await expected());
      const id = await account("count-only", "user", "pending");
      assert.equal(await admin.accounts.pendingAccessRequestCount(), await expected());
      await admin.accounts.decideAccessRequest({ userId: id, approve: false });
      assert.equal(await admin.accounts.pendingAccessRequestCount(), await expected());
      await observer.query("DELETE FROM accounts.users WHERE id=$1", [id]);
      for (const token of [undefined, memberToken, pendingToken, inactiveToken, expiredToken, revokedToken]) {
        await assert.rejects(sdk(token).accounts.pendingAccessRequestCount(), rpcError);
      }
      const count = () => fetch(`${url}/accounts.pendingAccessRequestCount`, {
        headers: {
          [GATEWAY_TOKEN_HEADER_NAME]: gatewayToken, cookie: `mint_session=${adminToken}`,
          "x-user-role": "admin", "x-user-id": adminId,
        },
      });
      await observer.query("UPDATE accounts.users SET role='user' WHERE id=$1", [adminId]);
      assert.equal((await count()).status, 403);
      await observer.query("UPDATE accounts.users SET role='admin', status='disabled' WHERE id=$1", [adminId]);
      assert.equal((await count()).status, 403);
      await observer.query("UPDATE accounts.users SET status='active' WHERE id=$1", [adminId]);
      assert.equal(await admin.accounts.pendingAccessRequestCount(), await expected());
    });

    await t.test("bounded UUID traversal, filters and cursor binding", async () => {
      const traverse = async (input: AdminAccountListInput) => {
        const all = [];
        let cursor: string | undefined;
        do {
          const page = await admin.accounts.listAccounts({ ...input, ...(cursor ? { cursor } : {}) });
          assert.ok(page.items.length <= (input.limit ?? 50));
          all.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        assert.equal(new Set(all.map((item) => item.id)).size, all.length);
        assert.deepEqual(all.map((item) => item.id), all.map((item) => item.id).sort());
        return all;
      };
      const all = await traverse({});
      assert.equal(all.length, 124);
      assert.deepEqual(Object.keys(all[0]!).sort(), ["createdAt", "email", "id", "name", "requestNote", "role", "status"]);
      assert.ok(all.every((item) => new Date(item.createdAt).toISOString() === item.createdAt));
      assert.doesNotMatch(JSON.stringify(all), /fixture-private-password|passwordHash|session|approvedBy|\/home\//);
      for (const status of ["pending", "active", "disabled", "denied", "members"] as const) {
        const filtered = await traverse({ limit: 7, status });
        const expected = all.filter((item) => status === "members"
          ? item.status === "active" || item.status === "disabled" : item.status === status);
        assert.deepEqual(filtered, expected);
      }
      const searched = await traverse({ limit: 3, search: " FIXTURE-1 " });
      assert.deepEqual(searched, all.filter((item) => item.name.includes("fixture-1")));
      assert.deepEqual(await traverse({ search: "%_" }), []);
      const page = await admin.accounts.listAccounts({ limit: 1, status: "pending", search: "fixture" });
      assert.ok(page.nextCursor);
      for (const input of [
        { cursor: page.nextCursor, status: "active", search: "fixture" },
        { cursor: page.nextCursor, status: "pending", search: "other" },
        { cursor: "e30" }, { cursor: `${page.nextCursor}A`, status: "pending", search: "fixture" },
        { limit: 101 }, { limit: 0 }, { status: "unknown" }, { search: "\0" },
        { actor: { id: adminId, role: "admin" } },
      ]) {
        assert.equal((await raw("listAccounts", input, adminToken)).status, 400);
      }
    });

    await t.test("fresh session and gateway authentication reject forged, inactive and revoked actors", async () => {
      for (const token of [undefined, memberToken, pendingToken, inactiveToken, expiredToken, revokedToken, "mn1.native"]) {
        const headers = { "x-user-id": adminId, "x-user-role": "admin", "x-forwarded-for": "127.0.0.1" };
        assert.equal((await raw("listAccounts", {}, token, headers)).status, 403);
        assert.equal((await raw("setMemberRole", { userId: memberId, role: "admin" }, token, headers)).status, 403);
      }
      for (const token of ["bad", randomBytes(32).toString("base64url")]) {
        assert.equal((await raw("listAccounts", {}, adminToken, { [GATEWAY_TOKEN_HEADER_NAME]: token })).status, 401);
      }
      assert.equal((await fetch(`${url}/accounts.listAccounts?input=%7B%7D`)).status, 401);
      await assert.rejects(member.accounts.listAccounts(), rpcError);
    });

    await t.test("role mutation preserves self, pending and missing-target semantics", async () => {
      for (const role of ["user", "admin"] as const) {
        const response = await raw("setMemberRole", { userId: adminId, role }, adminToken);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.message, "You can't change your own role.");
      }
      for (const input of [
        {}, { userId: memberId, role: "operator" }, { userId: "bad", role: "admin" },
        { userId: memberId, role: "admin", actor: { id: adminId, role: "admin" } },
      ]) assert.equal((await raw("setMemberRole", input, adminToken)).status, 400);
      const pendingBefore = (await observer.query("SELECT * FROM accounts.users WHERE id=$1", [pendingId])).rows[0];
      await admin.accounts.setMemberRole({ userId: pendingId, role: "admin" });
      const pendingAfter = (await observer.query("SELECT * FROM accounts.users WHERE id=$1", [pendingId])).rows[0];
      assert.equal(pendingAfter.role, "admin");
      assert.equal(pendingAfter.status, pendingBefore.status);
      assert.equal(pendingAfter.approved_by, pendingBefore.approved_by);
      assert.deepEqual(pendingAfter.approved_at, pendingBefore.approved_at);
      await admin.accounts.setMemberRole({ userId: randomUUID(), role: "admin" });
      const response = await raw("setMemberRole", { userId: memberId, role: "admin" }, adminToken);
      assert.deepEqual(await response.json(), { result: { data: null } });
      assert.equal((await member.accounts.listAccounts({ limit: 1 })).items.length, 1);
      await member.accounts.setMemberRole({ userId: adminId, role: "user" });
      await assert.rejects(admin.accounts.listAccounts(), rpcError);
      assert.equal((await raw("listAccounts", {}, adminToken)).status, 403);
      await member.accounts.setMemberRole({ userId: adminId, role: "admin" });
      assert.equal((await admin.accounts.session())?.id, adminId);
      await admin.accounts.setMemberStatus({ userId: memberId, status: "active" });
      const approvalId = await account("approval", "user", "pending");
      await admin.accounts.decideAccessRequest({ userId: approvalId, approve: true });
      assert.equal((await observer.query("SELECT approved_by FROM accounts.users WHERE id=$1", [approvalId])).rows[0].approved_by, adminId);
    });

    await t.test("SQL failure is sanitized, logged and recovers", async () => {
      await observer.query("ALTER TABLE accounts.users RENAME COLUMN request_note TO fixture_hidden_note");
      try {
        const response = await raw("listAccounts", {}, adminToken);
        assert.equal(response.status, 500);
        const body = await response.text();
        assert.match(body, /Internal server error/);
        assert.doesNotMatch(body, /request_note|fixture_hidden|password|SELECT|stack/);
        await assert.rejects(admin.accounts.listAccounts(), rpcError);
        assert.deepEqual(logged, ["Error", "Error"]);
      } finally {
        await observer.query("ALTER TABLE accounts.users RENAME COLUMN fixture_hidden_note TO request_note");
      }
      assert.equal((await admin.accounts.listAccounts({ limit: 1 })).items.length, 1);
    });

    const address = runtime.address;
    await runtime.stop();
    await runtime.stop();
    runtime = undefined;
    await assert.rejects(fetch(`${address}/trpc/accounts.session`));
    assert.equal(Number((await observer.query(
      "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'mint-api-runtime'",
    )).rows[0].count), 0);
  } finally {
    try {
      await runtime?.stop();
    } finally {
      await observer.end();
      if (started) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
      await rm(cluster, { recursive: true, force: true });
    }
  }
});

test("absent account service fails explicitly after authorization", async () => {
  const gatewayToken = randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const app = createApiServer({
    gatewayToken,
    sessions: { findByTokenHash: async () => ({
      expiresAt: new Date(Date.now() + 60_000),
      principal: { id: randomUUID(), email: "admin@fixture.test", name: "admin", role: "admin", status: "active" },
    }) },
    decisions: { decidePendingAccess: async () => {}, countPending: async () => 0 },
    notifyAccessRequests: async () => {},
    errors: { error: () => assert.fail("unavailable service is not an internal error") },
  });
  try {
    const headers = { [GATEWAY_TOKEN_HEADER_NAME]: gatewayToken, cookie: `mint_session=${token}` };
    for (const request of [
      { method: "GET" as const, url: "/trpc/accounts.listAccounts?input=%7B%7D" },
      { method: "POST" as const, url: "/trpc/accounts.setMemberRole", payload: { userId: randomUUID(), role: "user" } },
    ]) {
      assert.equal((await app.inject({ ...request, headers })).statusCode, 503);
    }
  } finally {
    await app.close();
  }
});
