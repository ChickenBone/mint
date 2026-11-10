import assert from "node:assert/strict";
import test from "node:test";
import { mutationOriginAllowed } from "../src/lib/request";

test("admin mutations accept configured hosts when the request URL stays on localhost", () => {
  const previousAllowed = process.env.ALLOWED_ORIGINS;
  const previousPublic = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = "http://localhost:3000";
  process.env.ALLOWED_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000,http://macbook-pro:3000";
  try {
    assert.equal(mutationOriginAllowed(new Request("http://localhost:3000/api/admin/matching", {
      method: "POST", headers: { origin: "http://macbook-pro:3000" },
    })), true);
    assert.equal(mutationOriginAllowed(new Request("http://localhost:3000/api/admin/matching", {
      method: "POST", headers: { origin: "http://127.0.0.1:3000" },
    })), true);
    assert.equal(mutationOriginAllowed(new Request("http://macbook-pro:3000/api/admin/matching", {
      method: "POST", headers: { origin: "http://macbook-pro:3000" },
    })), true);
    assert.equal(mutationOriginAllowed(new Request("http://localhost:3000/api/admin/matching", {
      method: "POST", headers: { origin: "https://evil.example" },
    })), false);
  } finally {
    if (previousAllowed === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = previousAllowed;
    if (previousPublic === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = previousPublic;
  }
});
