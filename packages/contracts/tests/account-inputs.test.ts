import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountAccessRequestInputSchema,
  browserSignInInputSchema,
  type AccountAccessRequestInput,
  type BrowserSignInInput,
} from "../src/index";

const signIn: BrowserSignInInput = {
  email: "Listener@Example.com",
  password: " password ",
};
const accessRequest: AccountAccessRequestInput = {
  name: "Listener",
  email: signIn.email,
  password: " password ",
  confirm: " password ",
};

function emailOfLength(length: number) {
  return `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(length - 138)}.test.com`;
}

test("sign-in preserves credential text and strips navigation, secrets and unknown fields", () => {
  assert.deepEqual(browserSignInInputSchema.parse({
    ...signIn,
    next: "/app/settings",
    passwordHash: "secret",
    token: "secret",
    role: "admin",
    extra: true,
  }), signIn);
});

test("sign-in enforces exact source email and password boundaries without new password rules", () => {
  for (const password of ["a", " ", "a".repeat(200)]) {
    assert.equal(browserSignInInputSchema.parse({ ...signIn, password }).password, password);
  }
  for (const password of ["", "a".repeat(201)]) {
    assert.equal(browserSignInInputSchema.safeParse({ ...signIn, password }).success, false);
  }
  const email = emailOfLength(200);
  assert.equal(email.length, 200);
  assert.equal(browserSignInInputSchema.parse({ ...signIn, email }).email, email);
  for (const email of ["", "not-an-email", ` ${signIn.email}`, `${signIn.email} `, emailOfLength(201)]) {
    assert.equal(browserSignInInputSchema.safeParse({ ...signIn, email }).success, false);
  }
});

test("access request trims only name and note and strips unknown secrets", () => {
  assert.deepEqual(accountAccessRequestInputSchema.parse({
    ...accessRequest,
    name: "  Listener  ",
    note: "  Please approve. \n",
    website: "",
    next: "/app",
    passwordHash: "secret",
    token: "secret",
    status: "active",
  }), { ...accessRequest, note: "Please approve.", website: "" });
  assert.deepEqual(accountAccessRequestInputSchema.parse(accessRequest), accessRequest);
  assert.deepEqual(accountAccessRequestInputSchema.parse({ ...accessRequest, note: " \n " }), {
    ...accessRequest,
    note: "",
  });
});

test("access request enforces trimmed name and note limits", () => {
  for (const name of ["a", "a".repeat(80)]) {
    assert.equal(accountAccessRequestInputSchema.parse({ ...accessRequest, name: ` ${name} ` }).name, name);
  }
  for (const name of ["", " \n ", "a".repeat(81)]) {
    assert.equal(accountAccessRequestInputSchema.safeParse({ ...accessRequest, name }).success, false);
  }
  const note = "a".repeat(500);
  assert.equal(accountAccessRequestInputSchema.parse({ ...accessRequest, note: ` ${note} ` }).note, note);
  assert.equal(accountAccessRequestInputSchema.safeParse({ ...accessRequest, note: "a".repeat(501) }).success, false);
});

test("access request preserves email validation, case and exact maximum length", () => {
  const email = emailOfLength(200);
  assert.equal(accountAccessRequestInputSchema.parse({ ...accessRequest, email }).email, email);
  assert.equal(accountAccessRequestInputSchema.parse(accessRequest).email, signIn.email);
  for (const email of ["", "not-an-email", ` ${signIn.email}`, `${signIn.email} `, emailOfLength(201)]) {
    assert.equal(accountAccessRequestInputSchema.safeParse({ ...accessRequest, email }).success, false);
  }
});

test("access request keeps source password length policy without trimming or complexity rules", () => {
  for (const password of ["a".repeat(10), " ".repeat(10), "a".repeat(200)]) {
    const parsed = accountAccessRequestInputSchema.parse({ ...accessRequest, password, confirm: password });
    assert.equal(parsed.password, password);
    assert.equal(parsed.confirm, password);
  }
  for (const password of ["", "a".repeat(9), "a".repeat(201)]) {
    assert.equal(accountAccessRequestInputSchema.safeParse({
      ...accessRequest,
      password,
      confirm: password,
    }).success, false);
  }
});

test("access request preserves field messages and confirmation issue path", () => {
  for (const [field, value, message] of [
    ["name", " ", "Tell us your name."],
    ["email", "invalid", "Enter a valid email address."],
    ["password", "short", "Use at least 10 characters."],
    ["confirm", "different", "Passwords don't match."],
    ["confirm", "", "Passwords don't match."],
    ["confirm", `${accessRequest.password} `, "Passwords don't match."],
  ] as const) {
    const result = accountAccessRequestInputSchema.safeParse({ ...accessRequest, [field]: value });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.error.issues.some((issue) =>
        issue.path.length === 1 && issue.path[0] === field && issue.message === message));
    }
  }
});

test("access request accepts only an absent or empty honeypot without trimming", () => {
  assert.equal(accountAccessRequestInputSchema.safeParse({ ...accessRequest, website: "" }).success, true);
  for (const website of [" ", "https://example.com", null, 0, false]) {
    assert.equal(accountAccessRequestInputSchema.safeParse({ ...accessRequest, website }).success, false);
  }
});

test("inputs require source fields and reject non-string values without coercion or defaults", () => {
  for (const key of ["email", "password"] as const) {
    const missing: Partial<BrowserSignInInput> = { ...signIn };
    delete missing[key];
    assert.equal(browserSignInInputSchema.safeParse(missing).success, false);
    for (const value of [undefined, null, 123, false, {}, []]) {
      assert.equal(browserSignInInputSchema.safeParse({ ...signIn, [key]: value }).success, false);
    }
  }
  for (const key of ["name", "email", "password", "confirm"] as const) {
    const missing: Partial<AccountAccessRequestInput> = { ...accessRequest };
    delete missing[key];
    assert.equal(accountAccessRequestInputSchema.safeParse(missing).success, false);
    for (const value of [undefined, null, 123, false, {}, []]) {
      assert.equal(accountAccessRequestInputSchema.safeParse({ ...accessRequest, [key]: value }).success, false);
    }
  }
  for (const key of ["note", "website"] as const) {
    assert.equal(accountAccessRequestInputSchema.safeParse({ ...accessRequest, [key]: undefined }).success, true);
    for (const value of [null, 123, false, {}, []]) {
      assert.equal(accountAccessRequestInputSchema.safeParse({ ...accessRequest, [key]: value }).success, false);
    }
  }
  for (const value of [undefined, null, "", [], 123]) {
    assert.equal(browserSignInInputSchema.safeParse(value).success, false);
    assert.equal(accountAccessRequestInputSchema.safeParse(value).success, false);
  }
});
