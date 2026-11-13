import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createApiServer } from "@mint/api";
import { GATEWAY_TOKEN_HEADER_NAME, type AccountPrincipal } from "@mint/contracts";
import { createMintSdk, MintSdkError, type MintSdk, type MintSdkErrorCode } from "../src/index";

const now = new Date("2026-11-12T12:00:00Z");
const token = "browser_session_token-0123456789";
const gatewayToken = "gateway_fixture_".padEnd(42, "_") + "A";
const hash = createHash("sha256").update(token).digest("hex");
const target = "00000000-0000-4000-8000-000000000002";
const principal: AccountPrincipal = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "listener@example.test",
  name: "Listener",
  role: "user",
  status: "active",
};
type Evidence = { principal: AccountPrincipal; expiresAt: Date };

async function fixture(t: TestContext) {
  const state = {
    evidence: { principal: { ...principal }, expiresAt: new Date(now.getTime() + 60_000) } as Evidence | null,
    hashes: [] as string[],
    failure: false,
    errors: [] as { name: string }[],
    requests: [] as {
      url: string; cookie?: string; authorization?: string; identity?: string;
      gateway?: string; forwardedFor?: string; realIp?: string; forwarded?: string;
    }[],
    redirectTo: "",
    decisions: [] as { userId: string; status: string }[],
    notifications: [] as number[],
    decisionFailure: false,
  };
  const app = createApiServer({
    gatewayToken,
    now: () => now,
    sessions: {
      async findByTokenHash(value) {
        state.hashes.push(value);
        if (state.failure) throw new Error("private-db-password-and-connection-url");
        return value === hash ? state.evidence : null;
      },
    },
    decisions: {
      async decidePendingAccess({ userId, decision }) {
        if (state.decisionFailure) throw new Error("private-db-password-and-connection-url");
        state.decisions.push({ userId, status: decision.status });
      },
      async countPending() { return 7; },
    },
    async notifyAccessRequests({ pending }) { state.notifications.push(pending); },
    errors: { error: (event) => { state.errors.push(event); } },
  });
  t.after(async () => {
    await app.close();
    assert.equal(app.server.listening, false);
  });
  app.addHook("onRequest", async (request) => {
    state.requests.push({
      url: request.url, cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      identity: request.headers["x-user-role"]?.toString(),
      gateway: request.headers[GATEWAY_TOKEN_HEADER_NAME]?.toString(),
      forwardedFor: request.headers["x-forwarded-for"]?.toString(),
      realIp: request.headers["x-real-ip"]?.toString(),
      forwarded: request.headers.forwarded,
    });
  });
  app.get("/redirect/accounts.session", async (_request, reply) => reply.redirect(state.redirectTo));
  app.get("/sink", async () => ({ result: { data: principal } }));
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { url: `${address}/trpc`, address, state };
}

function sdkError(code: MintSdkErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof MintSdkError);
    assert.equal(error.code, code);
    assert.equal(error.name, "MintSdkError");
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /secret|password|mint_session|browser_session|issues|SELECT/);
    assert.ok(!(JSON.stringify(error) + error.message).includes(gatewayToken));
    return true;
  };
}

test("official client reaches the listening Fastify API for active user, admin and anonymous sessions", async (t) => {
  const { url, state } = await fixture(t);
  const sdk = createMintSdk({ url, gatewayToken, sessionToken: token });
  assert.deepEqual(await sdk.accounts.session(), principal);
  state.evidence = {
    principal: { ...principal, role: "admin", ...{ passwordHash: "secret", token, tokenHash: hash } },
    expiresAt: new Date(now.getTime() + 60_000),
  };
  assert.deepEqual(await sdk.accounts.session(), { ...principal, role: "admin" });
  assert.equal(await createMintSdk({ url, gatewayToken }).accounts.session(), null);
  assert.equal(await createMintSdk({ url, gatewayToken, sessionToken: "unknown" }).accounts.session(), null);
  assert.deepEqual(state.hashes, [hash, hash, createHash("sha256").update("unknown").digest("hex")]);
  assert.equal(state.requests.length, 4);
  assert.deepEqual(state.errors, []);
});

test("every call observes identity changes, status, expiry and revocation without memoization", async (t) => {
  const { url, state } = await fixture(t);
  const sdk = createMintSdk({ url, gatewayToken, sessionToken: token });
  assert.deepEqual(await sdk.accounts.session(), principal);
  const changed: AccountPrincipal = {
    ...principal, id: "00000000-0000-4000-8000-000000000002",
    email: "changed@example.test", name: "Changed", role: "admin",
  };
  for (const status of ["pending", "denied", "disabled"] as const) {
    state.evidence = { principal: { ...changed, status }, expiresAt: new Date(now.getTime() + 1) };
    assert.equal(await sdk.accounts.session(), null);
  }
  for (const expiresAt of [now, new Date(now.getTime() - 1)]) {
    state.evidence = { principal: changed, expiresAt };
    assert.equal(await sdk.accounts.session(), null);
  }
  state.evidence = { principal: changed, expiresAt: new Date(now.getTime() + 1) };
  assert.deepEqual(await sdk.accounts.session(), changed);
  state.evidence = null;
  assert.equal(await sdk.accounts.session(), null);
  assert.equal(state.requests.length, 8);
  assert.deepEqual(state.hashes, Array(8).fill(hash));
});

test("transport forwards only its explicit cookie and forces private nonredirecting fetch options", async (t) => {
  const { url, state } = await fixture(t);
  const controller = new AbortController();
  const captures: RequestInit[] = [];
  const transport: typeof fetch = async (input, init) => {
    assert.ok(init);
    captures.push(init);
    return fetch(input, init);
  };
  const options = {
    url, gatewayToken, sessionToken: token, fetch: transport,
    headers: {
      cookie: "other=secret", authorization: "secret", "x-user-role": "admin",
      "x-forwarded-for": "203.0.113.1", "x-real-ip": "203.0.113.2",
      forwarded: "for=203.0.113.3", [GATEWAY_TOKEN_HEADER_NAME]: "wrong",
    },
    credentials: "include",
  };
  const sdk = createMintSdk(options);
  options.sessionToken = "mutated";
  options.gatewayToken = "mutated";
  assert.deepEqual(await sdk.accounts.session({ signal: controller.signal }), principal);
  assert.equal(await createMintSdk({ ...options, gatewayToken, sessionToken: undefined }).accounts.session(), null);
  for (const init of captures) {
    assert.equal(init.method, "GET");
    assert.equal(init.cache, "no-store");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.body, undefined);
  }
  assert.ok(captures[0]?.signal instanceof AbortSignal);
  assert.equal(captures[0].signal.aborted, false);
  assert.deepEqual([...new Headers(captures[0].headers)], [
    ["cookie", `mint_session=${token}`], [GATEWAY_TOKEN_HEADER_NAME, gatewayToken],
  ]);
  assert.deepEqual([...new Headers(captures[1]?.headers)], [[GATEWAY_TOKEN_HEADER_NAME, gatewayToken]]);
  for (const request of state.requests) {
    assert.equal(request.gateway, gatewayToken);
    assert.equal(request.forwardedFor, undefined);
    assert.equal(request.realIp, undefined);
    assert.equal(request.forwarded, undefined);
  }
  assert.ok(!JSON.stringify(sdk).includes(gatewayToken));
  assert.deepEqual(state.requests.map(({ cookie, authorization, identity, url: path }) =>
    ({ cookie, authorization, identity, path })), [
    { cookie: `mint_session=${token}`, authorization: undefined, identity: undefined, path: "/trpc/accounts.session" },
    { cookie: undefined, authorization: undefined, identity: undefined, path: "/trpc/accounts.session" },
  ]);
});

test("invalid token and URL options fail without fetching or exposing input", () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error("unexpected fetch"); };
  for (const sessionToken of [
    "", "x".repeat(513), " token", "token ", "token\n", '"token"', "%74oken",
    "mn1.native-session", "token=", "a;b", "token\r\nx-header:secret",
  ]) {
    assert.throws(() => createMintSdk({
      url: "https://mint.example.test/trpc", gatewayToken, sessionToken, fetch: transport,
    }), sdkError("INVALID_OPTIONS"));
  }
  for (const url of [
    "", "/trpc", "not a URL", "file:///trpc", "ftp://mint.example.test/trpc",
    "https://secret:password@mint.example.test/trpc", "https://secret@mint.example.test/trpc",
    "https://mint.example.test/trpc?secret=value", "https://mint.example.test/trpc#secret",
  ]) {
    assert.throws(() => createMintSdk({ url, gatewayToken, fetch: transport }), sdkError("INVALID_OPTIONS"));
  }
  for (const sessionToken of ["a", "ABCdef0123_-", "x".repeat(512)]) {
    assert.doesNotThrow(() => createMintSdk({
      url: "https://mint.example.test/trpc/", gatewayToken, sessionToken, fetch: transport,
    }));
  }
  assert.equal(calls, 0);
});

test("gateway options require canonical explicit credentials and never fetch when invalid", () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error("unexpected fetch"); };
  for (const gatewayToken of [
    undefined, null, 123, {}, "", token, "A".repeat(42), "A".repeat(44),
    "A".repeat(42) + "B", "A".repeat(43) + "\n", "mn1.native-session",
    " " + "A".repeat(43), "A".repeat(43) + " ", "A".repeat(43) + "=",
    "%41" + "A".repeat(40), "A".repeat(43) + "\r\nx-header:secret",
  ]) {
    assert.throws(() => createMintSdk({
      url: "https://mint.example.test/trpc", gatewayToken: gatewayToken as string, fetch: transport,
    }), sdkError("INVALID_OPTIONS"));
  }
  assert.throws(() => createMintSdk(undefined as never), sdkError("INVALID_OPTIONS"));
  assert.throws(() => createMintSdk(null as never), sdkError("INVALID_OPTIONS"));
  assert.equal(calls, 0);
});

test("a well-formed wrong service credential fails real transport before user session lookup", async (t) => {
  const { url, state } = await fixture(t);
  const sdk = createMintSdk({
    url, gatewayToken: "B".repeat(42) + "A", sessionToken: token,
  });
  await assert.rejects(sdk.accounts.session(), sdkError("RPC_ERROR"));
  assert.deepEqual(state.hashes, []);
  assert.deepEqual(state.requests, []);
  assert.deepEqual(state.errors, []);
});

test("valid service authentication does not confer a user session", async (t) => {
  const { url, state } = await fixture(t);
  assert.equal(await createMintSdk({ url, gatewayToken, sessionToken: gatewayToken }).accounts.session(), null);
  assert.equal(await createMintSdk({ url, gatewayToken }).accounts.session(), null);
  assert.deepEqual(state.hashes, [createHash("sha256").update(gatewayToken).digest("hex")]);
  assert.ok(state.requests.every((request) => request.gateway === gatewayToken));
});

test("runtime output validation strips secrets and rejects incompatible successful data", async () => {
  const data = { ...principal, passwordHash: "secret", sessionToken: token, unexpected: true };
  let value: unknown = data;
  const sdk = createMintSdk({
    url: "https://mint.example.test/trpc", gatewayToken,
    fetch: async () => Response.json({ result: { data: value } }),
  });
  assert.deepEqual(await sdk.accounts.session(), principal);
  for (const status of ["pending", "active", "denied", "disabled"] as const) {
    value = { ...principal, status, email: " Database text ", name: "  " };
    assert.deepEqual(await sdk.accounts.session(), value);
  }
  value = null;
  assert.equal(await sdk.accounts.session(), null);
  for (const invalid of [
    undefined, {}, [], "secret", 123, { ...principal, role: "owner" },
    { ...principal, id: "secret-invalid-guid" }, { ...principal, name: null },
    { ...principal, status: "approved" },
  ]) {
    value = invalid;
    await assert.rejects(sdk.accounts.session(), sdkError("INCOMPATIBLE_RESPONSE"));
  }
});

test("malformed wire, HTTP and tRPC errors surface only sanitized typed errors", async () => {
  for (const response of [
    Response.json({ error: {
      message: `secret-password ${gatewayToken}`, code: -32603,
      data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, secret: token },
    } }),
    Response.json({ error: "secret", result: { data: principal } }, { status: 500 }),
    Response.json({ unexpected: "secret" }),
    new Response("secret-not-json", { headers: { "content-type": "application/json" } }),
    new Response("<html>secret</html>"),
    Response.json({ result: { data: null } }, { status: 401 }),
  ]) {
    const sdk = createMintSdk({
      url: "https://mint.example.test/trpc", gatewayToken, fetch: async () => response,
    });
    await assert.rejects(sdk.accounts.session(), sdkError("RPC_ERROR"));
  }
});

test("API internal failures remain errors rather than anonymous success", async (t) => {
  const { url, state } = await fixture(t);
  state.failure = true;
  await assert.rejects(createMintSdk({ url, gatewayToken, sessionToken: token }).accounts.session(), sdkError("RPC_ERROR"));
  assert.deepEqual(state.errors, [{ name: "Error" }]);
  assert.equal(state.requests.length, 1);
});

test("network failure is sanitized and does not retry", async () => {
  let calls = 0;
  const sdk = createMintSdk({
    url: "https://mint.example.test/trpc", gatewayToken, sessionToken: token,
    fetch: async () => { calls++; throw new Error(`secret ${token} ${gatewayToken}`); },
  });
  await assert.rejects(sdk.accounts.session(), sdkError("TRANSPORT_ERROR"));
  assert.equal(calls, 1);
});

test("pre-aborted and in-flight cancellation preserve caller abort reasons and reach fetch", async () => {
  const preAborted = new AbortController();
  const reason = new Error("caller cancellation");
  preAborted.abort(reason);
  const noFetch = createMintSdk({
    url: "https://mint.example.test/trpc", gatewayToken,
    fetch: async () => { assert.fail("pre-aborted request must not fetch"); },
  });
  await assert.rejects(noFetch.accounts.session({ signal: preAborted.signal }), (error) => error === reason);

  const controller = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const sdk = createMintSdk({
    url: "https://mint.example.test/trpc", gatewayToken,
    fetch: async (_input, init) => {
      observedSignal = init?.signal;
      assert.ok(observedSignal);
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    },
  });
  const pending = sdk.accounts.session({ signal: controller.signal });
  await ready;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(observedSignal?.aborted, true);
});

test("real HTTP redirects never send the session token to the redirect destination", async (t) => {
  const source = await fixture(t);
  const destination = await fixture(t);
  source.state.redirectTo = `${destination.address}/sink`;
  const sdk = createMintSdk({ url: `${source.address}/redirect`, gatewayToken, sessionToken: token });
  await assert.rejects(sdk.accounts.session(), sdkError("TRANSPORT_ERROR"));
  assert.equal(source.state.requests.length, 1);
  assert.equal(source.state.requests[0]?.cookie, `mint_session=${token}`);
  assert.equal(source.state.requests[0]?.gateway, gatewayToken);
  assert.deepEqual(destination.state.requests, []);
});

function typeSurface(sdk: MintSdk) {
  const result: Promise<AccountPrincipal | null> = sdk.accounts.session({ signal: new AbortController().signal });
  // @ts-expect-error arbitrary authentication headers are not SDK options
  createMintSdk({ url: "https://mint.example.test/trpc", gatewayToken, headers: { authorization: "secret" } });
  // @ts-expect-error a service credential must be explicitly provided
  createMintSdk({ url: "https://mint.example.test/trpc" });
  // @ts-expect-error session has no caller-supplied identity or query input
  sdk.accounts.session({ role: "admin" });
  // @ts-expect-error decision input cannot supply an actor
  sdk.accounts.decideAccessRequest({ userId: target, approve: true, actor: principal });
  // @ts-expect-error there is no credential-issuance procedure in this SDK
  sdk.accounts.signIn();
  return result;
}
void typeSurface;

test("SDK decisions forward only the explicit cookie and observe fresh persisted authorization", async (t) => {
  const { url, state } = await fixture(t);
  const captures: RequestInit[] = [];
  const sdk = createMintSdk({
    url, gatewayToken, sessionToken: token,
    fetch: async (input, init) => { assert.ok(init); captures.push(init); return fetch(input, init); },
  });
  await assert.rejects(sdk.accounts.decideAccessRequest({ userId: target, approve: true }), sdkError("RPC_ERROR"));
  state.evidence = { principal: { ...principal, role: "admin" }, expiresAt: new Date(now.getTime() + 1) };
  await sdk.accounts.decideAccessRequest({ userId: target, approve: true });
  await sdk.accounts.decideAccessRequest({ userId: target, approve: false });
  state.evidence = { principal, expiresAt: new Date(now.getTime() + 1) };
  await assert.rejects(sdk.accounts.decideAccessRequest({ userId: target, approve: true }), sdkError("RPC_ERROR"));
  await assert.rejects(createMintSdk({ url, gatewayToken }).accounts.decideAccessRequest({
    userId: target, approve: true,
  }), sdkError("RPC_ERROR"));
  await assert.rejects(createMintSdk({
    url, gatewayToken: "B".repeat(42) + "A", sessionToken: token,
  }).accounts.decideAccessRequest({ userId: target, approve: true }), sdkError("RPC_ERROR"));
  assert.deepEqual(state.decisions, [{ userId: target, status: "active" }, { userId: target, status: "denied" }]);
  assert.deepEqual(state.notifications, [7, 7]);
  assert.deepEqual(state.hashes, Array(4).fill(hash));
  for (const init of captures) {
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("cookie"), `mint_session=${token}`);
    assert.equal(headers.get(GATEWAY_TOKEN_HEADER_NAME), gatewayToken);
    assert.equal(headers.get("x-forwarded-for"), null);
    assert.equal(headers.get("x-real-ip"), null);
    assert.equal(headers.get("forwarded"), null);
  }
  assert.equal(state.requests.at(-1)?.cookie, undefined);
});

test("SDK validates decision input before transport and validates successful output", async () => {
  let calls = 0;
  let value: unknown = null;
  const sdk = createMintSdk({
    url: "https://mint.example.test/trpc", gatewayToken,
    fetch: async () => { calls++; return Response.json({ result: { data: value } }); },
  });
  for (const input of [
    { userId: "bad-id", approve: true }, { userId: target, approve: "true" },
    { userId: target, approve: true, actor: principal }, { userId: target, approve: true, role: "admin" },
    null,
  ]) {
    await assert.rejects(sdk.accounts.decideAccessRequest(input as never), sdkError("INVALID_INPUT"));
  }
  assert.equal(calls, 0);
  await sdk.accounts.decideAccessRequest({ userId: target, approve: true });
  for (value of [undefined, {}, true, "secret"]) {
    await assert.rejects(sdk.accounts.decideAccessRequest({ userId: target, approve: false }), sdkError("INCOMPATIBLE_RESPONSE"));
  }
  assert.equal(calls, 5);
});

test("SDK decision errors are sanitized, including internal failures and transport errors", async (t) => {
  const { url, state } = await fixture(t);
  state.evidence = { principal: { ...principal, role: "admin" }, expiresAt: new Date(now.getTime() + 1) };
  state.decisionFailure = true;
  await assert.rejects(createMintSdk({ url, gatewayToken, sessionToken: token }).accounts.decideAccessRequest({
    userId: target, approve: false,
  }), sdkError("RPC_ERROR"));
  assert.deepEqual(state.errors, [{ name: "Error" }]);
  const sdk = createMintSdk({
    url, gatewayToken, fetch: async () => { throw new Error("secret"); },
  });
  await assert.rejects(sdk.accounts.decideAccessRequest({ userId: target, approve: true }), sdkError("TRANSPORT_ERROR"));
});
