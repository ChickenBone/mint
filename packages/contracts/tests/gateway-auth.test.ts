import assert from "node:assert/strict";
import test from "node:test";
import { GATEWAY_TOKEN_HEADER_NAME, gatewayTokenSchema } from "../src/index";

test("gateway token is exactly the canonical unpadded base64url encoding of 32 bytes", () => {
  assert.equal(GATEWAY_TOKEN_HEADER_NAME, "x-mint-gateway-token");
  const prefix = "A".repeat(42);
  for (const last of "AEIMQUYcgkosw048") {
    const token = prefix + last;
    assert.equal(gatewayTokenSchema.parse(token), token);
  }
  assert.equal(gatewayTokenSchema.parse("_-".repeat(21) + "8"), "_-".repeat(21) + "8");
  // Every other last character encodes nonzero unused bits.
  for (const last of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") {
    assert.equal(gatewayTokenSchema.safeParse(prefix + last).success,
      "AEIMQUYcgkosw048".includes(last));
  }
  for (const token of [
    "", "A".repeat(42), "A".repeat(44), "A".repeat(512),
    ` ${prefix}A`, `${prefix}A `, `${prefix}A\n`, `${prefix}A\r\n`,
    `${prefix}\t`, `"${prefix}A"`, `${prefix}A=`, `${prefix}+`, `${prefix}/`,
    `%41${prefix}`, `mn1.${"A".repeat(39)}`, `${prefix}é`, `${prefix}Ａ`,
    `${prefix}A\r\nx-header:value`, `${prefix},`, null, undefined, 123, {},
  ]) {
    assert.equal(gatewayTokenSchema.safeParse(token).success, false);
  }
});
