import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { currentNativeContext, isNativeTransportRequest, runNativeRequest, validConsumerMutation } from "../src/lib/native-context";
import { nativeHttp, nativeRouteAllowed, nativeWebOriginAllowed } from "../src/lib/native-http";

const user = { id: "user", email: "listener@example.com", name: "Listener", role: "user" as const, status: "active" as const };
test("native analysis incompatibility logs only a fixed redacted diagnostic before safe 503", () => {
  const source = readFileSync(new URL("../src/app/api/native/[...path]/route.ts", import.meta.url), "utf8");
  assert.match(source, /if \(!parsed\.success\) \{\s*console\.error\("\[native-api\] track analysis response validation failed"\);\s*return json\("Track analysis is unavailable\.", 503\);/);
});
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
  assert.equal(nativeRouteAllowed(["music", "search", "requests"], "GET"), true);
  assert.equal(nativeRouteAllowed(["music", "search", "requests"], "POST"), true);
  assert.equal(nativeRouteAllowed(["music", "search", "requests"], "DELETE"), false);
  assert.equal(nativeRouteAllowed(["music", "search", "collection"], "GET"), true);
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(nativeRouteAllowed(["music", "search", "collection"], method), false);
  }
  assert.equal(nativeRouteAllowed(["music", "search", "requests", "extra"], "GET"), false);
  assert.equal(nativeRouteAllowed(["music", "search", "collection", "extra"], "GET"), false);
  assert.equal(nativeRouteAllowed(["music", "sources", "track-id"], "GET"), true);
  assert.equal(nativeRouteAllowed(["music", "sources", "track-id"], "POST"), true);
  assert.equal(nativeRouteAllowed(["music", "sources", "track-id"], "DELETE"), false);
  assert.equal(nativeRouteAllowed(["music", "sources"], "GET"), false);
  assert.match(readFileSync(new URL("../src/app/api/native/[...path]/route.ts", import.meta.url), "utf8"),
    /music\/search\/requests[\s\S]*?searchRequests\.GET[\s\S]*?searchRequests\.POST/);
  assert.equal(nativeRouteAllowed(["player", "audio", "track"], "POST"), false);
  assert.equal(nativeRouteAllowed(["player", "analysis", "track"], "GET"), true);
  assert.equal(nativeRouteAllowed(["player", "analysis"], "GET"), false);
  assert.equal(nativeRouteAllowed(["player", "analysis", "track", "retry"], "GET"), false);
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(nativeRouteAllowed(["player", "analysis", "track"], method), false);
  }
  // Search browsing can read categories and charts, but never write through those routes.
  assert.equal(nativeRouteAllowed(["browse"], "GET"), true);
  assert.equal(nativeRouteAllowed(["charts"], "GET"), true);
  for (const path of [["catalog", "artists", "mbid", "albums"], ["catalog", "albums", "mbid", "recordings"],
    ["catalog", "library-albums", "local-id", "recordings"]]) {
    assert.equal(nativeRouteAllowed(path, "GET"), true);
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"]) assert.equal(nativeRouteAllowed(path, method), false);
  }
  assert.equal(nativeRouteAllowed(["catalog", "priority", "artists"], "POST"), false);
  assert.equal(nativeRouteAllowed(["catalog", "artists", "mbid", "albums", "extra"], "GET"), false);
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
test("native device allowlist exposes only owned list, receiver and handoff operations", () => {
  const id = "41de9df5-44a9-4b69-8534-1ae803cea58f";
  assert.equal(nativeRouteAllowed(["devices"], "GET"), true);
  assert.equal(nativeRouteAllowed(["devices"], "POST"), true);
  assert.equal(nativeRouteAllowed(["devices", "commands", id], "GET"), true);
  for (const action of ["poll", "ack", "disconnect", "handoff"]) {
    assert.equal(nativeRouteAllowed(["devices", id, action], "POST"), true);
    assert.equal(nativeRouteAllowed(["devices", id, action], "GET"), false);
  }
  assert.equal(nativeRouteAllowed(["devices", "transfer"], "POST"), true);
  assert.equal(nativeRouteAllowed(["devices", "complete-transfer"], "POST"), true);
  for (const method of ["HEAD", "PUT", "PATCH", "DELETE"]) {
    assert.equal(nativeRouteAllowed(["devices"], method), false);
    assert.equal(nativeRouteAllowed(["devices", "transfer"], method), false);
    assert.equal(nativeRouteAllowed(["devices", "commands", id], method), false);
  }
  assert.equal(nativeRouteAllowed(["devices", "commands", id], "POST"), false);
  assert.equal(nativeRouteAllowed(["devices", "commands", "not-a-uuid"], "GET"), false);
  for (const path of [["devices", id, "revoke"], ["devices", id, "rename"], ["devices", id, "commands"], ["parties"]]) {
    assert.equal(nativeRouteAllowed(path, "POST"), false);
  }
});
test("the auto-merged native facade dispatches search, bridge and device requests only within a native session", async () => {
  const source = readFileSync(new URL("../src/app/api/native/[...path]/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const id = "41de9df5-44a9-4b69-8534-1ae803cea58f";
  const calls: string[] = [];
  const respond = (name: string) => async () => {
    const context = currentNativeContext();
    assert.ok(context);
    assert.equal(context.installationId, id);
    calls.push(name);
    return Response.json({ handler: name, method: context.request.method });
  };
  const modules: Record<string, unknown> = {
    "@/lib/native-context": { runNativeRequest },
    "@/lib/native-http": { nativeHttp, nativeRouteAllowed },
    "@/lib/native-sessions": { resolveNativeSession: async (request: Request) =>
      request.headers.get("authorization") === "Bearer fixture"
        ? { user: { ...user, role: "admin" }, sessionHash: "a".repeat(64), deviceId: id, deviceName: "Fixture phone" }
        : null },
    "@/lib/native-browse": { nativeBrowseResponse: respond("browse") },
    "@/lib/catalog-connection": { catalogConnectionResponse: respond("bridge") },
    "@/lib/devices": { deviceApi: async (_request: Request, path: string[], kind: string) => {
      assert.equal(kind, "devices");
      assert.deepEqual(path, currentNativeContext()?.request.url.includes("complete-transfer") ? ["complete-transfer"] : []);
      return respond("devices")();
    } },
    "@mint/client": { trackAnalysisResponseSchema: { safeParse: () => ({ success: true, data: {} }) } },
    "../../music/search/route": { GET: respond("search") },
    "../../music/search/requests/route": { GET: respond("requests-get"), POST: respond("requests-post") },
    "../../music/search/collection/route": { GET: respond("collection") },
    "../../music/[...path]/route": { GET: respond("music") },
  };
  const facade: Record<string, (request: Request, context: { params: Promise<{ path: string[] }> }) => Promise<Response>> = {};
  new Function("require", "exports", compiled)((name: string) => {
    if (name in modules) return modules[name];
    if (name.startsWith("../../")) return { GET: respond(name), POST: respond(name) };
    throw new Error(`Unexpected native route import: ${name}`);
  }, facade);
  const request = (path: string[], method: string, authenticated = true) => facade[method]!(
    new Request(`https://mint.example.com/api/native/${path.join("/")}`, {
      method, headers: authenticated ? { authorization: "Bearer fixture" } : {},
    }), { params: Promise.resolve({ path }) });
  const cases = [
    { path: ["music", "search"], method: "POST", handler: "search" },
    { path: ["music", "search", "requests"], method: "GET", handler: "requests-get" },
    { path: ["music", "search", "requests"], method: "POST", handler: "requests-post" },
    { path: ["music", "search", "collection"], method: "GET", handler: "collection" },
    { path: ["catalog", "artists", id, "albums"], method: "GET", handler: "bridge" },
    { path: ["catalog", "albums", id, "recordings"], method: "GET", handler: "bridge" },
    { path: ["catalog", "library-albums", "al_fixture", "recordings"], method: "GET", handler: "bridge" },
    { path: ["devices"], method: "GET", handler: "devices" },
    { path: ["devices", "complete-transfer"], method: "POST", handler: "devices" },
    { path: ["music", "sources", id], method: "POST", handler: "music" },
  ];
  for (const entry of cases) {
    const response = await request(entry.path, entry.method);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { handler: entry.handler, method: entry.method });
  }
  const count = calls.length;
  assert.equal((await request(["devices"], "GET", false)).status, 401);
  assert.equal((await request(["catalog", "artists", id, "albums"], "GET", false)).status, 401);
  for (const [path, method] of [
    [["catalog", "artists", id, "albums"], "POST"],
    [["music", "search", "collection"], "POST"],
    [["devices", id, "revoke"], "POST"],
    [["admin"], "GET"],
  ] as const) {
    assert.equal((await request([...path], method)).status, 404);
  }
  assert.equal(calls.length, count, "Rejected requests must not dispatch even for an admin session.");
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
