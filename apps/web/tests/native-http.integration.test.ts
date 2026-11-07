import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import test from "node:test";
import pg from "pg";
import { hash } from "@node-rs/argon2";

const database = process.env.NATIVE_HTTP_DATABASE_URL;
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function port() {
  const server = createServer();
  const value = await listen(server);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return value;
}

test("real Next native login, consumer mutations and signed private audio retain revocation and web isolation", {
  skip: !database && "Set NATIVE_HTTP_DATABASE_URL to a fresh mint_native_test_... database after building @mint/web",
  timeout: 60_000,
}, async () => {
  assert.match(new URL(database!).pathname, /^\/mint_native_test_[a-z0-9_]+$/);
  process.env.DATABASE_URL = database;
  process.env.MINT_SIGNING_SECRET = randomBytes(32).toString("hex");
  const pool = new pg.Pool({ connectionString: database });
  const root = new URL("../../../packages/core/migrations/", import.meta.url);
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", root), "utf8")) as { entries: { tag: string }[] };
  const { getDb, closeDb, schema } = await import("@mint/core/db");
  const { verifyToken, sha256 } = await import("@mint/core/crypto");
  const { MintApi } = await import("@mint/client");
  const { activePlaybackSession } = await import("@mint/core/playback");
  let next: ReturnType<typeof spawn> | undefined, redis: ReturnType<typeof spawn> | undefined;
  const worker = createServer(async (request, response) => {
    const claim = verifyToken<{ userId: string; sessionHash: string; trackId: string }>("playback",
      request.headers.authorization?.replace(/^Bearer /, ""));
    if (!claim || !await activePlaybackSession(claim.sessionHash, claim.userId)) {
      response.writeHead(401).end(); return;
    }
    assert.equal(request.url, `/playback/${claim.trackId}`);
    const partial = request.headers.range === "bytes=0-0";
    response.writeHead(partial ? 206 : 200, { "content-type": "audio/wav", "content-length": partial ? "1" : "4",
      "accept-ranges": "bytes", ...(partial ? { "content-range": "bytes 0-0/4" } : {}) });
    response.end(request.method === "HEAD" ? undefined : partial ? "R" : "RIFF");
  });
  try {
    for (const migration of journal.entries) await pool.query(await readFile(new URL(`${migration.tag}.sql`, root), "utf8"));
    const db = getDb(), password = "fixture-native-listener";
    const passwordHash = await hash(password);
    const [user] = await db.insert(schema.users).values({
      name: "Fixture listener", email: "listener@native-http.test", passwordHash, status: "active", role: "admin",
    }).returning();
    await db.insert(schema.users).values({ name: "Pending", email: "pending@native-http.test", passwordHash, status: "pending" });
    const [track] = await db.insert(schema.tracks).values({
      title: "Synthetic tone", artist: "Fixture artist", stage: "ready", existingFilePath: "/fixture/synthetic.wav",
    }).returning();
    const workerPort = await listen(worker), nextPort = await port(), redisPort = await port();
    const origin = `http://127.0.0.1:${nextPort}`;
    const webOrigin = "http://localhost:8081";
    redis = spawn("redis-server", ["--port", String(redisPort), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
    next = spawn(process.execPath, ["../../node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], {
      cwd: new URL("../", import.meta.url), stdio: "ignore",
      env: { ...process.env, NODE_ENV: "production", DATABASE_URL: database!, REDIS_URL: `redis://127.0.0.1:${redisPort}`,
        PUBLIC_URL: origin, NATIVE_WEB_ORIGINS: webOrigin, PLAYBACK_WORKER_URL: `http://127.0.0.1:${workerPort}` },
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${origin}/api/native/admin`)).status === 404; } catch { /* Owned server is starting. */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "The owned production Next server must become responsive.");
    const preflight = await fetch(`${origin}/api/native/auth/login`, {
      method: "OPTIONS", headers: { origin: webOrigin, "access-control-request-method": "POST",
        "access-control-request-headers": "content-type" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), webOrigin);
    assert.match(preflight.headers.get("access-control-allow-headers")!, /Content-Type/i);
    assert.equal(preflight.headers.has("access-control-allow-credentials"), false);
    const denied = await fetch(`${origin}/api/native/auth/login`, {
      method: "OPTIONS", headers: { origin: "https://attacker.example.com", "access-control-request-method": "POST" },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.has("access-control-allow-origin"), false);
    const login = (email: string, enteredPassword = password) => fetch(`${origin}/api/native/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: webOrigin },
      body: JSON.stringify({ email, password: enteredPassword, deviceId: randomUUID(), deviceName: "Fixture phone" }),
    });
    const incorrect = await login(user!.email, "incorrect-fixture-password");
    assert.equal(incorrect.status, 401);
    assert.equal(incorrect.headers.get("access-control-allow-origin"), webOrigin);
    assert.match((await incorrect.json() as { error: string }).error, /don't match/);
    assert.equal((await login("pending@native-http.test")).status, 403);
    const signedIn = await login(user!.email);
    assert.equal(signedIn.status, 201);
    assert.equal(signedIn.headers.get("access-control-allow-origin"), webOrigin);
    assert.equal(signedIn.headers.has("set-cookie"), false);
    const credential = await signedIn.json() as { token: string; user: { id: string }; deviceId: string };
    assert.equal(credential.user.id, user!.id);
    const headers = { authorization: `Bearer ${credential.token}` };
    const api = new MintApi({ serverUrl: origin, token: credential.token, allowDevelopmentHttp: true });
    assert.equal((await fetch(`${origin}/api/native/auth/session`, { headers })).status, 200);
    assert.equal((await fetch(`${origin}/api/native/player/catalog`, { headers })).status, 200);
    assert.equal((await api.catalog()).items[0]?.id, track!.id);
    const pref = await fetch(`${origin}/api/native/music/preferences`, { headers });
    assert.deepEqual(await pref.json(), { privateSession: false, likes: [], exclusions: [] });
    assert.equal((await fetch(`${origin}/api/native/music/likes/${track!.id}`, { method: "PUT", headers })).status, 200);
    assert.equal((await api.likes()).tracks[0]?.track.id, track!.id);
    const collection = await api.createCollection({ title: "Fixture playlist", trackIds: [track!.id] });
    assert.equal((await api.collections()).collections[0]?.id, collection.id);
    assert.equal((await api.collection(collection.id)).entries[0]?.track.id, track!.id);
    assert.equal((await api.mutateCollection(collection.id, { action: "append", revision: collection.revision, trackIds: [track!.id] })).revision, 2);
    assert.equal((await api.recordHistory({ eventId: randomUUID(), trackId: track!.id, listenedMs: 1000 })).recorded, true);
    assert.equal((await api.history()).entries[0]?.track.id, track!.id);
    assert.equal((await api.trackInfo(track!.id)).track.id, track!.id);
    assert.equal((await fetch(`${origin}/api/native/player/offline`, { headers })).status, 200);
    assert.equal((await fetch(`${origin}/api/native/admin`, { headers })).status, 404);
    assert.equal((await fetch(`${origin}/api/music/preferences`, { headers })).status, 401, "Native bearer cannot authenticate ordinary web routes.");
    assert.equal((await fetch(`${origin}/api/music/preferences`, { headers: { cookie: `mint_session=${credential.token}` } })).status, 401);
    const webToken = randomBytes(32).toString("base64url");
    await db.insert(schema.sessions).values({ id: sha256(webToken), userId: user!.id, expiresAt: new Date(Date.now() + 60_000) });
    const cookie = `mint_session=${webToken}`;
    assert.equal((await fetch(`${origin}/api/music/preferences`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${origin}/api/music/likes/${track!.id}`, {
      method: "PUT", headers: { cookie, origin: "https://attacker.example.com" },
    })).status, 403, "Authenticated web cookies retain their Origin/CSRF guard.");
    assert.equal((await fetch(`${origin}/api/music/likes/${track!.id}`, { method: "PUT", headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${origin}/api/music/likes/${track!.id}`, { method: "PUT", headers: { cookie, origin } })).status, 200);
    const range = await fetch(`${origin}/api/native/player/audio/${track!.id}`, { headers: { ...headers, range: "bytes=0-0" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 0-0/4");
    assert.equal(await range.text(), "R");
    const head = await fetch(`${origin}/api/native/player/audio/${track!.id}`, { method: "HEAD", headers });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(`${origin}/api/native/auth/logout`, { method: "POST", headers })).status, 200);
    assert.equal((await fetch(`${origin}/api/native/player/audio/${track!.id}`, { headers })).status, 401);
  } finally {
    next?.kill("SIGTERM"); redis?.kill("SIGTERM");
    if (worker.listening) await new Promise<void>((resolve) => worker.close(() => resolve()));
    await closeDb(); await pool.end();
  }
});
