import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountAccessRequestInput } from "@mint/contracts";
import {
  createAccountAccessRequester,
  type AccountAccessRequestDependencies,
  type AuthenticationAccount,
} from "../src/index";

const input: AccountAccessRequestInput = {
  name: " Requester ",
  email: "Requester@Example.test",
  password: " untouched password ",
  confirm: " untouched password ",
  note: " A request note \n",
  website: "",
};
const ip = "192.0.2.1";
const admission = ["admission", `request:ip:${ip}`, 5, 3600];
const lookup = ["lookup", "requester@example.test"];
const storedAccount: AuthenticationAccount = {
  id: "12345678-1234-4234-8234-123456789012",
  name: "Original",
  email: input.email,
  passwordHash: "private-original-hash",
  role: "user",
  status: "pending",
};
const pendingAccount = {
  name: "Requester",
  email: input.email,
  passwordHash: "fixture-password-hash",
  requestNote: "A request note",
};

function fixture(stored: AuthenticationAccount | null = null, inserted = true) {
  const events: unknown[][] = [];
  const dependencies: AccountAccessRequestDependencies = {
    admission: {
      async allow(...args) {
        events.push(["admission", ...args]);
        return true;
      },
    },
    repository: {
      async findByLowercaseEmail(email) {
        events.push(["lookup", email]);
        return stored;
      },
      async insertPendingIfAbsent(account) {
        events.push(["insert", account]);
        return inserted;
      },
      async countPending() {
        events.push(["count"]);
        return 7;
      },
    },
    async hash(password) {
      events.push(["hash", password]);
      return "fixture-password-hash";
    },
    async notify(notification) {
      events.push(["notify", notification]);
    },
  };
  return { events, dependencies };
}

test("validates all fields before admission or any other effect, retaining exact messages", async () => {
  const { events, dependencies } = fixture();
  assert.deepEqual(await createAccountAccessRequester(dependencies)({
    name: " \n ", email: "invalid", password: "short", confirm: "different",
    note: "a".repeat(501), website: "bot",
  }, ip), {
    fieldErrors: {
      name: "Tell us your name.",
      email: "Enter a valid email address.",
      password: "Use at least 10 characters.",
      confirm: "Passwords don't match.",
      note: "Too big: expected string to have <=500 characters",
      website: "Too big: expected string to have <=0 characters",
    },
  });
  assert.deepEqual(events, []);
});

test("validates length bounds and returns the first issue per field without effects", async () => {
  for (const [field, value, message] of [
    ["name", "a".repeat(81), "Too big: expected string to have <=80 characters"],
    ["email", `${"a".repeat(50)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(40)}.test`,
      "Enter a valid email address."],
    ["password", "a".repeat(201), "Too big: expected string to have <=200 characters"],
    ["confirm", "other-password", "Passwords don't match."],
    ["email", "", "Enter a valid email address."],
  ] as const) {
    const { events, dependencies } = fixture();
    const valueInput = { ...input, [field]: value };
    if (field === "password") valueInput.confirm = value;
    assert.deepEqual(await createAccountAccessRequester(dependencies)(valueInput, ip), {
      fieldErrors: { [field]: message },
    });
    assert.deepEqual(events, []);
  }
});

test("rejects malformed runtime input without effects or echoing private input", async () => {
  for (const value of [
    null, undefined, {}, { ...input, password: null }, { ...input, website: null },
    { ...input, note: 12 }, { ...input, name: undefined },
  ]) {
    const { events, dependencies } = fixture();
    const result = await createAccountAccessRequester(dependencies)(value as AccountAccessRequestInput, ip);
    assert.ok("fieldErrors" in result);
    assert.deepEqual(Object.keys(result), ["fieldErrors"]);
    assert.ok(Object.values(result.fieldErrors).every((message) => typeof message === "string"));
    assert.deepEqual(events, []);
  }
});

test("does not trim email into a valid address", async () => {
  for (const email of [` ${input.email}`, `${input.email} `]) {
    const { events, dependencies } = fixture();
    assert.deepEqual(await createAccountAccessRequester(dependencies)({ ...input, email }, ip), {
      fieldErrors: { email: "Enter a valid email address." },
    });
    assert.deepEqual(events, []);
  }
});

test("IP admission uses the explicit unchanged IP, exact limit/window and denial message", async () => {
  const { events, dependencies } = fixture();
  dependencies.admission.allow = async (...args) => {
    events.push(["admission", ...args]);
    return false;
  };
  assert.deepEqual(await createAccountAccessRequester(dependencies)(input, " ip "), {
    error: "Too many requests from your network. Try again in an hour.",
  });
  assert.deepEqual(events, [["admission", "request:ip: ip ", 5, 3600]]);
});

test("new requests hash only the unchanged password, store the precise fields and notify after counting", async () => {
  const { events, dependencies } = fixture();
  const original = { ...input };
  assert.deepEqual(await createAccountAccessRequester(dependencies)(Object.freeze(original), ip), { ok: true });
  assert.deepEqual(original, input);
  assert.deepEqual(events, [
    admission, lookup, ["hash", input.password], ["insert", pendingAccount],
    ["count"], ["notify", { pending: 7 }],
  ]);
});

test("omitted, empty and whitespace-only notes become null, never empty strings", async () => {
  for (const note of [undefined, "", " \n "]) {
    const { events, dependencies } = fixture();
    assert.deepEqual(await createAccountAccessRequester(dependencies)({ ...input, note }, ip), { ok: true });
    assert.deepEqual(events.find(([event]) => event === "insert"), [
      "insert", { ...pendingAccount, requestNote: null },
    ]);
  }
});

test("accepts optional honeypot/note and trims name and note before their length checks", async () => {
  const { events, dependencies } = fixture();
  const name = "n".repeat(80);
  const note = "n".repeat(500);
  assert.deepEqual(await createAccountAccessRequester(dependencies)({
    ...input, name: ` ${name} `, note: ` ${note}\n `, website: undefined,
  }, ip), { ok: true });
  assert.deepEqual(events.find(([event]) => event === "insert"), [
    "insert", { ...pendingAccount, name, requestNote: note },
  ]);
});

test("all existing roles and statuses return only success without hashing, inserting or notifying", async () => {
  for (const role of ["user", "admin"] as const) {
    for (const status of ["pending", "active", "denied", "disabled"] as const) {
      const stored = Object.freeze({ ...storedAccount, role, status });
      const { events, dependencies } = fixture(stored);
      assert.deepEqual(await createAccountAccessRequester(dependencies)(input, ip), { ok: true });
      assert.deepEqual(events, [admission, lookup]);
      assert.deepEqual(stored, { ...storedAccount, role, status });
    }
  }
});

test("a concurrent duplicate insert is ordinary success without counting or notifying", async () => {
  const { events, dependencies } = fixture(null, false);
  assert.deepEqual(await createAccountAccessRequester(dependencies)(input, ip), { ok: true });
  assert.deepEqual(events, [admission, lookup, ["hash", input.password], ["insert", pendingAccount]]);
});

test("successful output does not enumerate existence, collision or account details", async () => {
  for (const [stored, inserted] of [[storedAccount, false], [null, true], [null, false]] as const) {
    const { dependencies } = fixture(stored, inserted);
    const result = await createAccountAccessRequester(dependencies)(input, ip);
    assert.deepEqual(result, { ok: true });
    assert.equal(JSON.stringify(result), '{"ok":true}');
  }
});

test("awaits notification completion before returning success", async () => {
  const { dependencies, events } = fixture();
  let release!: () => void;
  const notification = new Promise<void>((resolve) => { release = resolve; });
  dependencies.notify = async (value) => {
    events.push(["notify", value]);
    await notification;
  };
  let completed = false;
  const result = createAccountAccessRequester(dependencies)(input, ip).then((value) => {
    completed = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events.at(-1), ["notify", { pending: 7 }]);
  assert.equal(completed, false);
  release();
  assert.deepEqual(await result, { ok: true });
});

test("admission, lookup, hash, storage, count and notification failures propagate without later effects", async () => {
  const expected = [
    admission, lookup, ["hash", input.password], ["insert", pendingAccount], ["count"], ["notify", { pending: 7 }],
  ];
  for (const [index, stage] of ["admission", "lookup", "hash", "insert", "count", "notify"].entries()) {
    const { dependencies, events } = fixture();
    const failure = new Error(`fixture ${stage} failure`);
    const reject = async () => { throw failure; };
    if (stage === "admission") dependencies.admission.allow = reject;
    if (stage === "lookup") dependencies.repository.findByLowercaseEmail = reject;
    if (stage === "hash") dependencies.hash = reject;
    if (stage === "insert") dependencies.repository.insertPendingIfAbsent = reject;
    if (stage === "count") dependencies.repository.countPending = reject;
    if (stage === "notify") dependencies.notify = reject;
    await assert.rejects(createAccountAccessRequester(dependencies)(input, ip), (error) => error === failure);
    assert.deepEqual(events, expected.slice(0, index));
  }
});

test("notification failure leaves the inserted request intact and a retry does not notify again", async () => {
  const { dependencies, events } = fixture();
  let stored: AuthenticationAccount | null = null;
  dependencies.repository.findByLowercaseEmail = async (email) => {
    events.push(["lookup", email]);
    return stored;
  };
  dependencies.repository.insertPendingIfAbsent = async (account) => {
    events.push(["insert", account]);
    stored = { ...storedAccount, ...account };
    return true;
  };
  const failure = new Error("fixture notification unavailable");
  dependencies.notify = async () => { throw failure; };
  const request = createAccountAccessRequester(dependencies);
  await assert.rejects(request(input, ip), (error) => error === failure);
  assert.notEqual(stored, null);
  events.length = 0;
  assert.deepEqual(await request(input, ip), { ok: true });
  assert.deepEqual(events, [admission, lookup]);
});
