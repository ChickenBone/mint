import assert from "node:assert/strict";
import { test } from "node:test";
import { setMemberStatusInputSchema, type SetMemberStatusInput } from "@mint/contracts";
import { createMintSdk, MintSdkError, type MintSdkErrorCode } from "../src/index";

const gatewayToken = "A".repeat(43);
const sessionToken = "fixture-browser-session-token";
const input: SetMemberStatusInput = { userId: "00000000-0000-4000-8000-000000000001", status: "disabled" };
const errorCode = (code: MintSdkErrorCode) => (error: unknown) =>
  error instanceof MintSdkError && error.code === code && error.cause === undefined;

test("member-status schema and SDK reject malformed or actor-bearing input before fetching", async () => {
  let calls = 0;
  const sdk = createMintSdk({
    url: "https://fixture.test/trpc", gatewayToken,
    fetch: async () => { calls++; return Response.json({ result: { data: null } }); },
  });
  for (const value of [
    null, undefined, [], {}, { ...input, userId: "bad" }, { ...input, status: "denied" },
    { ...input, actor: { role: "admin" } }, { ...input, userId: 1 }, { ...input, status: null },
  ]) {
    assert.equal(setMemberStatusInputSchema.safeParse(value).success, false);
    await assert.rejects(sdk.accounts.setMemberStatus(value as SetMemberStatusInput), errorCode("INVALID_INPUT"));
  }
  assert.equal(calls, 0);
  for (const status of ["active", "disabled"] as const) {
    assert.deepEqual(setMemberStatusInputSchema.parse({ ...input, status }), { ...input, status });
  }
});

test("member-status SDK sends only canonical credentials, validates null output and sanitizes failures", async () => {
  let data: unknown = null;
  let mode = "success";
  const sdk = createMintSdk({
    url: "https://fixture.test/trpc", gatewayToken, sessionToken,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://fixture.test/trpc/accounts.setMemberStatus");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), input);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("cookie"), `mint_session=${sessionToken}`);
      assert.equal(headers.get("x-mint-gateway-token"), gatewayToken);
      assert.equal(headers.get("authorization"), null);
      assert.equal(headers.get("x-user-role"), null);
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      if (mode === "network") throw new Error("private-db-password");
      if (mode === "http") return new Response("private-db-password", { status: 500 });
      if (mode === "rpc") return Response.json({
        error: { code: -32603, message: "private-db-password", data: { code: "INTERNAL_SERVER_ERROR" } },
      });
      return Response.json({ result: { data } });
    },
  });
  assert.equal(await sdk.accounts.setMemberStatus(input), undefined);
  for (const value of [undefined, true, false, {}, [], "null", 0]) {
    data = value;
    await assert.rejects(sdk.accounts.setMemberStatus(input), errorCode("INCOMPATIBLE_RESPONSE"));
  }
  for (const failure of ["network", "http", "rpc"]) {
    mode = failure;
    await assert.rejects(sdk.accounts.setMemberStatus(input),
      errorCode(failure === "network" ? "TRANSPORT_ERROR" : "RPC_ERROR"));
  }
});

test("member-status cancellation preserves pre-aborted and in-flight caller reasons", async () => {
  const reason = new Error("caller cancelled member-status mutation");
  const preAborted = new AbortController();
  preAborted.abort(reason);
  const noFetch = createMintSdk({
    url: "https://fixture.test/trpc", gatewayToken,
    fetch: async () => { assert.fail("pre-aborted request must not fetch"); },
  });
  await assert.rejects(noFetch.accounts.setMemberStatus(input, { signal: preAborted.signal }),
    (error) => error === reason);
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const sdk = createMintSdk({
    url: "https://fixture.test/trpc", gatewayToken,
    fetch: async (_url, init) => {
      const signal = init?.signal;
      assert.ok(signal);
      started();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const pending = sdk.accounts.setMemberStatus(input, { signal: controller.signal });
  await ready;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});
