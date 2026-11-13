import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_SESSION_COOKIE_NAME, browserSessionTokenSchema } from "../src/index";

test("browser session wire accepts exactly unquoted base64url tokens of 1 through 512 characters", () => {
  assert.equal(BROWSER_SESSION_COOKIE_NAME, "mint_session");
  for (const token of ["a", "ABCdef0123_-", "x".repeat(43), "x".repeat(512)]) {
    assert.equal(browserSessionTokenSchema.parse(token), token);
  }
  for (const token of [
    "", "x".repeat(513), " token", "token ", "token\n", '"token"', "%74oken",
    "mn1.native-session", "token=", "a;b", "a,b", "a/b", "a+b", "\r\n",
    null, undefined, 123, {},
  ]) {
    assert.equal(browserSessionTokenSchema.safeParse(token).success, false);
  }
});
