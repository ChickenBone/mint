import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import test, { type TestContext } from "node:test";
import { GATEWAY_TOKEN_HEADER_NAME, type AccountPrincipal } from "@mint/contracts";
import type { PendingAccessDecision, SessionEvidence, SessionLookupRepository } from "@mint/domain-accounts";
import { createApiServer } from "../src/index";

const now = new Date("2026-11-12T12:00:00Z");
const token = "browser_session_token-0123456789";
const gatewayToken = "gateway_fixture_".padEnd(42, "_") + "A";
const gatewayHeaders = { [GATEWAY_TOKEN_HEADER_NAME]: gatewayToken };
const principal: AccountPrincipal = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "listener@example.test",
  name: "Listener",
  role: "user",
  status: "active",
};
const future = () => new Date(now.getTime() + 60_000);
const tokenHash = createHash("sha256").update(token).digest("hex");
const target = "00000000-0000-4000-8000-000000000002";

function fixture(t: TestContext, initial: SessionEvidence | null = {
  principal: { ...principal }, expiresAt: future(),
}) {
  const state = {
    evidence: initial,
    hashes: [] as string[],
    failure: null as Error | null,
    errors: [] as { name: string }[],
    accounts: new Map<string, { status: string; approvedAt?: Date; approvedBy?: string }>(),
    decisions: [] as { userId: string; decision: PendingAccessDecision }[],
    notifications: [] as number[],
    decisionFailure: null as Error | null,
    countFailure: null as Error | null,
    notifyFailure: null as Error | null,
  };
  const sessions: SessionLookupRepository = {
    async findByTokenHash(hash) {
      state.hashes.push(hash);
      if (state.failure) throw state.failure;
      return hash === tokenHash ? state.evidence : null;
    },
  };
  const app = createApiServer({
    gatewayToken,
    sessions,
    decisions: {
      async decidePendingAccess(input) {
        if (state.decisionFailure) throw state.decisionFailure;
        state.decisions.push(input);
        const account = state.accounts.get(input.userId);
        if (account?.status === "pending") Object.assign(account, input.decision);
      },
      async countPending() {
        if (state.countFailure) throw state.countFailure;
        return [...state.accounts.values()].filter((account) => account.status === "pending").length;
      },
    },
    async notifyAccessRequests({ pending }) {
      if (state.notifyFailure) throw state.notifyFailure;
      state.notifications.push(pending);
    },
    now: () => now,
    errors: { error: (event) => { state.errors.push(event); } },
  });
  t.after(async () => {
    await app.close();
    assert.equal(app.server.listening, false);
  });
  const query = async (cookie: string | string[] | undefined = `mint_session=${token}`,
    headers: Record<string, string> = {}) => {
    const response = await app.inject({
      method: "GET", url: "/trpc/accounts.session",
      headers: { ...gatewayHeaders, ...headers, ...(cookie === undefined ? {} : { cookie }) },
    });
    assert.equal(response.headers["cache-control"], "private, no-store");
    return response;
  };
  return { app, state, query };
}

test("official Fastify tRPC wire returns only the five validated principal fields", async (t) => {
  const { query, state } = fixture(t);
  for (const role of ["user", "admin"] as const) {
    state.evidence = {
      expiresAt: future(),
      principal: {
        ...principal, role,
        ...{ passwordHash: "secret-hash", token, tokenHash, sessionId: "private-session" },
      },
    };
    const response = await query(`unrelated=ignored; mint_session=${token}; preference=dark`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { result: { data: { ...principal, role } } });
  }
  assert.deepEqual(state.hashes, [tokenHash, tokenHash]);
  assert.deepEqual(state.errors, []);
});

test("absent and unknown sessions cannot use bearer or principal headers as authentication", async (t) => {
  const { query, state } = fixture(t);
  const headers = {
    authorization: `Bearer ${token}`,
    "x-user-id": principal.id, "x-user-role": "admin", "x-user-status": "active",
    "x-mint-principal": JSON.stringify(principal),
    "x-forwarded-user": principal.id,
  };
  // An empty header is used here because query's default argument is the valid cookie.
  for (const cookie of ["", "other_cookie=value", "mint_session=unknown"]) {
    const response = await query(cookie, headers);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { result: { data: null } });
  }
  assert.equal(state.hashes.length, 1);
  assert.deepEqual((await query(`mint_session=${token}`, headers)).json(), {
    result: { data: principal },
  });
  assert.equal(state.hashes.length, 2);
  const { app } = fixture(t);
  const absent = await app.inject({
    method: "GET", url: "/trpc/accounts.session", headers: { ...gatewayHeaders, ...headers },
  });
  assert.equal(absent.headers["cache-control"], "private, no-store");
  assert.deepEqual(absent.json(), { result: { data: null } });
});

test("malformed, ambiguous, native and oversized cookies fail closed before lookup", async (t) => {
  const { query, state } = fixture(t);
  for (const cookie of [
    "mint_session=",
    `mint_session=${token}; mint_session=${token}`,
    `mint_session=${token}; mint_session=`,
    `mint_session=${token}; mint_session =unknown`,
    [`mint_session=${token}`, "mint_session=unknown"],
    `mint_session= ${token}`,
    `mint_session=${token} `,
    `mint_session="${token}"`,
    `mint_session=%62${token}`,
    "mint_session=%ZZ",
    "mint_session=mn1.native-session",
    `mint_session=${token}=`,
    `mint_session=${token}; broken`,
    `mint_session=${"x".repeat(513)}`,
    `large=${"x".repeat(8192)}; mint_session=${token}`,
  ]) {
    const response = await query(cookie);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { result: { data: null } }, String(cookie).slice(0, 100));
  }
  assert.deepEqual(state.hashes, []);
});

test("expiry boundaries and non-active approvals remain anonymous", async (t) => {
  const { query, state } = fixture(t);
  for (const status of ["pending", "denied", "disabled"] as const) {
    state.evidence = { expiresAt: future(), principal: { ...principal, status } };
    assert.deepEqual((await query()).json(), { result: { data: null } });
  }
  for (const expiresAt of [new Date(now.getTime() - 1), now]) {
    state.evidence = { expiresAt, principal };
    assert.deepEqual((await query()).json(), { result: { data: null } });
  }
  assert.equal(state.hashes.length, 5);
});

test("subsequent requests re-read persisted identity, role, status, expiry and revocation", async (t) => {
  const { query, state } = fixture(t);
  assert.deepEqual((await query()).json(), { result: { data: principal } });
  const changed: AccountPrincipal = {
    ...principal, id: "00000000-0000-4000-8000-000000000002",
    name: "Updated", email: "updated@example.test", role: "admin",
  };
  state.evidence = { expiresAt: future(), principal: changed };
  assert.deepEqual((await query()).json(), { result: { data: changed } });
  state.evidence = { expiresAt: future(), principal: { ...changed, status: "disabled" } };
  assert.deepEqual((await query()).json(), { result: { data: null } });
  state.evidence = { expiresAt: now, principal: changed };
  assert.deepEqual((await query()).json(), { result: { data: null } });
  state.evidence = { expiresAt: future(), principal: changed };
  assert.deepEqual((await query()).json(), { result: { data: changed } });
  state.evidence = null;
  assert.deepEqual((await query()).json(), { result: { data: null } });
  assert.deepEqual(state.hashes, Array(6).fill(tokenHash));
});

test("repository failures are sanitized internal errors, never anonymous successes", async (t) => {
  const { query, state } = fixture(t);
  for (const name of ["TypeError", "secret-error-name"]) {
    const failure = new Error("SELECT password_hash FROM sessions; secret-connection-url");
    failure.name = name;
    state.failure = failure;
    const response = await query();
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), {
      error: {
        message: "Internal server error", code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
      },
    });
    assert.doesNotMatch(response.body, /SELECT|password|secret|stack|token|cookie/);
  }
  assert.deepEqual(state.errors, [{ name: "TypeError" }, { name: "Error" }]);
});

test("invalid repository principals are rejected by the runtime output schema", async (t) => {
  const { query, state } = fixture(t, {
    expiresAt: future(), principal: { ...principal, id: "not-a-guid" },
  });
  const response = await query();
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.message, "Internal server error");
  assert.doesNotMatch(response.body, /not-a-guid|stack|issues/);
  assert.equal(state.errors.length, 1);
});

test("query-only transport errors are private and do not enable CORS or issue cookies", async (t) => {
  const { app, state } = fixture(t);
  for (const options of [
    { method: "POST" as const, url: "/trpc/accounts.session" },
    { method: "DELETE" as const, url: "/trpc/accounts.session" },
    { method: "POST" as const, url: "/trpc/accounts.session",
      headers: { "content-type": "application/json" }, payload: "{secret-malformed-json" },
  ]) {
    const response = await app.inject({
      ...options, headers: { ...gatewayHeaders, ...options.headers },
    });
    assert.ok(response.statusCode >= 400);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal(response.headers["access-control-allow-credentials"], undefined);
    assert.equal(response.headers["set-cookie"], undefined);
    assert.doesNotMatch(response.body, /stack|secret-malformed-json/);
  }
  assert.deepEqual(state.hashes, []);
});

test("API construction requires a canonical explicitly injected gateway credential without leaking it", () => {
  for (const gatewayToken of [
    undefined, null, 123, {}, "", token, "A".repeat(42), "A".repeat(44),
    "A".repeat(42) + "B", "A".repeat(43) + "\n", "mn1.native-session",
    "secret-malformed-configuration",
  ]) {
    assert.throws(() => createApiServer({
      gatewayToken: gatewayToken as string,
      sessions: { async findByTokenHash() { assert.fail("must not query"); } },
      decisions: { async decidePendingAccess() {}, async countPending() { return 0; } },
      async notifyAccessRequests() {},
      errors: { error() { assert.fail("must not log configuration"); } },
    }), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Invalid API gateway configuration.");
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error), "{}");
      return true;
    });
  }
});

test("missing, wrong and malformed service credentials never reach repositories or error logging", async (t) => {
  const { app, state } = fixture(t);
  const attempts = [
    {},
    { authorization: `Bearer ${gatewayToken}` },
    { cookie: `mint_session=${gatewayToken}` },
    ...[
      "", token, "B".repeat(42) + "A", gatewayToken + "=", `"${gatewayToken}"`,
      ` ${gatewayToken}`, `${gatewayToken} `, `${gatewayToken}\n`, `${gatewayToken}\r\n`,
      `%67${gatewayToken.slice(1)}`, "mn1." + gatewayToken,
      gatewayToken.slice(0, -1) + "B", "A".repeat(42), "A".repeat(44),
      gatewayToken + ", " + gatewayToken,
    ].map((value) => ({ [GATEWAY_TOKEN_HEADER_NAME]: value })),
  ];
  state.failure = new Error(`repository must not expose ${gatewayToken}`);
  for (const headers of attempts) {
    const response = await app.inject({
      method: "GET", url: "/trpc/accounts.session",
      headers: { cookie: `mint_session=${token}`, ...headers },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "Unauthorized" });
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.ok(!JSON.stringify(response.headers).includes(gatewayToken));
    assert.ok(!response.body.includes(gatewayToken));
    assert.ok(!response.body.includes(token));
  }
  assert.deepEqual(state.hashes, []);
  assert.deepEqual(state.errors, []);
});

test("exactly one raw service header is required even for identical or mixed-case duplicates", async (t) => {
  const { app, state } = fixture(t);
  for (const headers of [
    { [GATEWAY_TOKEN_HEADER_NAME]: [gatewayToken, gatewayToken] },
    { [GATEWAY_TOKEN_HEADER_NAME]: [gatewayToken, ""] },
    { [GATEWAY_TOKEN_HEADER_NAME]: ["wrong", gatewayToken] },
  ]) {
    const response = await app.inject({
      method: "GET", url: "/trpc/accounts.session",
      headers: { cookie: `mint_session=${token}`, ...headers },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "Unauthorized" });
    assert.equal(response.headers["cache-control"], "private, no-store");
  }
  const valid = await app.inject({
    method: "GET", url: "/trpc/accounts.session",
    headers: { "X-Mint-Gateway-Token": gatewayToken, cookie: `mint_session=${token}` },
  });
  assert.deepEqual(valid.json(), { result: { data: principal } });
  assert.deepEqual(state.hashes, [tokenHash]);
  assert.deepEqual(state.errors, []);

  // inject normalizes differently cased object keys, so exercise actual HTTP raw headers too.
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  for (const first of [gatewayToken, "wrong"]) {
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${address}/trpc/accounts.session`, {
        headers: [
          GATEWAY_TOKEN_HEADER_NAME, first, "X-Mint-Gateway-Token", gatewayToken,
          "Cookie", `mint_session=${token}`, "Host", new URL(address).host,
        ],
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("error", reject);
        response.on("end", () => {
          try {
            assert.equal(response.statusCode, 401);
            assert.equal(response.headers["cache-control"], "private, no-store");
            assert.deepEqual(JSON.parse(body), { error: "Unauthorized" });
            resolve();
          } catch (error) { reject(error); }
        });
      });
      request.on("error", reject);
      request.end();
    });
  }
  assert.deepEqual(state.hashes, [tokenHash]);
  assert.deepEqual(state.errors, []);
});

test("service authentication precedes method, procedure, batch, path and payload handling", async (t) => {
  const { app, state } = fixture(t);
  for (const url of [
    "/trpc/accounts.session", "/trpc/accounts.session/", "/trpc",
    "/trpc/", "/trpc/accounts.unknown", "/trpc/unknown",
    "/trpc/accounts.session?input=%7B%7D",
    "/trpc/accounts.session,accounts.session?batch=1",
    "/%74rpc/accounts.session", "/trpc/%61ccounts.session",
    "/trpc%2Faccounts.session", "/trpc/accounts%2Esession",
    "/trpc/%2561ccounts.session", "/trpc/%", "/trpc/%FF",
    "/trpc/" + "a".repeat(1024), "/unregistered",
  ]) {
    for (const method of ["GET", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "PUT", "TRACE", "BREW"] as const) {
      const response = await app.inject({
        method, url, validate: false,
        headers: { cookie: `mint_session=${token}`, "content-type": "application/json" },
        ...(method === "POST" ? { payload: "{malformed-secret-input" } : {}),
      });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
      assert.equal(response.headers["cache-control"], "private, no-store");
      if (method !== "HEAD" || response.body !== "") {
        assert.equal(response.body, '{"error":"Unauthorized"}');
      }
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
  }
  assert.deepEqual(state.hashes, []);
  assert.deepEqual(state.errors, []);
});

test("a service credential is not user identity and forwarded identity/IP never authorizes", async (t) => {
  const { query, state } = fixture(t);
  for (const cookie of ["", "mint_session=mn1.native", `mint_session=${gatewayToken}`]) {
    const response = await query(cookie, {
      "x-forwarded-for": "203.0.113.1", "x-real-ip": "203.0.113.2",
      forwarded: "for=203.0.113.3", "x-user-role": "admin", "x-user-id": principal.id,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { result: { data: null } });
  }
  assert.deepEqual(state.hashes, [createHash("sha256").update(gatewayToken).digest("hex")]);
  assert.deepEqual(state.errors, []);
});

test("authenticated batches resolve each persisted session and invalid router paths stay private", async (t) => {
  const { app, state } = fixture(t);
  const response = await app.inject({
    method: "GET", url: "/trpc/accounts.session,accounts.session?batch=1",
    headers: { ...gatewayHeaders, cookie: `mint_session=${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json(), [
    { result: { data: principal } }, { result: { data: principal } },
  ]);
  assert.deepEqual(state.hashes, [tokenHash, tokenHash]);
  for (const url of ["/trpc/%", "/trpc/%FF", "/trpc/" + "a".repeat(1024)]) {
    const invalid = await app.inject({ method: "GET", url, headers: gatewayHeaders });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.headers["cache-control"], "private, no-store");
    assert.deepEqual(invalid.json(), { error: "Invalid request" });
  }
  assert.deepEqual(state.hashes, [tokenHash, tokenHash]);
  assert.deepEqual(state.errors, []);
});

test("service and session secrets in thrown errors never reach HTTP or logger output", async (t) => {
  const { query, state } = fixture(t);
  state.failure = new Error(`${gatewayToken} ${token}`);
  state.failure.name = gatewayToken;
  const response = await query();
  assert.equal(response.statusCode, 500);
  const output = response.body + JSON.stringify(response.headers) + JSON.stringify(state.errors);
  for (const secret of [gatewayToken, gatewayToken.slice(0, 15), token]) {
    assert.ok(!output.includes(secret));
  }
  assert.deepEqual(state.errors, [{ name: "Error" }]);
});

test("decision mutations use fresh persisted admin identity and preserve real decider semantics", async (t) => {
  const { app, state } = fixture(t);
  const mutate = async (input: { userId: string; approve: boolean }, cookie = `mint_session=${token}`) => {
    const response = await app.inject({
      method: "POST", url: "/trpc/accounts.decideAccessRequest",
      headers: { ...gatewayHeaders, cookie, "x-user-role": "admin", "x-forwarded-for": "203.0.113.1" },
      payload: input,
    });
    assert.equal(response.headers["cache-control"], "private, no-store");
    return response;
  };
  state.accounts.set(target, { status: "pending" });
  assert.equal((await mutate({ userId: target, approve: true })).statusCode, 403);
  state.evidence = { principal: { ...principal, role: "admin" }, expiresAt: future() };
  const approved = await mutate({ userId: target, approve: true });
  assert.equal(approved.statusCode, 200);
  assert.deepEqual(approved.json(), { result: { data: null } });
  assert.deepEqual(state.accounts.get(target), { status: "active", approvedAt: now, approvedBy: principal.id });
  assert.equal((await mutate({ userId: target, approve: false })).statusCode, 200);
  assert.deepEqual(state.notifications, [0, 0]);
  assert.equal(state.accounts.get(target)?.status, "active");

  const priorDate = new Date("2020-01-01T00:00:00Z");
  state.accounts.set(target, { status: "pending", approvedAt: priorDate, approvedBy: "old" });
  assert.equal((await mutate({ userId: target, approve: false })).statusCode, 200);
  assert.deepEqual(state.accounts.get(target), { status: "denied", approvedAt: priorDate, approvedBy: "old" });
  assert.deepEqual(state.notifications, [0, 0, 0]);
  state.evidence = { principal: { ...principal, role: "user" }, expiresAt: future() };
  assert.equal((await mutate({ userId: target, approve: true })).statusCode, 403);
  state.evidence = { principal: { ...principal, role: "admin" }, expiresAt: now };
  assert.equal((await mutate({ userId: target, approve: true })).statusCode, 403);
  state.evidence = { principal: { ...principal, role: "admin", status: "disabled" }, expiresAt: future() };
  assert.equal((await mutate({ userId: target, approve: true })).statusCode, 403);
  for (const status of ["pending", "denied"] as const) {
    state.evidence = { principal: { ...principal, role: "admin", status }, expiresAt: future() };
    assert.equal((await mutate({ userId: target, approve: true })).statusCode, 403);
  }
  state.evidence = null;
  assert.equal((await mutate({ userId: target, approve: true })).statusCode, 403);
  assert.equal((await mutate({ userId: target, approve: true }, "")).statusCode, 403);
  assert.equal(state.decisions.length, 3);
  assert.equal(state.hashes.length, 10);
  assert.deepEqual(state.errors, []);
});

test("decision inputs reject spoofing and invalid IDs and require gateway credentials", async (t) => {
  const { app, state } = fixture(t, { principal: { ...principal, role: "admin" }, expiresAt: future() });
  for (const payload of [
    { userId: target, approve: true, actor: { ...principal, role: "admin" } },
    { userId: target, approve: true, principal }, { userId: target, approve: true, role: "admin" },
    { userId: "bad-id", approve: true }, { userId: target, approve: "true" },
  ]) {
    const response = await app.inject({
      method: "POST", url: "/trpc/accounts.decideAccessRequest",
      headers: { ...gatewayHeaders, cookie: `mint_session=${token}` }, payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers["cache-control"], "private, no-store");
  }
  for (const gateway of [undefined, "B".repeat(42) + "A"]) {
    const response = await app.inject({
      method: "POST", url: "/trpc/accounts.decideAccessRequest",
      headers: { cookie: `mint_session=${token}`, ...(gateway ? { [GATEWAY_TOKEN_HEADER_NAME]: gateway } : {}) },
      payload: { userId: target, approve: true },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers["cache-control"], "private, no-store");
  }
  assert.deepEqual(state.hashes, []);
  assert.deepEqual(state.decisions, []);
});

test("decision repository, count, notification and session failures stay sanitized internal errors", async (t) => {
  const { app, state } = fixture(t, { principal: { ...principal, role: "admin" }, expiresAt: future() });
  for (const key of ["failure", "decisionFailure", "countFailure", "notifyFailure"] as const) {
    state[key] = new Error("secret-password SELECT private data");
    const response = await app.inject({
      method: "POST", url: "/trpc/accounts.decideAccessRequest",
      headers: { ...gatewayHeaders, cookie: `mint_session=${token}` },
      payload: { userId: target, approve: false },
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.message, "Internal server error");
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.doesNotMatch(response.body, /secret|password|SELECT|stack/);
    state[key] = null;
  }
  assert.deepEqual(state.errors, Array(4).fill({ name: "Error" }));
});

test("API requires both decision repository methods and a notifier at construction", () => {
  const base = {
    gatewayToken, sessions: { async findByTokenHash() { return null; } },
    decisions: { async decidePendingAccess() {}, async countPending() { return 0; } },
    async notifyAccessRequests() {}, errors: { error() {} },
  };
  for (const override of [
    { decisions: undefined }, { decisions: {} }, { decisions: { countPending: async () => 0 } },
    { decisions: { decidePendingAccess: async () => {} } }, { notifyAccessRequests: undefined },
  ]) {
    assert.throws(() => createApiServer({ ...base, ...override } as never), /Invalid API decision configuration/);
  }
});
