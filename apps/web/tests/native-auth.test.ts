import assert from "node:assert/strict";
import { test } from "node:test";
import { currentNativeContext, isNativeTransportRequest, runNativeRequest, validConsumerMutation } from "../src/lib/native-context";
import { nativeHttp, nativeRouteAllowed, nativeWebOriginAllowed } from "../src/lib/native-http";

const user = { id: "user", email: "listener@example.com", name: "Listener", role: "user" as const, status: "active" as const };
test("native adapter context is request-local and never authorizes a different Request", async () => {
  const native = new Request("https://mint.example.com/api/native/music/likes/song", { method: "PUT" });
  const other = new Request(native.url, { method: "PUT" });
  await Promise.all([
    runNativeRequest({ user, sessionHash: "a".repeat(64), request: native }, async () => {
      await Promise.resolve();
      assert.equal(currentNativeContext()?.user.role, "user");
      assert.equal(validConsumerMutation(native, "https://mint.example.com"), true);
      assert.equal(validConsumerMutation(other, "https://mint.example.com"), false);
      assert.equal(isNativeTransportRequest(other), false);
    }),
    Promise.resolve().then(() => assert.equal(currentNativeContext(), undefined)),
  ]);
  assert.equal(currentNativeContext(), undefined);
});
test("cookie web requests still require their existing Origin even with forged bearer headers", () => {
  const request = new Request("https://mint.example.com/api/music/likes/song", {
    method: "PUT", headers: { authorization: "Bearer fake", origin: "https://attacker.example.com" },
  });
  assert.equal(validConsumerMutation(request, "https://mint.example.com"), false);
  assert.equal(validConsumerMutation(new Request(request.url, { method: "PUT", headers: { origin: "https://mint.example.com" } }), "https://mint.example.com"), true);
});
test("consumer allowlist excludes admin, workers, chart acquisition and path traversal", () => {
  for (const path of [["admin"], ["charts", "request"], ["agent"], ["browse", "genre"], ["player", "lyrics", "id", "matches"], ["music", "..", "admin"], ["music", "admin"]]) {
    assert.equal(nativeRouteAllowed(path, "GET"), false);
  }
  assert.equal(nativeRouteAllowed(["player", "audio", "track"], "HEAD"), true);
  assert.equal(nativeRouteAllowed(["player", "offline"], "GET"), true);
  assert.equal(nativeRouteAllowed(["music", "collections"], "POST"), true);
  assert.equal(nativeRouteAllowed(["player", "audio", "track"], "POST"), false);
  // Search browsing can read categories and charts, but never write through those routes.
  assert.equal(nativeRouteAllowed(["browse"], "GET"), true);
  assert.equal(nativeRouteAllowed(["charts"], "GET"), true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(nativeRouteAllowed(["browse"], method), false);
    assert.equal(nativeRouteAllowed(["charts"], method), false);
  }
});
test("native web CORS is opt-in and never grants cookies", async () => {
  assert.equal(nativeWebOriginAllowed(null, "https://mint.example.com", ""), true);
  assert.equal(nativeWebOriginAllowed("https://app.example.com", "https://mint.example.com", ""), false);
  assert.equal(nativeWebOriginAllowed("https://app.example.com", "https://mint.example.com", "https://app.example.com"), true);
  assert.equal(nativeWebOriginAllowed("https://evil.example.com", "https://mint.example.com", "*"), false);
  const request = new Request("https://mint.example.com/api/native/player/offline", { headers: { origin: "https://mint.example.com" } });
  const response = await nativeHttp(request, async () => Response.json({ ok: true }));
  assert.equal(response.headers.get("access-control-allow-origin"), "https://mint.example.com");
  assert.equal(response.headers.has("access-control-allow-credentials"), false);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("vary")!, /Authorization/);
});
test("same-origin behind a reverse proxy follows canonical PUBLIC_URL rather than the internal request host", async () => {
  const original = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = "https://mint.example.com";
  try {
    const request = new Request("http://web:3000/api/native/auth/login", {
      method: "OPTIONS", headers: { origin: "https://mint.example.com" },
    });
    const response = await nativeHttp(request, async () => Response.json({ ok: true }));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://mint.example.com");
  } finally {
    if (original === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = original;
  }
});
