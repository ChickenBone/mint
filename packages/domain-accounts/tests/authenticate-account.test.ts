import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAccountAuthenticator,
  type AuthenticationAccount,
  type AccountAuthenticationDependencies,
} from "../src/authenticate-account";

const email = "Member@Example.test";
const password = " unmodified-password ";
const ip = "192.0.2.1";
const account: AuthenticationAccount = {
  id: "12345678-1234-4234-8234-123456789012",
  email,
  name: " Member ",
  role: "user",
  status: "active",
  passwordHash: "private-persisted-hash",
};
const invalid = { error: "That email and password don't match an account.", status: 401 };
const unavailable = { error: "Sign-in is unavailable. Try again later.", status: 503 };
const limited = { error: "Too many attempts. Wait 15 minutes and try again.", status: 429 };
const waiting = {
  error: "Your request is still waiting for approval. You'll be able to sign in once an admin lets you in.",
  status: 403,
};
const forbidden = { error: "This account can't sign in. Contact the admin.", status: 403 };

function fixture(stored: AuthenticationAccount | null = account) {
  const events: unknown[][] = [];
  const logs: string[][] = [];
  const dependencies: AccountAuthenticationDependencies = {
    admission: {
      async allow(...args) {
        events.push(["admission", ...args]);
        return true;
      },
    },
    repository: {
      async findByLowercaseEmail(value) {
        events.push(["lookup", value]);
        return stored;
      },
    },
    passwords: {
      async hash(value) {
        events.push(["hash", value]);
        return "dummy-hash";
      },
      async verify(...args) {
        events.push(["verify", ...args]);
        return true;
      },
    },
    logger: {
      error(...args) {
        logs.push(args);
      },
    },
  };
  return { dependencies, events, logs };
}

test("admission runs IP20 then lowercased email8 over 900 seconds before lookup and verification", async () => {
  const { dependencies, events, logs } = fixture();
  await createAccountAuthenticator(dependencies)(email, password, ip);
  assert.deepEqual(events, [
    ["admission", `login:ip:${ip}`, 20, 900],
    ["admission", "login:email:member@example.test", 8, 900],
    ["lookup", "member@example.test"],
    ["verify", account.passwordHash, password],
  ]);
  assert.deepEqual(logs, []);
});

test("IP denial short-circuits email admission and all other work", async () => {
  const { dependencies, events } = fixture();
  dependencies.admission.allow = async (...args) => {
    events.push(["admission", ...args]);
    return false;
  };
  assert.deepEqual(await createAccountAuthenticator(dependencies)(email, password, ip), limited);
  assert.deepEqual(events, [["admission", `login:ip:${ip}`, 20, 900]]);
});

test("email denial short-circuits repository and password work", async () => {
  const { dependencies, events } = fixture();
  dependencies.admission.allow = async (...args) => {
    events.push(["admission", ...args]);
    return args[0].startsWith("login:ip:");
  };
  assert.deepEqual(await createAccountAuthenticator(dependencies)(email, password, ip), limited);
  assert.deepEqual(events, [
    ["admission", `login:ip:${ip}`, 20, 900],
    ["admission", "login:email:member@example.test", 8, 900],
  ]);
});

test("only lowercases email without trimming, validating or changing the password or IP", async () => {
  const { dependencies, events } = fixture();
  await createAccountAuthenticator(dependencies)(" Mixed@Example.test ", password, " ip ");
  assert.deepEqual(events, [
    ["admission", "login:ip: ip ", 20, 900],
    ["admission", "login:email: mixed@example.test ", 8, 900],
    ["lookup", " mixed@example.test "],
    ["verify", account.passwordHash, password],
  ]);
});

test("active users and admins return only a newly projected principal without mutating storage", async () => {
  for (const role of ["user", "admin"] as const) {
    const stored = Object.freeze({ ...account, role, requestNote: "private-note", sessionToken: "private-token" });
    const { dependencies } = fixture(stored);
    const result = await createAccountAuthenticator(dependencies)(email, password, ip);
    const { id, name, status } = account;
    assert.deepEqual(result, { principal: { id, email, name, role, status } });
    assert.ok("principal" in result);
    assert.notEqual(result.principal, stored);
    assert.deepEqual(Object.keys(result.principal).sort(), ["email", "id", "name", "role", "status"]);
    assert.ok(!JSON.stringify(result).includes("private-"));
  }
});

test("wrong password and nonexistent accounts return identical 401 results", async () => {
  for (const stored of [account, null]) {
    const { dependencies, events, logs } = fixture(stored);
    dependencies.passwords.verify = async (...args) => {
      events.push(["verify", ...args]);
      return false;
    };
    assert.deepEqual(await createAccountAuthenticator(dependencies)(email, password, ip), invalid);
    assert.deepEqual(events.filter(([event]) => event === "verify"), [
      ["verify", stored ? account.passwordHash : "dummy-hash", password],
    ]);
    assert.deepEqual(events.filter(([event]) => event === "hash"),
      stored ? [] : [["hash", "mint-timing-equaliser"]]);
    assert.deepEqual(logs, []);
  }
});

test("a missing account never authenticates even if dummy verification returns true", async () => {
  const { dependencies } = fixture(null);
  assert.deepEqual(await createAccountAuthenticator(dependencies)(email, password, ip), invalid);
});

test("dummy hashing is cached per authenticator instance, not across instances", async () => {
  const { dependencies, events } = fixture(null);
  const authenticate = createAccountAuthenticator(dependencies);
  await authenticate(email, password, ip);
  await authenticate(email, password, ip);
  assert.equal(events.filter(([event]) => event === "hash").length, 1);
  assert.equal(events.filter(([event]) => event === "verify").length, 2);

  const other = fixture(null);
  other.dependencies.passwords.hash = async (value) => {
    other.events.push(["hash", value]);
    return "other-dummy-hash";
  };
  await createAccountAuthenticator(other.dependencies)(email, password, ip);
  assert.deepEqual(other.events.filter(([event]) => event === "verify"), [
    ["verify", "other-dummy-hash", password],
  ]);
  assert.equal(other.events.filter(([event]) => event === "hash").length, 1);
});

test("concurrent missing-account attempts share the in-flight dummy hash", async () => {
  const { dependencies, events } = fixture(null);
  let resolveHash!: (value: string) => void;
  const hashing = new Promise<string>((resolve) => { resolveHash = resolve; });
  dependencies.passwords.hash = (value) => {
    events.push(["hash", value]);
    return hashing;
  };
  const authenticate = createAccountAuthenticator(dependencies);
  const attempts = [authenticate(email, password, ip), authenticate(email, password, ip)];
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events.filter(([event]) => event === "lookup").length, 2);
  assert.equal(events.filter(([event]) => event === "hash").length, 1);
  assert.equal(events.filter(([event]) => event === "verify").length, 0);
  resolveHash("shared-dummy-hash");
  assert.deepEqual(await Promise.all(attempts), [invalid, invalid]);
  assert.deepEqual(events.filter(([event]) => event === "hash"), [["hash", "mint-timing-equaliser"]]);
  assert.deepEqual(events.filter(([event]) => event === "verify"), [
    ["verify", "shared-dummy-hash", password],
    ["verify", "shared-dummy-hash", password],
  ]);
});

test("pending, denied and disabled accounts retain their exact 403 messages for both roles", async () => {
  for (const role of ["user", "admin"] as const) {
    for (const status of ["pending", "denied", "disabled"] as const) {
      const { dependencies, events } = fixture(Object.freeze({ ...account, role, status }));
      assert.deepEqual(await createAccountAuthenticator(dependencies)(email, password, ip),
        status === "pending" ? waiting : forbidden);
      assert.deepEqual(events.at(-1), ["verify", account.passwordHash, password]);
    }
  }
});

test("wrong passwords precede approval status checks", async () => {
  for (const status of ["pending", "denied", "disabled"] as const) {
    const { dependencies } = fixture({ ...account, status });
    dependencies.passwords.verify = async () => false;
    assert.deepEqual(await createAccountAuthenticator(dependencies)(email, password, ip), invalid);
  }
});

test("verification failures return 503 and log only the error name for existing and missing users", async () => {
  for (const stored of [account, null]) {
    const { dependencies, logs } = fixture(stored);
    dependencies.passwords.verify = async () => {
      throw new TypeError(`${email} ${password} ${ip} ${account.passwordHash}`);
    };
    assert.deepEqual(await createAccountAuthenticator(dependencies)(email, password, ip), unavailable);
    assert.deepEqual(logs, [["[auth] password verification failed", "TypeError"]]);
  }
});

test("non-Error password failures log only the source fallback", async () => {
  const { dependencies, logs } = fixture();
  dependencies.passwords.verify = async () => { throw { password, email, ip }; };
  assert.deepEqual(await createAccountAuthenticator(dependencies)(email, password, ip), unavailable);
  assert.deepEqual(logs, [["[auth] password verification failed", "Unknown failure"]]);
});

test("dummy hash rejection returns 503, logs safely and remains cached for later attempts", async () => {
  const { dependencies, events, logs } = fixture(null);
  dependencies.passwords.hash = async (value) => {
    events.push(["hash", value]);
    throw new RangeError(`${email} ${password} ${ip} private-hash`);
  };
  const authenticate = createAccountAuthenticator(dependencies);
  assert.deepEqual(await authenticate(email, password, ip), unavailable);
  assert.deepEqual(await authenticate(email, password, ip), unavailable);
  assert.equal(events.filter(([event]) => event === "hash").length, 1);
  assert.equal(events.filter(([event]) => event === "verify").length, 0);
  assert.deepEqual(logs, [
    ["[auth] password verification failed", "RangeError"],
    ["[auth] password verification failed", "RangeError"],
  ]);
});

test("synchronous password port failures are also explicit 503 results", async () => {
  for (const operation of ["hash", "verify"] as const) {
    const { dependencies, logs } = fixture(null);
    dependencies.passwords[operation] = () => { throw new Error("private failure"); };
    assert.deepEqual(await createAccountAuthenticator(dependencies)(email, password, ip), unavailable);
    assert.deepEqual(logs, [["[auth] password verification failed", "Error"]]);
  }
});

test("repository failures propagate unchanged without password work or password-failure logging", async () => {
  const { dependencies, events, logs } = fixture();
  const failure = new Error("repository unavailable");
  dependencies.repository.findByLowercaseEmail = async () => { throw failure; };
  await assert.rejects(createAccountAuthenticator(dependencies)(email, password, ip), (error) => error === failure);
  assert.equal(events.filter(([event]) => event === "hash" || event === "verify").length, 0);
  assert.deepEqual(logs, []);
});

test("IP and email admission failures propagate unchanged and stop subsequent work", async () => {
  for (const stage of ["ip", "email"]) {
    const { dependencies, events, logs } = fixture();
    const failure = new Error("admission unavailable");
    dependencies.admission.allow = async (...args) => {
      events.push(["admission", ...args]);
      if (args[0].startsWith(`login:${stage}:`)) throw failure;
      return true;
    };
    await assert.rejects(createAccountAuthenticator(dependencies)(email, password, ip), (error) => error === failure);
    assert.equal(events.length, stage === "ip" ? 1 : 2);
    assert.deepEqual(logs, []);
  }
});
