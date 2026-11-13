import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GATEWAY_TOKEN_HEADER_NAME, type AccountRole, type AccountStatus } from "@mint/contracts";
import { createMintSdk, MintSdkError } from "@mint/sdk";
import pg from "pg";
import { startApiRuntime } from "../src/runtime";
import { createApiServer } from "../src/server";

const exec = promisify(execFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));
const rpcError = (error: unknown) => error instanceof MintSdkError && error.code === "RPC_ERROR";

test("member status SDK -> HTTP -> migrated PG16 preserves policy and atomic session revocation", {
  timeout: 90_000,
}, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL binaries");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-status-pg-"));
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
      errors: { error: ({ name }) => { logged.push(name); } },
    });
    const url = `${runtime.address}/trpc`;
    const sdk = (sessionToken?: string) => createMintSdk({ url, gatewayToken, sessionToken });
    const mutate = (input: unknown, sessionToken?: string, headers: Record<string, string> = {}) =>
      fetch(`${url}/accounts.setMemberStatus`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_TOKEN_HEADER_NAME]: gatewayToken,
          ...(sessionToken ? { cookie: `mint_session=${sessionToken}` } : {}),
          ...headers,
        },
        body: JSON.stringify(input),
      });
    const account = async (label: string, role: AccountRole, status: AccountStatus) => {
      const { rows } = await observer.query<{ id: string }>(
        `INSERT INTO accounts.users (email, name, password_hash, role, status, approved_at, approved_by)
         VALUES ($1, $2, 'fixture-private-password', $3, $4, $5, $6) RETURNING id`,
        [`${label}@fixture.test`, label, role, status, new Date("2026-01-01T00:00:00Z"), randomUUID()],
      );
      return rows[0]!.id;
    };
    const session = async (userId: string, expiresAt = new Date(Date.now() + 86_400_000)) => {
      const token = randomBytes(32).toString("base64url");
      await observer.query(
        "INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ($1, $2, $3)",
        [hash(token), userId, expiresAt],
      );
      return token;
    };
    const user = async (id: string) => (await observer.query(
      "SELECT * FROM accounts.users WHERE id = $1", [id],
    )).rows[0];
    const sessionCount = async (id: string) => Number((await observer.query(
      "SELECT count(*) FROM accounts.sessions WHERE user_id = $1", [id],
    )).rows[0].count);

    const adminId = await account("admin", "admin", "active");
    const adminToken = await session(adminId);
    const admin = sdk(adminToken);
    const memberId = await account("member", "user", "active");
    const memberToken = await session(memberId);
    const member = sdk(memberToken);
    const targetId = await account("target", "user", "denied");
    const targetToken = await session(targetId);
    const target = sdk(targetToken);
    const targetBefore = await user(targetId);
    const pendingId = await account("pending", "user", "pending");
    const pendingToken = await session(pendingId);
    const pendingBefore = await user(pendingId);

    await t.test("active admins enable denied and disabled accounts without changing approval fields", async () => {
      assert.equal(await target.accounts.session(), null);
      assert.equal(await admin.accounts.setMemberStatus({ userId: targetId, status: "active" }), undefined);
      const enabled = await user(targetId);
      assert.equal(enabled.status, "active");
      assert.equal(enabled.approved_by, targetBefore.approved_by);
      assert.deepEqual(enabled.approved_at, targetBefore.approved_at);
      assert.equal((await target.accounts.session())?.id, targetId);
      const disabledId = await account("disabled", "user", "disabled");
      const before = await user(disabledId);
      await admin.accounts.setMemberStatus({ userId: disabledId, status: "active" });
      assert.equal((await user(disabledId)).status, "active");
      assert.deepEqual((await user(disabledId)).approved_at, before.approved_at);
      assert.equal((await user(disabledId)).approved_by, before.approved_by);
      assert.deepEqual(await admin.library.listFiles(), { items: [], nextCursor: null });
    });

    await t.test("anonymous, member, inactive, expired, native and forged identities cannot mutate", async () => {
      const expiredToken = await session(adminId, new Date(Date.now() - 60_000));
      const revokedToken = await session(adminId);
      await observer.query("DELETE FROM accounts.sessions WHERE id = $1", [hash(revokedToken)]);
      const inactiveId = await account("inactive-admin", "admin", "disabled");
      const inactiveToken = await session(inactiveId);
      for (const token of [
        undefined, memberToken, pendingToken, inactiveToken, expiredToken, revokedToken, "mn1.native-session",
      ]) {
        const response = await mutate({ userId: targetId, status: "disabled" }, token, {
          "x-user-id": adminId, "x-user-role": "admin", "x-mint-user-id": adminId,
          "x-mint-user-role": "admin", "x-mint-user-status": "active",
          authorization: `Bearer ${adminToken}`,
          "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1",
        });
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error.data.code, "FORBIDDEN");
      }
      await assert.rejects(member.accounts.setMemberStatus({ userId: targetId, status: "disabled" }), rpcError);
      await assert.rejects(sdk().accounts.setMemberStatus({ userId: targetId, status: "disabled" }), rpcError);
      assert.equal((await user(targetId)).status, "active");
    });

    await t.test("both self-status changes reject with preserved safe copy", async () => {
      for (const status of ["active", "disabled"] as const) {
        const response = await mutate({ userId: adminId, status }, adminToken);
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.error.data.code, "BAD_REQUEST");
        assert.equal(body.error.message, "You can't disable your own account.");
        await assert.rejects(admin.accounts.setMemberStatus({ userId: adminId, status }), rpcError);
      }
      assert.equal((await user(adminId)).status, "active");
      assert.equal((await admin.accounts.session())?.id, adminId);
    });

    await t.test("pending and missing targets are no-ops; approval mutation remains available", async () => {
      const missing = randomUUID();
      const countBefore = (await observer.query("SELECT count(*) FROM accounts.users")).rows[0].count;
      for (const status of ["active", "disabled"] as const) {
        await admin.accounts.setMemberStatus({ userId: pendingId, status });
        await admin.accounts.setMemberStatus({ userId: missing, status });
        assert.deepEqual(await user(pendingId), pendingBefore);
        assert.equal(await sessionCount(pendingId), 1);
        assert.equal(await user(missing), undefined);
      }
      assert.equal((await observer.query("SELECT count(*) FROM accounts.users")).rows[0].count, countBefore);
      const approvalId = await account("approval", "user", "pending");
      await admin.accounts.decideAccessRequest({ userId: approvalId, approve: true });
      assert.equal((await user(approvalId)).approved_by, adminId);
    });

    await t.test("strict input and mandatory gateway authentication remain unchanged", async () => {
      for (const input of [
        null, [], {}, { userId: targetId }, { userId: "not-a-uuid", status: "active" },
        { userId: targetId, status: "pending" }, { userId: targetId, status: true },
        { userId: targetId, status: "disabled", actor: { id: adminId, role: "admin", status: "active" } },
        { userId: targetId, status: "disabled", role: "admin" },
      ]) {
        assert.equal((await mutate(input, adminToken)).status, 400);
      }
      const body = JSON.stringify({ userId: targetId, status: "disabled" });
      for (const serviceToken of [undefined, randomBytes(32).toString("base64url"), "invalid"]) {
        for (const token of [undefined, adminToken]) {
          const response = await fetch(`${url}/accounts.setMemberStatus`, {
            method: "POST", body,
            headers: {
              "content-type": "application/json",
              ...(serviceToken ? { [GATEWAY_TOKEN_HEADER_NAME]: serviceToken } : {}),
              ...(token ? { cookie: `mint_session=${token}` } : {}),
            },
          });
          assert.equal(response.status, 401);
          assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
        }
      }
      assert.equal((await user(targetId)).status, "active");
    });

    await t.test("the same admin SDK immediately observes persisted demotion and revocation", async () => {
      await observer.query("UPDATE accounts.users SET role = 'user' WHERE id = $1", [adminId]);
      await assert.rejects(admin.accounts.setMemberStatus({ userId: targetId, status: "disabled" }), rpcError);
      assert.equal((await mutate({ userId: targetId, status: "disabled" }, adminToken)).status, 403);
      await observer.query("UPDATE accounts.users SET role = 'admin' WHERE id = $1", [adminId]);
      await admin.accounts.setMemberStatus({ userId: targetId, status: "active" });
      await observer.query("DELETE FROM accounts.sessions WHERE id = $1", [hash(adminToken)]);
      await assert.rejects(admin.accounts.setMemberStatus({ userId: targetId, status: "disabled" }), rpcError);
      assert.equal((await mutate({ userId: targetId, status: "disabled" }, adminToken)).status, 403);
      assert.equal(await admin.accounts.session(), null);
      assert.equal((await user(targetId)).status, "active");
    });

    const freshAdmin = sdk(await session(adminId));
    const freshAdminToken = await session(adminId);
    await session(targetId);
    await session(targetId, new Date(Date.now() - 60_000));
    await t.test("failed session deletion rolls back status and all sessions with sanitized HTTP/SDK errors", async () => {
      const before = await user(targetId);
      const sessionsBefore = await sessionCount(targetId);
      assert.equal(sessionsBefore, 3);
      assert.deepEqual(logged, []);
      await observer.query(`
        CREATE FUNCTION accounts.reject_fixture_delete() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'fixture-private-db-session-failure'; END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_fixture_delete BEFORE DELETE ON accounts.sessions
        FOR EACH ROW EXECUTE FUNCTION accounts.reject_fixture_delete()
      `);
      try {
        const response = await mutate({ userId: targetId, status: "disabled" }, freshAdminToken);
        assert.equal(response.status, 500);
        const body = await response.text();
        assert.match(body, /Internal server error/);
        assert.doesNotMatch(body, /fixture-private|password|DELETE|UPDATE|accounts|sessions|stack/);
        await assert.rejects(freshAdmin.accounts.setMemberStatus({ userId: targetId, status: "disabled" }), (error) => {
          assert.ok(rpcError(error));
          assert.doesNotMatch(String(error) + JSON.stringify(error), /fixture-private|DELETE|UPDATE|accounts|sessions/);
          return true;
        });
        assert.deepEqual(await user(targetId), before);
        assert.equal(await sessionCount(targetId), sessionsBefore);
        assert.deepEqual(logged, ["Error", "Error"]);
      } finally {
        await observer.query(`
          DROP TRIGGER reject_fixture_delete ON accounts.sessions;
          DROP FUNCTION accounts.reject_fixture_delete()
        `);
      }
    });

    await t.test("successful disable revokes every target session, retains approvals and never restores old tokens", async () => {
      assert.equal(await freshAdmin.accounts.setMemberStatus({ userId: targetId, status: "disabled" }), undefined);
      assert.equal(await sessionCount(targetId), 0);
      const response = await mutate({ userId: targetId, status: "disabled" }, freshAdminToken);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { result: { data: null } });
      assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
      assert.equal(await sessionCount(targetId), 0);
      const disabled = await user(targetId);
      assert.equal(disabled.status, "disabled");
      assert.deepEqual(disabled.approved_at, targetBefore.approved_at);
      assert.equal(disabled.approved_by, targetBefore.approved_by);
      assert.equal(await target.accounts.session(), null);
      await assert.rejects(target.library.listFiles(), rpcError);
      await assert.rejects(target.accounts.setMemberStatus({ userId: memberId, status: "disabled" }), rpcError);
      assert.equal((await member.accounts.session())?.id, memberId);
      await freshAdmin.accounts.setMemberStatus({ userId: targetId, status: "active" });
      assert.equal(await sessionCount(targetId), 0);
      assert.equal(await target.accounts.session(), null);
      await assert.rejects(target.library.listFiles(), rpcError);
      assert.equal((await sdk(await session(targetId)).accounts.session())?.id, targetId);
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

test("member status factory dependency is additive and fails explicitly when absent", async () => {
  const gatewayToken = randomBytes(32).toString("base64url");
  const app = createApiServer({
    gatewayToken,
    sessions: { findByTokenHash: async () => null },
    decisions: { decidePendingAccess: async () => {}, countPending: async () => 0 },
    notifyAccessRequests: async () => {},
    errors: { error: () => assert.fail("unavailable service is not an internal error") },
  });
  try {
    const response = await app.inject({
      method: "POST", url: "/trpc/accounts.setMemberStatus",
      headers: { [GATEWAY_TOKEN_HEADER_NAME]: gatewayToken },
      payload: { userId: randomUUID(), status: "disabled" },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.data.code, "SERVICE_UNAVAILABLE");
    assert.equal((await app.inject({
      url: "/trpc/accounts.session", headers: { [GATEWAY_TOKEN_HEADER_NAME]: gatewayToken },
    })).json().result.data, null);
  } finally {
    await app.close();
  }
});
