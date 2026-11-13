import assert from "node:assert/strict";
import { test } from "node:test";
import { accountPrincipalSchema, accountRoleSchema, accountStatusSchema, decideAccessRequestInputSchema } from "../src/index";

const principal = {
  id: "12345678-1234-4234-8234-123456789012",
  email: "listener@example.com",
  name: "Listener",
  role: "user",
  status: "active",
};

test("decision input accepts only a GUID target and a boolean decision", () => {
  for (const approve of [true, false]) {
    assert.deepEqual(decideAccessRequestInputSchema.parse({ userId: principal.id, approve }), {
      userId: principal.id, approve,
    });
  }
  for (const value of [
    {}, null, { userId: "invalid", approve: true }, { userId: principal.id, approve: "true" },
    { userId: principal.id }, { approve: false },
    { userId: principal.id, approve: true, actor: principal },
    { userId: principal.id, approve: true, role: "admin" },
  ]) {
    assert.equal(decideAccessRequestInputSchema.safeParse(value).success, false);
  }
});

test("account role and status accept exactly the existing enum values", () => {
  for (const role of ["user", "admin"]) assert.equal(accountRoleSchema.parse(role), role);
  for (const status of ["pending", "active", "denied", "disabled"]) {
    assert.equal(accountStatusSchema.parse(status), status);
  }
  for (const value of ["", "member", "USER", null, undefined, 1, {}, ["user"]]) {
    assert.equal(accountRoleSchema.safeParse(value).success, false);
  }
  for (const value of ["", "approved", "ACTIVE", null, undefined, 1, {}, ["active"]]) {
    assert.equal(accountStatusSchema.safeParse(value).success, false);
  }
});

test("principal returns only its declared fields and strips secrets and unknown fields", () => {
  assert.deepEqual(accountPrincipalSchema.parse({
    ...principal,
    passwordHash: "secret",
    token: "secret",
    ip: "private",
    userAgent: "private",
    extra: true,
  }), principal);
});

test("principal preserves all roles, statuses and unmodified database text", () => {
  for (const role of ["user", "admin"]) {
    for (const status of ["pending", "active", "denied", "disabled"]) {
      const value = { ...principal, role, status, email: " Not validated ", name: "  " };
      assert.deepEqual(accountPrincipalSchema.parse(value), value);
    }
  }
  const nilUuid = { ...principal, id: "00000000-0000-0000-0000-000000000000" };
  assert.deepEqual(accountPrincipalSchema.parse(nilUuid), nilUuid);
  assert.deepEqual(decideAccessRequestInputSchema.parse({
    userId: nilUuid.id,
    approve: true,
  }), { userId: nilUuid.id, approve: true });
});

test("principal requires UUID and all fields without coercion or defaults", () => {
  for (const id of ["", "not-a-uuid", "12345678-1234-4234-8234-12345678901g", 123, null]) {
    assert.equal(accountPrincipalSchema.safeParse({ ...principal, id }).success, false);
  }
  for (const key of ["id", "email", "name", "role", "status"] as const) {
    const missing: Partial<typeof principal> = { ...principal };
    delete missing[key];
    assert.equal(accountPrincipalSchema.safeParse(missing).success, false);
    assert.equal(accountPrincipalSchema.safeParse({ ...principal, [key]: undefined }).success, false);
    assert.equal(accountPrincipalSchema.safeParse({ ...principal, [key]: null }).success, false);
  }
  for (const key of ["email", "name"] as const) {
    assert.equal(accountPrincipalSchema.safeParse({ ...principal, [key]: 123 }).success, false);
  }
  assert.equal(accountPrincipalSchema.safeParse({ ...principal, role: "member" }).success, false);
  assert.equal(accountPrincipalSchema.safeParse({ ...principal, status: "approved" }).success, false);
});
