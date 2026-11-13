import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createMintSdk, MintSdkError } from "../src/index";

const gatewayToken = randomBytes(32).toString("base64url");
const input = { email: "listener@example.test", password: "fixture-password" };

test("onboarding validates options and inputs before transport", async () => {
  for (const trustedClientIp of ["unknown", "192.0.2.1,192.0.2.2", "fe80::1%eth0"]) {
    assert.throws(() => createMintSdk({ url: "http://localhost/trpc", gatewayToken, trustedClientIp }), MintSdkError);
  }
  let called = false;
  const sdk = createMintSdk({
    url: "http://localhost/trpc", gatewayToken,
    fetch: async () => { called = true; throw new Error("Never"); },
  });
  await assert.rejects(sdk.accounts.signIn({ ...input, email: "invalid" }), MintSdkError);
  await assert.rejects(sdk.accounts.requestAccess({ ...input, name: "Listener", confirm: "mismatch" }), MintSdkError);
  assert.equal(called, false);
});

test("onboarding sends only explicit canonical ingress evidence and validates response shapes", async () => {
  let value: unknown = { error: "No match.", status: 401 };
  const sdk = createMintSdk({
    url: "http://localhost/trpc", gatewayToken, trustedClientIp: "2001:0db8:0:0:0:0:0:1",
    fetch: async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-mint-client-ip"), "2001:db8::1");
      assert.equal(headers.get("x-forwarded-for"), null);
      assert.equal(headers.get("x-mint-gateway-token"), gatewayToken);
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      return Response.json({ result: { data: value } });
    },
  });
  assert.deepEqual(await sdk.accounts.signIn(input), value);
  for (const invalid of [{ principal: {} }, { token: "secret" }, { error: "Oops", status: 200 }, { ok: true }]) {
    value = invalid;
    await assert.rejects(sdk.accounts.signIn(input), { code: "INCOMPATIBLE_RESPONSE" });
  }
  value = { ok: true };
  const request = { ...input, name: "Listener", confirm: input.password };
  assert.deepEqual(await sdk.accounts.requestAccess(request), { ok: true });
  value = { ok: true, emailExists: true };
  await assert.rejects(sdk.accounts.requestAccess(request), { code: "INCOMPATIBLE_RESPONSE" });
  value = null;
  await sdk.accounts.signOut();
  value = {};
  await assert.rejects(sdk.accounts.signOut(), { code: "INCOMPATIBLE_RESPONSE" });
});
