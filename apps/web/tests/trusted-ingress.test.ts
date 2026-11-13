import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { trustedIngressIp, TrustedIngressError } from "../src/lib/trusted-ingress";

const secret = randomBytes(32).toString("base64url");
const env = { MINT_TARGET_TRUSTED_PROXY: "authenticated-ingress", MINT_TARGET_INGRESS_TOKEN: secret };
const headers = () => new Headers({
  "x-mint-ingress-token": secret, "x-mint-client-ip": "2001:0db8:0:0:0:0:0:1",
  "x-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.2", forwarded: "for=192.0.2.3",
});

test("authenticated ingress normalizes one observed address, ignoring ordinary forwarded headers", () => {
  assert.equal(trustedIngressIp(headers(), env), "2001:db8::1");
  for (const [input, expected] of [
    ["::ffff:192.0.2.9", "192.0.2.9"], ["::FFFF:c000:209", "192.0.2.9"], ["192.0.2.9", "192.0.2.9"],
  ]) {
    const h = headers();
    h.set("x-mint-client-ip", input!);
    assert.equal(trustedIngressIp(h, env), expected);
  }
});

test("missing/unsafe trust policy, credentials, duplicate/list IPs and arbitrary forwarding fail closed", () => {
  for (const config of [{}, { ...env, MINT_TARGET_TRUSTED_PROXY: "true" },
    { ...env, MINT_TARGET_INGRESS_TOKEN: "" }, { ...env, MINT_TARGET_INGRESS_TOKEN: "unsafe" }]) {
    assert.throws(() => trustedIngressIp(headers(), config), TrustedIngressError);
  }
  for (const [name, values] of [
    ["x-mint-client-ip", ["", "unknown", "192.0.2.1, 192.0.2.2", "192.0.2.1:80", "[::1]", "fe80::1%eth0"]],
    ["x-mint-ingress-token", ["", randomBytes(32).toString("base64url"), `${secret}, ${secret}`]],
  ] as const) {
    for (const value of values) {
      const h = headers();
      h.set(name, value);
      assert.throws(() => trustedIngressIp(h, env), TrustedIngressError);
    }
    const h = headers();
    h.delete(name);
    assert.throws(() => trustedIngressIp(h, env), TrustedIngressError);
  }
});
