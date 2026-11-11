import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";

const database = process.env.NATIVE_TEST_DATABASE_URL;
test("native sessions retain approval, device binding, hash isolation and private-worker revocation", {
  skip: !database && "Set NATIVE_TEST_DATABASE_URL to an isolated PostgreSQL test server; use --conditions=react-server",
}, async () => {
  const url = new URL(database!);
  assert.match(url.pathname, /^\/mint_native_test_[a-z0-9_]+$/, "Only an isolated explicitly named native test database is allowed.");
  const pool = new pg.Pool({ connectionString: database });
  process.env.DATABASE_URL = database;
  const root = new URL("../../../packages/core/migrations/", import.meta.url);
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", root), "utf8")) as { entries: { tag: string }[] };
  for (const migration of journal.entries) await pool.query(await readFile(new URL(`${migration.tag}.sql`, root), "utf8"));
  const { getDb, closeDb, schema } = await import("@mint/core/db");
  const { sha256 } = await import("@mint/core/crypto");
  const { activePlaybackSession } = await import("@mint/core/playback");
  const { createNativeSession, resolveNativeSession, revokeNativeSession } = await import("../src/lib/native-sessions");
  const { DeviceStore } = await import("../src/lib/devices-store");
  const { connectedDevices } = await import("@mint/core/devices-db");
  const { eq } = await import("drizzle-orm");
  const db = getDb();
  const [member, operator] = await db.insert(schema.users).values([
    { name: "Listener", email: "listener@native.test", passwordHash: "fixture", status: "active" as const },
    { name: "Operator", email: "operator@native.test", passwordHash: "fixture", status: "active" as const, role: "admin" as const },
  ]).returning();
  const request = (token: string) => new Request("https://mint.example.com/api/native/player/audio/test",
    { headers: { authorization: `Bearer ${token}` } });
  try {
    const deviceId = randomUUID(), otherDevice = randomUUID();
    const credential = await createNativeSession(member!.id, deviceId, "Fixture phone", "127.0.0.1");
    const resolved = await resolveNativeSession(request(credential.token));
    assert.equal(resolved?.user.id, member!.id);
    assert.equal(resolved?.deviceId, deviceId);
    assert.equal(resolved?.sessionHash, sha256(credential.token));
    assert.match(resolved!.sessionHash, /^[a-f0-9]{64}$/);
    assert.ok(await activePlaybackSession(resolved!.sessionHash, member!.id), "The worker recognizes the same session hash.");
    assert.equal(await activePlaybackSession(resolved!.sessionHash, operator!.id), null);
    assert.equal(await resolveNativeSession(request(credential.token.replace(deviceId, otherDevice))), null);
    const [stored] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, resolved!.sessionHash));
    assert.equal(stored!.id.includes(credential.token), false, "The raw credential is not stored.");
    const deviceStore = new DeviceStore(db, { userId: member!.id, sessionId: resolved!.sessionHash, installationId: deviceId });
    const registration = await deviceStore.register({ name: "Fixture phone", state: {
      playing: false, time: 0, duration: 0, volume: 100, trackId: null, queue: [], currentIndex: 0, shuffle: false, repeat: 0,
    } });
    await db.update(connectedDevices).set({ lastConnectedAt: new Date(Date.now() - 10 * 24 * 3600_000) }).where(eq(connectedDevices.id, registration.id));
    await resolveNativeSession(request(credential.token));
    const [connected] = await db.select().from(connectedDevices).where(eq(connectedDevices.id, registration.id));
    assert.ok(connected!.lastConnectedAt.getTime() > Date.now() - 5000, "Any authenticated Mint connection renews installed retention");

    const second = await createNativeSession(member!.id, deviceId, "Fixture phone", "127.0.0.1");
    assert.equal(await resolveNativeSession(request(credential.token)), null, "Same-installation sign-in revokes the prior native session.");
    assert.equal(await activePlaybackSession(resolved!.sessionHash, member!.id), null);
    const [retained] = await db.select().from(connectedDevices).where(eq(connectedDevices.id, registration.id));
    assert.equal(retained?.authSessionId, null, "Token rotation retains installed identity but disconnects its old receiver");
    await db.update(schema.users).set({ status: "disabled" }).where(eq(schema.users.id, member!.id));
    assert.equal(await resolveNativeSession(request(second.token)), null);
    assert.equal(await activePlaybackSession(sha256(second.token), member!.id), null, "Disabled accounts cannot stream.");
    await db.update(schema.users).set({ status: "active" }).where(eq(schema.users.id, member!.id));
    await revokeNativeSession(request(second.token));
    assert.equal(await resolveNativeSession(request(second.token)), null);
    assert.equal(await activePlaybackSession(sha256(second.token), member!.id), null, "Logout invalidates worker authorization too.");

    const adminCredential = await createNativeSession(operator!.id, otherDevice, "Fixture tablet", "127.0.0.1");
    assert.equal((await resolveNativeSession(request(adminCredential.token)))?.user.role, "user", "Native facade never grants administrator privilege.");
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, operator!.id));
    assert.equal(await resolveNativeSession(request(adminCredential.token)), null, "Existing account-session revocation deletes native sessions.");

    const expired = await createNativeSession(member!.id, deviceId, "Fixture phone", "127.0.0.1");
    await db.update(schema.sessions).set({ expiresAt: new Date(0) }).where(eq(schema.sessions.id, sha256(expired.token)));
    assert.equal(await resolveNativeSession(request(expired.token)), null);
  } finally {
    await closeDb();
    await pool.end();
  }
});
