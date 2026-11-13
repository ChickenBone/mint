import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordings } from "@mint/domain-catalog";
import { createLibraryRepository, mediaFiles, roots } from "@mint/domain-library";
import { createMintSdk, MintSdkError } from "@mint/sdk";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { startApiRuntime } from "../src/runtime";
import { createApiServer } from "../src/server";

const exec = promisify(execFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));

test("Library SDK -> HTTP -> migrated PG16 authorizes fresh sessions and lists only verified files", {
  timeout: 90_000,
}, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL binaries");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-list-pg-"));
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
    const request = (input: unknown, sessionToken?: string, serviceToken = gatewayToken) =>
      fetch(`${url}/library.listFiles?input=${encodeURIComponent(JSON.stringify(input))}`, {
        headers: {
          "x-mint-gateway-token": serviceToken,
          ...(sessionToken ? { cookie: `mint_session=${sessionToken}` } : {}),
          "x-mint-user-role": "admin", "x-mint-user-status": "active",
        },
      });

    const tokens: Record<string, string> = {};
    const userIds: Record<string, string> = {};
    for (const [label, role, status] of [
      ["member", "user", "active"], ["admin", "admin", "active"],
      ["pending", "user", "pending"], ["denied", "user", "denied"],
      ["disabled", "user", "disabled"], ["expired", "user", "active"],
      ["revoked", "user", "active"],
    ]) {
      assert.ok(label && role && status);
      const token = randomBytes(32).toString("base64url");
      tokens[label] = token;
      const user = await observer.query<{ id: string }>(
        `INSERT INTO accounts.users (email, name, password_hash, role, status)
         VALUES ($1, $2, 'fixture', $3, $4) RETURNING id`,
        [`${label}@fixture.test`, label, role, status],
      );
      const id = user.rows[0]!.id;
      userIds[label] = id;
      if (label !== "revoked") {
        await observer.query(
          "INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ($1, $2, $3)",
          [hash(token), id, new Date(Date.now() + (label === "expired" ? -60_000 : 86_400_000))],
        );
      }
    }

    const repository = createLibraryRepository(drizzle(observer, { schema: { roots, mediaFiles, recordings } }));
    const root = await repository.createRoot({ path: "/fixture-private-root" });
    const db = drizzle(observer);
    const [recording] = await db.insert(recordings).values({
      title: "Confirmed song", version: "Catalog version", durationMs: 230_000,
    }).returning();
    assert.ok(recording);
    const verified: string[] = [];
    for (let index = 0; index < 105; index++) {
      const file = await repository.createMediaFile({
        rootId: root.id, relativePath: `private/folder/file-${index}.flac`,
        recordingId: index < 2 ? recording.id : null,
        importedTags: index < 3 ? {
          title: "Caf\u00e9 Echo", artist: "Fixture Artist", album: "Fixture Album",
          version: index === 0 ? "Original" : index === 1 ? "Live" : null,
        } : { title: `Fixture song ${index}` },
      });
      await repository.recordVerification(file.id, {
        availability: "verified", checkedAt: new Date(),
        audio: { streamIndex: 0, codec: "flac", decodedSampleFrames: 100, durationMs: 120_000 },
      });
      verified.push(file.id);
    }
    const unverified = await repository.createMediaFile({
      rootId: root.id, relativePath: "not-verified.flac",
    });
    const unavailable = await repository.createMediaFile({
      rootId: root.id, relativePath: "missing.flac",
    });
    await repository.recordVerification(unavailable.id, {
      availability: "verified", checkedAt: new Date(0),
      audio: { streamIndex: 0, codec: "flac", decodedSampleFrames: 100 },
    });
    await repository.recordVerification(unavailable.id, {
      availability: "unavailable", checkedAt: new Date(), reason: "missing",
    });

    const member = sdk(tokens.member);
    assert.equal((await member.accounts.session())?.id, userIds.member);
    assert.equal((await member.library.listFiles()).items.length, 50);
    assert.equal((await member.library.listFiles({ limit: 100 })).items.length, 100);
    assert.equal((await sdk(tokens.admin).library.listFiles({ limit: 1 })).items.length, 1);
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await member.library.listFiles({ limit: 17, cursor });
      assert.ok(page.items.length <= 17);
      for (const item of page.items) {
        assert.deepEqual(Object.keys(item).sort(),
          ["album", "artist", "durationMs", "id", "recordingId", "title", "version"]);
        all.push(item.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(all, [...verified].sort());
    assert.equal(new Set(all).size, 105);
    assert.ok(!all.includes(unverified.id) && !all.includes(unavailable.id));
    const search = await member.library.listFiles({ search: " ECHO caf\u00e9 ", limit: 1 });
    assert.ok(search.nextCursor);
    const rest = await member.library.listFiles({ search: "echo cafe", limit: 100, cursor: search.nextCursor });
    const matches = [...search.items, ...rest.items];
    assert.equal(matches.length, 3);
    assert.equal(matches.filter((item) => item.recordingId === recording.id).length, 2);
    assert.equal(matches.filter((item) => item.recordingId === null).length, 1);
    assert.deepEqual(matches.map((item) => item.version).sort(), ["Live", "Original", null].sort());
    assert.ok(matches.every((item) => item.durationMs === 120_000 && item.title === "Caf\u00e9 Echo"));
    assert.deepEqual(await member.library.listFiles({ search: "%" }), { items: [], nextCursor: null });
    assert.equal((await request({ cursor: search.nextCursor, search: "different" }, tokens.member)).status, 400);
    assert.equal((await request({ cursor: "a" }, tokens.member)).status, 400);
    for (const input of [
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "1" },
      { search: "x".repeat(201) }, { search: "\0" }, { cursor: "x".repeat(2049) },
      { cursor: "" }, { actor: { role: "admin" } }, null,
    ]) {
      assert.equal((await request(input, tokens.member)).status, 400);
    }
    for (const token of [undefined, tokens.pending, tokens.denied, tokens.disabled, tokens.expired, tokens.revoked]) {
      assert.equal((await request({}, token)).status, 401);
      await assert.rejects(sdk(token).library.listFiles(), (error: unknown) =>
        error instanceof MintSdkError && error.code === "RPC_ERROR");
    }
    assert.equal((await request({}, tokens.member, randomBytes(32).toString("base64url"))).status, 401);
    assert.equal((await fetch(`${url}/library.listFiles`)).status, 401);
    const omittedInput = await fetch(`${url}/library.listFiles`, {
      headers: { "x-mint-gateway-token": gatewayToken, cookie: `mint_session=${tokens.member}` },
    });
    assert.equal(omittedInput.status, 200);
    assert.match(omittedInput.headers.get("cache-control") ?? "", /private, no-store/);

    // The same SDK instance must observe persisted revocation/status changes immediately.
    await observer.query("UPDATE accounts.users SET status = 'disabled' WHERE id = $1", [userIds.member]);
    await assert.rejects(member.library.listFiles(), MintSdkError);
    await observer.query("UPDATE accounts.users SET status = 'active' WHERE id = $1", [userIds.member]);
    assert.equal((await member.library.listFiles({ limit: 1 })).items.length, 1);
    await observer.query("DELETE FROM accounts.sessions WHERE id = $1", [hash(tokens.member!)]);
    await assert.rejects(member.library.listFiles(), MintSdkError);
    assert.equal(await member.accounts.session(), null);
    assert.deepEqual(logged, []);

    // Real database failures must be explicit, sanitized failures, never empty pages.
    await observer.query("ALTER TABLE library.media_files RENAME TO fixture_hidden_files");
    try {
      const failure = await request({}, tokens.admin);
      assert.equal(failure.status, 500);
      const body = await failure.text();
      assert.match(body, /Internal server error/);
      assert.doesNotMatch(body, /fixture_hidden|media_files|SELECT|fixture-private-root/);
      await assert.rejects(sdk(tokens.admin).library.listFiles(), (error: unknown) =>
        error instanceof MintSdkError && error.code === "RPC_ERROR");
      assert.equal(logged.length, 2);
      assert.ok(logged.every((name) => name === "Error"));
    } finally {
      await observer.query("ALTER TABLE library.fixture_hidden_files RENAME TO media_files");
    }
    assert.equal((await sdk(tokens.admin).library.listFiles({ limit: 1 })).items.length, 1);
    const address = runtime.address;
    await runtime.stop();
    runtime = undefined;
    await assert.rejects(fetch(`${address}/trpc/library.listFiles`));
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

test("Library factory compatibility fails explicitly when unavailable and validates repository output", async () => {
  const gatewayToken = randomBytes(32).toString("base64url");
  const logged: string[] = [];
  const dependencies = {
    gatewayToken,
    sessions: { findByTokenHash: async () => ({
      expiresAt: new Date(Date.now() + 60_000),
      principal: {
        id: "00000000-0000-0000-0000-000000000001", email: "fixture@fixture.test",
        name: "Fixture", role: "user" as const, status: "active" as const,
      },
    }) },
    decisions: { decidePendingAccess: async () => {}, countPending: async () => 0 },
    notifyAccessRequests: async () => {},
    errors: { error: ({ name }: { name: string }) => { logged.push(name); } },
  };
  const headers = { "x-mint-gateway-token": gatewayToken, cookie: `mint_session=${randomBytes(32).toString("base64url")}` };
  const unavailable = createApiServer(dependencies);
  try {
    assert.equal((await unavailable.inject({ url: "/trpc/library.listFiles", headers })).statusCode, 503);
    assert.equal((await unavailable.inject({ url: "/trpc/accounts.session", headers })).statusCode, 200);
  } finally {
    await unavailable.close();
  }
  const invalid = createApiServer({
    ...dependencies, library: { listFiles: async () => ({
      items: [{
        id: "not-a-uuid", recordingId: null, title: "", artist: "Fixture", album: "Fixture",
        version: null, durationMs: -1,
      }], nextCursor: null,
    }) },
  });
  try {
    const response = await invalid.inject({ url: "/trpc/library.listFiles", headers });
    assert.equal(response.statusCode, 500);
    assert.match(response.body, /Internal server error/);
    assert.doesNotMatch(response.body, /not-a-uuid|Zod|stack/);
    assert.equal(logged.length, 1);
  } finally {
    await invalid.close();
  }
});
