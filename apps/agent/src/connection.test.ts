import assert from "node:assert/strict";
import test from "node:test";
import { connectionFailure, loopbackUrl, mintUrl } from "./connection";

test("Mint endpoints are origins, not URLs carrying credentials or paths", () => {
  assert.equal(mintUrl("https://mint.chickenbone.dev/"), "https://mint.chickenbone.dev");
  assert.equal(mintUrl("http://localhost:3000"), "http://localhost:3000");
  for (const value of ["", "mint.example.com", "file:///tmp/test", "https://user:secret@example.com", "https://example.com/api", "https://example.com/?token=secret", "https://example.com/#secret"]) {
    assert.throws(() => mintUrl(value), /MINT_URL must/);
  }
  assert.equal(loopbackUrl("http://localhost:3000"), true);
  assert.equal(loopbackUrl("http://[::1]:3000"), true);
  assert.equal(loopbackUrl("https://mint.chickenbone.dev"), false);
  assert.deepEqual(connectionFailure(new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) })), { error: "fetch failed", code: "ECONNREFUSED" });
});
