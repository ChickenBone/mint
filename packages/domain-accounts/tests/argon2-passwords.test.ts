import assert from "node:assert/strict";
import { test } from "node:test";
import { hash, verify } from "@node-rs/argon2";
import {
  argon2Passwords,
  bootstrapAdmin,
  createAccountAccessRequester,
  createAccountAuthenticator,
  type AuthenticationAccount,
  type BootstrapAdminAccount,
  type PendingAccount,
} from "../src/index";

const password = "  fixture password é  ";
const ip = "192.0.2.1";

test("binding uses legacy default parameters, fresh salts and interoperable hashes", async () => {
  const legacyHash = await hash(password);
  const targetHash = await argon2Passwords.hash(password);
  const anotherHash = await argon2Passwords.hash(password);

  assert.match(targetHash, /^\$argon2id\$v=19\$/);
  assert.equal(targetHash.split("$").slice(1, 4).join("$"), legacyHash.split("$").slice(1, 4).join("$"));
  assert.notEqual(targetHash, anotherHash);
  assert.equal(await argon2Passwords.verify(legacyHash, password), true);
  assert.equal(await verify(targetHash, password), true);
  assert.equal(await argon2Passwords.verify(targetHash, password.trim()), false);
  assert.equal(await argon2Passwords.verify(targetHash, "wrong password"), false);
});

test("malformed hash failures propagate and authentication reports an unavailable service", async () => {
  const malformedHash = "not-an-argon2-hash";
  await assert.rejects(verify(malformedHash, password));
  await assert.rejects(argon2Passwords.verify(malformedHash, password));

  const logs: string[][] = [];
  const authenticate = createAccountAuthenticator({
    passwords: argon2Passwords,
    admission: { allow: async () => true },
    repository: {
      findByLowercaseEmail: async () => ({
        id: "12345678-1234-4234-8234-123456789012",
        email: "member@example.test", name: "Member", role: "user", status: "active",
        passwordHash: malformedHash,
      }),
    },
    logger: { error: (...args) => { logs.push(args); } },
  });
  assert.deepEqual(await authenticate("member@example.test", password, ip), {
    error: "Sign-in is unavailable. Try again later.", status: 503,
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.[0], "[auth] password verification failed");
  assert.ok(!JSON.stringify(logs).includes(malformedHash));
});

test("bootstrap and access request hashes work with the authenticator port", async () => {
  let admin: BootstrapAdminAccount | undefined;
  assert.deepEqual(await bootstrapAdmin(
    { email: "admin@example.test", name: "Admin", password },
    {
      findByLowercaseEmail: async () => null,
      insertAdminIfAbsent: async (account) => { admin = account; return true; },
    },
    { hash: argon2Passwords.hash, now: () => new Date("2030-01-01T00:00:00Z") },
  ), { status: "created" });
  assert.ok(admin);
  assert.equal(await verify(admin.passwordHash, password), true);

  let pending: PendingAccount | undefined;
  const request = createAccountAccessRequester({
    repository: {
      findByLowercaseEmail: async () => null,
      insertPendingIfAbsent: async (account) => { pending = account; return true; },
      countPending: async () => 1,
    },
    admission: { allow: async () => true },
    hash: argon2Passwords.hash,
    notify: async () => {},
  });
  assert.deepEqual(await request({
    email: "member@example.test", name: "Member", password, confirm: password,
  }, ip), { ok: true });
  assert.ok(pending);
  assert.equal(await verify(pending.passwordHash, password), true);

  const principal = {
    id: "12345678-1234-4234-8234-123456789012",
    email: pending.email, name: pending.name, role: "user", status: "active",
  } as const;
  const account: AuthenticationAccount = { ...principal, passwordHash: pending.passwordHash };
  const authenticate = createAccountAuthenticator({
    repository: { findByLowercaseEmail: async () => account },
    passwords: argon2Passwords,
    admission: { allow: async () => true },
    logger: { error: () => { throw new Error("unexpected password failure"); } },
  });
  assert.deepEqual(await authenticate(principal.email, password, ip), { principal });
  assert.deepEqual(await authenticate(principal.email, "wrong password", ip), {
    error: "That email and password don't match an account.", status: 401,
  });
});
