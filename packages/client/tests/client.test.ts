import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import {
  ApiError, MintApi, nativeBearer, nativeCredentialSchema, nativeLoginSchema, normalizeServerUrl,
  connectionErrorMessage, preferencesSchema, queuePageSchema,
} from "../src/index";

const deviceId = "12345678-1234-4234-8234-123456789012";
const token = `mn1.${deviceId}.${"a".repeat(43)}`;
test("native credentials have an explicit purpose and installation binding", () => {
  assert.equal(nativeBearer(new Headers({ authorization: `Bearer ${token}` })), token);
  assert.equal(nativeBearer(new Headers({ authorization: `Bearer ${"a".repeat(43)}` })), null);
  assert.equal(nativeLoginSchema.safeParse({ email: "listener@example.com", password: "password", deviceId, deviceName: "Phone" }).success, true);
  assert.equal(nativeCredentialSchema.safeParse({
    token, deviceId, expiresAt: "2027-01-01T00:00:00.000Z",
    user: { id: deviceId, name: "Listener", email: "listener@example.com" },
  }).success, true);
});
test("server connections require HTTPS and canonical root origins", () => {
  assert.equal(normalizeServerUrl(" https://mint.example.com/// "), "https://mint.example.com");
  for (const url of ["http://mint.example.com", "https://user:secret@mint.example.com", "https://mint.example.com/app", "https://mint.example.com?token=x", "file:///music"]) {
    assert.throws(() => normalizeServerUrl(url));
  }
  assert.equal(normalizeServerUrl("http://localhost:3000", true), "http://localhost:3000");
});
test("browser connection failures name the exact app origin and required server restart", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://localhost:8081" } });
  try {
    assert.match(connectionErrorMessage(), /NATIVE_WEB_ORIGINS=http:\/\/localhost:8081/);
    assert.match(connectionErrorMessage(), /restart or redeploy/);
    assert.match(connectionErrorMessage(), /native API routes/);
  } finally {
    if (original) Object.defineProperty(globalThis, "location", original);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
test("native media carries credentials in headers only and public artwork never gets them", () => {
  const api = new MintApi({ serverUrl: "https://mint.example.com", token });
  assert.deepEqual(api.mediaSource(deviceId, "mp3"), {
    uri: `https://mint.example.com/api/native/player/audio/${deviceId}?format=mp3`,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(api.artworkUrl(`/api/artwork/${deviceId}`), `https://mint.example.com/api/artwork/${deviceId}`);
  assert.equal(api.artworkUrl("https://i.scdn.co/image/example"), "https://i.scdn.co/image/example");
  assert.throws(() => api.artworkUrl("https://token:secret@private.example.com/image"));
});
test("API uses only native transport, omits cookies and never forges Origin", async () => {
  const api = new MintApi({ serverUrl: "https://mint.example.com", token, fetch: async (url, init) => {
    assert.equal(url, "https://mint.example.com/api/native/music/preferences");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.has("origin"), false);
    return Response.json({ privateSession: false, likes: [], exclusions: [] });
  } });
  assert.deepEqual(await api.preferences(), { privateSession: false, likes: [], exclusions: [] });
});
test("default browser fetch retains its global receiver and injected transports are unbound", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = function(this: unknown) {
    assert.equal(this, globalThis, "Browser fetch must not receive a MintApi instance as this.");
    return Promise.resolve(Response.json({ privateSession: false, likes: [], exclusions: [] }));
  };
  try {
    const api = new MintApi({ serverUrl: "https://mint.example.com", token });
    await api.preferences();
    const injected = new MintApi({ serverUrl: "https://mint.example.com", token, fetch: function(this: unknown) {
      assert.equal(this, undefined, "Injected functions retain ordinary function-call semantics.");
      return Promise.resolve(Response.json({ privateSession: false, likes: [], exclusions: [] }));
    } });
    await injected.preferences();
  } finally { globalThis.fetch = original; }
});
test("revocation clears auth once and surfaces server failure", async () => {
  let revoked = 0;
  const api = new MintApi({ serverUrl: "https://mint.example.com", token, onUnauthorized: () => { revoked++; },
    fetch: async () => Response.json({ error: "Session revoked." }, { status: 401 }) });
  await assert.rejects(api.preferences(), (error: unknown) => error instanceof ApiError && error.status === 401 && error.message === "Session revoked.");
  assert.equal(revoked, 1);
});
test("malformed success and missing preference fields do not masquerade as success", async () => {
  assert.equal(preferencesSchema.safeParse({ privateSession: false }).success, false);
  const api = new MintApi({ serverUrl: "https://mint.example.com", token, fetch: async () => Response.json({ ok: true }) });
  await assert.rejects(api.preferences(), /incompatible/);
  await assert.rejects(api.request("../admin", z.unknown()), /Invalid consumer/);
});
test("punctuation in bounded catalog queries does not become a path rejection", async () => {
  const api = new MintApi({ serverUrl: "https://mint.example.com", token, fetch: async (url) => {
    assert.equal(new URL(String(url)).searchParams.get("q"), "Wait...hello");
    return Response.json({ items: [], total: 0, start: 0 });
  } });
  assert.equal((await api.catalog({ q: "Wait...hello" })).total, 0);
});
test("shared queue pages preserve bounded occurrence identities", () => {
  const context = { id: deviceId, total: 1000000, revision: 1, offset: 0, position: 0, shuffle: true };
  const item = { id: deviceId, title: "Example", type: "track", queueId: deviceId };
  assert.equal(queuePageSchema.safeParse({ context, items: [item] }).success, true);
  assert.equal(queuePageSchema.safeParse({ context, items: Array(101).fill(item) }).success, false);
});
test("client exports contain no server dependencies", () => {
  const directory = new URL("../src/", import.meta.url);
  for (const file of readdirSync(directory)) {
    const source = readFileSync(new URL(file, directory), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:@mint\/core|node:|next|drizzle-orm|ioredis|pg|server-only)/);
  }
});
