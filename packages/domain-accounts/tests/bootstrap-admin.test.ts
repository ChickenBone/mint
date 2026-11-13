import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bootstrapAdmin,
  type AdminBootstrapDependencies,
  type AdminBootstrapRepository,
  type AuthenticationAccount,
  type BootstrapAdminAccount,
} from "../src/index";

const instant = new Date("2030-01-02T03:04:05.000Z");
const input = { email: "Seed@Example.test", name: "Configured Admin", password: " explicit password " };

function fixture(existing: AuthenticationAccount | null = null) {
  const calls: string[] = [];
  const inserted: BootstrapAdminAccount[] = [];
  const repository: AdminBootstrapRepository = {
    async findByLowercaseEmail(email) {
      calls.push(`lookup:${email}`);
      return existing;
    },
    async insertAdminIfAbsent(account) {
      calls.push("insert");
      inserted.push(account);
      return true;
    },
  };
  const dependencies: AdminBootstrapDependencies = {
    async hash(password) {
      calls.push("hash");
      assert.equal(password, input.password);
      return "fixture-only-password-hash";
    },
    now() {
      calls.push("clock");
      return instant;
    },
  };
  return { repository, dependencies, calls, inserted };
}

test("absent or empty passwords skip lookup, hashing, clock and persistence", async () => {
  for (const password of [undefined, null, ""]) {
    const { repository, dependencies, calls } = fixture();
    assert.deepEqual(await bootstrapAdmin({ ...input, password }, repository, dependencies), {
      status: "missing-password",
    });
    assert.deepEqual(calls, []);
  }
});

test("existing users and admins of every status remain untouched without hashing", async () => {
  for (const role of ["user", "admin"] as const) {
    for (const status of ["pending", "active", "denied", "disabled"] as const) {
      const existing = {
        id: "12345678-1234-4234-8234-123456789012",
        email: "sEeD@eXaMpLe.TeSt", name: "Preserved", passwordHash: "preserved-hash",
        role, status, approvedAt: null, approvedBy: "preserved-approver",
        requestNote: "preserved-note", createdAt: instant, updatedAt: instant,
      };
      const before = structuredClone(existing);
      const { repository, dependencies, calls, inserted } = fixture(existing);
      assert.deepEqual(await bootstrapAdmin(input, repository, dependencies), { status: "existing" });
      assert.deepEqual(existing, before);
      assert.deepEqual(calls, ["lookup:seed@example.test"]);
      assert.deepEqual(inserted, []);
    }
  }
});

test("new seeds forward the exact plaintext only to hashing and persist exact active admin evidence", async () => {
  const { repository, dependencies, calls, inserted } = fixture();
  const result = await bootstrapAdmin(input, repository, dependencies);
  assert.deepEqual(result, { status: "created" });
  assert.deepEqual(calls, ["lookup:seed@example.test", "hash", "clock", "insert"]);
  assert.deepEqual(inserted, [{
    email: input.email, name: input.name, passwordHash: "fixture-only-password-hash",
    role: "admin", status: "active", approvedAt: instant,
  }]);
  assert.notEqual(inserted[0]?.approvedAt, instant);
  assert.equal(instant.toISOString(), "2030-01-02T03:04:05.000Z");
  inserted[0]?.approvedAt.setTime(0);
  assert.equal(instant.toISOString(), "2030-01-02T03:04:05.000Z");
});

test("configured strings are not trimmed or subjected to registration validation", async () => {
  for (const email of ["", "not-an-email", " Seed@Example.test "]) {
    const { repository, dependencies, calls, inserted } = fixture();
    const password = " ";
    dependencies.hash = async (value) => {
      assert.equal(value, password);
      return "hash";
    };
    assert.deepEqual(await bootstrapAdmin({ email, name: "", password }, repository, dependencies), {
      status: "created",
    });
    assert.equal(calls[0], `lookup:${email.toLowerCase()}`);
    assert.equal(inserted[0]?.email, email);
    assert.equal(inserted[0]?.name, "");
  }
});

test("invalid and overflowing clocks throw before persistence", async () => {
  for (const value of [NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1]) {
    const { repository, dependencies, inserted } = fixture();
    await assert.rejects(bootstrapAdmin(input, repository, {
      ...dependencies, now: () => new Date(value),
    }), /Invalid admin bootstrap clock/);
    assert.deepEqual(inserted, []);
  }
});

test("lookup, hash, clock and write failures propagate unchanged", async () => {
  const failure = new Error("fixture unavailable");
  for (const stage of ["lookup", "hash", "clock", "insert"] as const) {
    const { repository, dependencies, inserted, calls } = fixture();
    if (stage === "lookup") repository.findByLowercaseEmail = async () => { throw failure; };
    if (stage === "hash") dependencies.hash = async () => { throw failure; };
    if (stage === "clock") dependencies.now = () => { throw failure; };
    if (stage === "insert") repository.insertAdminIfAbsent = async () => { throw failure; };
    await assert.rejects(bootstrapAdmin(input, repository, dependencies), (error) => error === failure);
    assert.deepEqual(inserted, []);
    if (stage === "lookup") assert.deepEqual(calls, []);
    if (stage === "hash") assert.deepEqual(calls, ["lookup:seed@example.test"]);
    if (stage === "clock") assert.deepEqual(calls, ["lookup:seed@example.test", "hash"]);
  }
});

test("concurrent first boots distinguish the single insert winner without leaking evidence", async () => {
  const { repository, dependencies } = fixture();
  let stored: BootstrapAdminAccount | undefined;
  repository.insertAdminIfAbsent = async (account) => {
    if (stored) return false;
    stored = account;
    return true;
  };
  const results = await Promise.all([
    bootstrapAdmin(input, repository, dependencies),
    bootstrapAdmin(input, repository, dependencies),
  ]);
  assert.deepEqual(results, [{ status: "created" }, { status: "existing" }]);
  assert.ok(stored);
  assert.equal(stored.passwordHash, "fixture-only-password-hash");
});
