import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  issueBrowserSession,
  revokeBrowserSession,
  SESSION_TTL_MS,
  type SessionLifecycleRepository,
  type StoredSessionEvidence,
} from "../src/session-lifecycle";
import { lookupBrowserSession } from "../src/session-lookup";

const userId = "12345678-1234-4234-8234-123456789012";
const instant = new Date("2030-01-02T03:04:05.000Z");
const token = "browser-session-token";
const tokenHash = "432b884e210a50239c230330ab316fa5da003c2334ab320ee5b61581a042cebd";
const dependencies = { now: () => new Date(instant), generateToken: () => token };

function fixture() {
  const inserted: StoredSessionEvidence[] = [];
  const deleted: string[] = [];
  const repository: SessionLifecycleRepository = {
    async insertSession(session) {
      inserted.push(session);
    },
    async deleteByTokenHash(hash) {
      deleted.push(hash);
    },
  };
  return { repository, inserted, deleted };
}

test("issues the raw token only to the caller and persists exact hash-only evidence", async () => {
  const { repository, inserted } = fixture();
  const result = await issueBrowserSession(
    { userId, ip: "192.0.2.1", userAgent: "fixture-agent" },
    repository,
    dependencies,
  );
  assert.deepEqual(result, {
    token,
    expiresAt: new Date("2030-02-01T03:04:05.000Z"),
  });
  assert.deepEqual(inserted, [{
    id: tokenHash,
    userId,
    createdAt: instant,
    expiresAt: result.expiresAt,
    ip: "192.0.2.1",
    userAgent: "fixture-agent",
  }]);
  assert.ok(!JSON.stringify(inserted).includes(token));
  assert.notEqual(inserted[0]?.expiresAt, result.expiresAt);
  assert.equal(SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
});

test("production generation uses independent unpadded base64url tokens encoding exactly 32 bytes", async () => {
  const { repository, inserted } = fixture();
  const first = await issueBrowserSession({ userId }, repository);
  const second = await issueBrowserSession({ userId }, repository);
  assert.notEqual(first.token, second.token);
  for (const [index, result] of [first, second].entries()) {
    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(result.token, "base64url").length, 32);
    assert.equal(Buffer.from(result.token, "base64url").toString("base64url"), result.token);
    const stored = inserted[index];
    assert.ok(stored);
    assert.equal(stored.id, createHash("sha256").update(result.token).digest("hex"));
    assert.equal(result.expiresAt.getTime() - stored.createdAt.getTime(), SESSION_TTL_MS);
    assert.ok(!JSON.stringify(stored).includes(result.token));
  }
});

test("preserves IP values and optional user-agent slicing semantics without invented metadata", async () => {
  for (const ip of [undefined, null, "", "192.0.2.1"]) {
    for (const userAgent of [undefined, null, "", "a".repeat(299), "a".repeat(300), "b".repeat(301), "\u{1F600}".repeat(151)]) {
      const { repository, inserted } = fixture();
      await issueBrowserSession({ userId, ip, userAgent }, repository, dependencies);
      assert.equal(inserted[0]?.ip, ip);
      assert.equal(inserted[0]?.userAgent, userAgent?.slice(0, 300));
    }
  }
  const { repository, inserted } = fixture();
  await issueBrowserSession({ userId }, repository, dependencies);
  assert.equal(inserted[0]?.ip, undefined);
  assert.equal(inserted[0]?.userAgent, undefined);
});

test("the 30-day expiry is exclusive and lookup exposes only the principal", async () => {
  const { repository, inserted } = fixture();
  const issued = await issueBrowserSession({ userId }, repository, dependencies);
  const stored = inserted[0];
  assert.ok(stored);
  const principal = { id: userId, email: "fixture@example.test", name: "Fixture", role: "admin", status: "active" } as const;
  const lookupRepository = {
    async findByTokenHash(hash: string) {
      assert.equal(hash, stored.id);
      return { ...stored, token: issued.token, principal: { ...principal, token: issued.token, tokenHash: stored.id } };
    },
  };
  const result = await lookupBrowserSession(issued.token, lookupRepository, () => new Date(issued.expiresAt.getTime() - 1));
  assert.deepEqual(result, principal);
  assert.ok(!JSON.stringify(result).includes(issued.token));
  assert.ok(!JSON.stringify(result).includes(stored.id));
  for (const offset of [0, 1]) {
    assert.equal(await lookupBrowserSession(
      issued.token, lookupRepository, () => new Date(issued.expiresAt.getTime() + offset),
    ), null);
  }
});

test("invalid user IDs and clocks fail explicitly before inserting", async () => {
  const { repository, inserted } = fixture();
  for (const invalidId of ["", "not-a-uuid", ` ${userId} `]) {
    await assert.rejects(issueBrowserSession({ userId: invalidId }, repository, dependencies));
  }
  for (const time of [NaN, 8.64e15]) {
    await assert.rejects(
      issueBrowserSession({ userId }, repository, { ...dependencies, now: () => new Date(time) }),
      /Invalid session clock/,
    );
  }
  assert.deepEqual(inserted, []);
});

test("user IDs follow the accepted principal GUID contract rather than a stricter UUID version", async () => {
  for (const id of ["00000000-0000-0000-0000-000000000000", "12345678-1234-1234-1234-123456789012", userId.toUpperCase()]) {
    const { repository, inserted } = fixture();
    await issueBrowserSession({ userId: id }, repository, dependencies);
    assert.equal(inserted[0]?.userId, id);
  }
});

test("uses the supplied clock and token generator once and does not mutate the supplied Date", async () => {
  const { repository, inserted } = fixture();
  let clocks = 0;
  let tokens = 0;
  const clockValue = new Date(instant);
  await issueBrowserSession({ userId }, repository, {
    now: () => { clocks += 1; return clockValue; },
    generateToken: () => { tokens += 1; return token; },
  });
  assert.equal(clocks, 1);
  assert.equal(tokens, 1);
  assert.equal(clockValue.getTime(), instant.getTime());
  assert.notEqual(inserted[0]?.createdAt, clockValue);
});

test("revocation hashes present tokens including native-looking cookie values like current logout", async () => {
  const { repository, deleted, inserted } = fixture();
  await revokeBrowserSession(token, repository);
  await revokeBrowserSession(token, repository);
  await revokeBrowserSession("mn1.native-token", repository);
  assert.deepEqual(deleted, [
    tokenHash, tokenHash, createHash("sha256").update("mn1.native-token").digest("hex"),
  ]);
  assert.deepEqual(inserted, []);
});

test("missing-token revocation is idempotent and does not write", async () => {
  const { repository, inserted, deleted } = fixture();
  for (const missing of [undefined, null, ""]) {
    await revokeBrowserSession(missing, repository);
  }
  assert.deepEqual(inserted, []);
  assert.deepEqual(deleted, []);
});

test("repository and dependency failures propagate unchanged", async () => {
  const failure = new Error("fixture unavailable");
  const repository: SessionLifecycleRepository = {
    async insertSession() { throw failure; },
    async deleteByTokenHash() { throw failure; },
  };
  await assert.rejects(issueBrowserSession({ userId }, repository, dependencies), (error) => error === failure);
  await assert.rejects(revokeBrowserSession(token, repository), (error) => error === failure);
  const { repository: unused, inserted } = fixture();
  await assert.rejects(issueBrowserSession({ userId }, unused, {
    ...dependencies, now: () => { throw failure; },
  }), (error) => error === failure);
  await assert.rejects(issueBrowserSession({ userId }, unused, {
    ...dependencies, generateToken: () => { throw failure; },
  }), (error) => error === failure);
  assert.deepEqual(inserted, []);
});
