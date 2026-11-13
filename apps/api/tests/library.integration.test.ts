import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, open, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordings } from "@mint/domain-catalog";
import {
  createLibraryRepository, LIBRARY_MEDIA_READ_MAX_BYTES, mediaFiles, roots,
  verifyLibraryMediaFile, type LibraryPlaybackTarget, type LibraryRepository,
} from "@mint/domain-library";
import type { SessionEvidence } from "@mint/domain-accounts";
import { createMintSdk, MintSdkError } from "@mint/sdk";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { startApiRuntime } from "../src/runtime";
import { createApiServer } from "../src/server";

const exec = promisify(execFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));

test("Library SDK -> HTTP -> migrated PG16 authorizes fresh sessions and lists only verified files", {
  timeout: 90_000,
}, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL binaries");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-list-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "sock");
  const database = {
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
    max: 2, connectionTimeoutMillis: 2000, ssl: false as const,
  };
  const observer = new pg.Pool(database);
  const gatewayToken = randomBytes(32).toString("base64url");
  const logged: string[] = [];
  let started = false;
  let runtime: Awaited<ReturnType<typeof startApiRuntime>> | undefined;
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ]);
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-w", "start",
    ]);
    started = true;
    assert.match((await observer.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.equal((await observer.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    runtime = await startApiRuntime({
      database, migrations: { packagesRoot, lockTimeoutMs: 5000 },
      listen: { host: "127.0.0.1", port: 0 }, gatewayToken,
      notifyAccessRequests: async () => {},
      errors: { error: ({ name }) => { logged.push(name); } },
    });
    const url = `${runtime.address}/trpc`;
    const sdk = (sessionToken?: string) => createMintSdk({ url, gatewayToken, sessionToken });
    const request = (input: unknown, sessionToken?: string, serviceToken = gatewayToken) =>
      fetch(`${url}/library.listFiles?input=${encodeURIComponent(JSON.stringify(input))}`, {
        headers: {
          "x-mint-gateway-token": serviceToken,
          ...(sessionToken ? { cookie: `mint_session=${sessionToken}` } : {}),
          "x-mint-user-role": "admin", "x-mint-user-status": "active",
        },
      });

    const tokens: Record<string, string> = {};
    const userIds: Record<string, string> = {};
    for (const [label, role, status] of [
      ["member", "user", "active"], ["admin", "admin", "active"],
      ["pending", "user", "pending"], ["denied", "user", "denied"],
      ["disabled", "user", "disabled"], ["expired", "user", "active"],
      ["revoked", "user", "active"],
    ]) {
      assert.ok(label && role && status);
      const token = randomBytes(32).toString("base64url");
      tokens[label] = token;
      const user = await observer.query<{ id: string }>(
        `INSERT INTO accounts.users (email, name, password_hash, role, status)
         VALUES ($1, $2, 'fixture', $3, $4) RETURNING id`,
        [`${label}@fixture.test`, label, role, status],
      );
      const id = user.rows[0]!.id;
      userIds[label] = id;
      if (label !== "revoked") {
        await observer.query(
          "INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ($1, $2, $3)",
          [hash(token), id, new Date(Date.now() + (label === "expired" ? -60_000 : 86_400_000))],
        );
      }
    }

    const repository = createLibraryRepository(drizzle(observer, { schema: { roots, mediaFiles, recordings } }));
    const root = await repository.createRoot({ path: "/fixture-private-root" });
    const db = drizzle(observer);
    const [recording] = await db.insert(recordings).values({
      title: "Confirmed song", version: "Catalog version", durationMs: 230_000,
    }).returning();
    assert.ok(recording);
    const verified: string[] = [];
    for (let index = 0; index < 105; index++) {
      const file = await repository.createMediaFile({
        rootId: root.id, relativePath: `private/folder/file-${index}.flac`,
        recordingId: index < 2 ? recording.id : null,
        importedTags: index < 3 ? {
          title: "Caf\u00e9 Echo", artist: "Fixture Artist", album: "Fixture Album",
          version: index === 0 ? "Original" : index === 1 ? "Live" : null,
        } : { title: `Fixture song ${index}` },
      });
      await repository.recordVerification(file.id, {
        availability: "verified", checkedAt: new Date(),
        audio: { streamIndex: 0, codec: "flac", decodedSampleFrames: 100, durationMs: 120_000 },
      });
      verified.push(file.id);
    }
    const unverified = await repository.createMediaFile({
      rootId: root.id, relativePath: "not-verified.flac",
    });
    const unavailable = await repository.createMediaFile({
      rootId: root.id, relativePath: "missing.flac",
    });
    await repository.recordVerification(unavailable.id, {
      availability: "verified", checkedAt: new Date(0),
      audio: { streamIndex: 0, codec: "flac", decodedSampleFrames: 100 },
    });
    await repository.recordVerification(unavailable.id, {
      availability: "unavailable", checkedAt: new Date(), reason: "missing",
    });

    const member = sdk(tokens.member);
    assert.equal((await member.accounts.session())?.id, userIds.member);
    assert.equal((await member.library.listFiles()).items.length, 50);
    assert.equal((await member.library.listFiles({ limit: 100 })).items.length, 100);
    assert.equal((await sdk(tokens.admin).library.listFiles({ limit: 1 })).items.length, 1);
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await member.library.listFiles({ limit: 17, cursor });
      assert.ok(page.items.length <= 17);
      for (const item of page.items) {
        assert.deepEqual(Object.keys(item).sort(),
          ["album", "artist", "durationMs", "id", "recordingId", "title", "version"]);
        all.push(item.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(all, [...verified].sort());
    assert.equal(new Set(all).size, 105);
    assert.ok(!all.includes(unverified.id) && !all.includes(unavailable.id));
    const search = await member.library.listFiles({ search: " ECHO caf\u00e9 ", limit: 1 });
    assert.ok(search.nextCursor);
    const rest = await member.library.listFiles({ search: "echo cafe", limit: 100, cursor: search.nextCursor });
    const matches = [...search.items, ...rest.items];
    assert.equal(matches.length, 3);
    assert.equal(matches.filter((item) => item.recordingId === recording.id).length, 2);
    assert.equal(matches.filter((item) => item.recordingId === null).length, 1);
    assert.deepEqual(matches.map((item) => item.version).sort(), ["Live", "Original", null].sort());
    assert.ok(matches.every((item) => item.durationMs === 120_000 && item.title === "Caf\u00e9 Echo"));
    assert.deepEqual(await member.library.listFiles({ search: "%" }), { items: [], nextCursor: null });
    assert.equal((await request({ cursor: search.nextCursor, search: "different" }, tokens.member)).status, 400);
    assert.equal((await request({ cursor: "a" }, tokens.member)).status, 400);
    for (const input of [
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "1" },
      { search: "x".repeat(201) }, { search: "\0" }, { cursor: "x".repeat(2049) },
      { cursor: "" }, { actor: { role: "admin" } }, null,
    ]) {
      assert.equal((await request(input, tokens.member)).status, 400);
    }
    for (const token of [undefined, tokens.pending, tokens.denied, tokens.disabled, tokens.expired, tokens.revoked]) {
      assert.equal((await request({}, token)).status, 401);
      await assert.rejects(sdk(token).library.listFiles(), (error: unknown) =>
        error instanceof MintSdkError && error.code === "RPC_ERROR");
    }
    assert.equal((await request({}, tokens.member, randomBytes(32).toString("base64url"))).status, 401);
    assert.equal((await fetch(`${url}/library.listFiles`)).status, 401);
    const omittedInput = await fetch(`${url}/library.listFiles`, {
      headers: { "x-mint-gateway-token": gatewayToken, cookie: `mint_session=${tokens.member}` },
    });
    assert.equal(omittedInput.status, 200);
    assert.match(omittedInput.headers.get("cache-control") ?? "", /private, no-store/);

    // The same SDK instance must observe persisted revocation/status changes immediately.
    await observer.query("UPDATE accounts.users SET status = 'disabled' WHERE id = $1", [userIds.member]);
    await assert.rejects(member.library.listFiles(), MintSdkError);
    await observer.query("UPDATE accounts.users SET status = 'active' WHERE id = $1", [userIds.member]);
    assert.equal((await member.library.listFiles({ limit: 1 })).items.length, 1);
    await observer.query("DELETE FROM accounts.sessions WHERE id = $1", [hash(tokens.member!)]);
    await assert.rejects(member.library.listFiles(), MintSdkError);
    assert.equal(await member.accounts.session(), null);
    assert.deepEqual(logged, []);

    const music = path.join(cluster, "music");
    const wav = path.join(music, "original.wav");
    await mkdir(music);
    await exec("/usr/bin/ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1",
      "-c:a", "pcm_s16le", wav,
    ]);
    const original = await readFile(wav);
    const playbackRoot = await repository.createRoot({ path: music });
    const playbackFile = await repository.createMediaFile({ rootId: playbackRoot.id, relativePath: "original.wav" });
    const verification = await verifyLibraryMediaFile(repository, playbackFile.id, {
      ffprobePath: "/usr/bin/ffprobe", ffmpegPath: "/usr/bin/ffmpeg",
      maxProbeInputBytes: 1024 * 1024, maxDecodeInputBytes: 1024 * 1024,
      maxOutputBytes: 1024 * 1024, probeTimeoutMs: 5000, decodeTimeoutMs: 5000,
    });
    assert.equal(verification.status, "verified");
    const mediaUrl = `${runtime.address}/media/${playbackFile.id}`;
    const mediaHeaders = { "x-mint-gateway-token": gatewayToken, cookie: `mint_session=${tokens.admin}` };
    const full = await fetch(mediaUrl, { headers: mediaHeaders });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "audio/wav");
    assert.equal(full.headers.get("content-length"), String(original.length));
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), original);
    const partial = await fetch(mediaUrl, { headers: { ...mediaHeaders, range: "bytes=31-1234" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), `bytes 31-1234/${original.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), original.subarray(31, 1235));
    const head = await fetch(mediaUrl, { method: "HEAD", headers: mediaHeaders });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(original.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    await observer.query("UPDATE accounts.users SET status = 'disabled' WHERE id = $1", [userIds.admin]);
    assert.equal((await fetch(mediaUrl, { headers: mediaHeaders })).status, 401);
    await observer.query("UPDATE accounts.users SET status = 'active' WHERE id = $1", [userIds.admin]);
    await rm(wav);
    assert.equal((await fetch(mediaUrl, { headers: mediaHeaders })).status, 404);
    assert.equal((await observer.query(
      "SELECT availability FROM library.media_files WHERE id = $1", [playbackFile.id],
    )).rows[0].availability, "unavailable");
    assert.deepEqual(logged, []);

    // Real database failures must be explicit, sanitized failures, never empty pages.
    await observer.query("ALTER TABLE library.media_files RENAME TO fixture_hidden_files");
    try {
      const failure = await request({}, tokens.admin);
      assert.equal(failure.status, 500);
      const body = await failure.text();
      assert.match(body, /Internal server error/);
      assert.doesNotMatch(body, /fixture_hidden|media_files|SELECT|fixture-private-root/);
      await assert.rejects(sdk(tokens.admin).library.listFiles(), (error: unknown) =>
        error instanceof MintSdkError && error.code === "RPC_ERROR");
      assert.equal(logged.length, 2);
      assert.ok(logged.every((name) => name === "Error"));
    } finally {
      await observer.query("ALTER TABLE library.fixture_hidden_files RENAME TO media_files");
    }
    assert.equal((await sdk(tokens.admin).library.listFiles({ limit: 1 })).items.length, 1);
    const address = runtime.address;
    await runtime.stop();
    runtime = undefined;
    await assert.rejects(fetch(`${address}/trpc/library.listFiles`));
    assert.equal(Number((await observer.query(
      "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'mint-api-runtime'",
    )).rows[0].count), 0);
  } finally {
    try {
      await runtime?.stop();
    } finally {
      await observer.end();
      if (started) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
      await rm(cluster, { recursive: true, force: true });
    }
  }
});

test("Library factory compatibility fails explicitly when unavailable and validates repository output", async () => {
  const gatewayToken = randomBytes(32).toString("base64url");
  const logged: string[] = [];
  const dependencies = {
    gatewayToken,
    sessions: { findByTokenHash: async () => ({
      expiresAt: new Date(Date.now() + 60_000),
      principal: {
        id: "00000000-0000-0000-0000-000000000001", email: "fixture@fixture.test",
        name: "Fixture", role: "user" as const, status: "active" as const,
      },
    }) },
    decisions: { decidePendingAccess: async () => {}, countPending: async () => 0 },
    notifyAccessRequests: async () => {},
    errors: { error: ({ name }: { name: string }) => { logged.push(name); } },
  };
  const headers = { "x-mint-gateway-token": gatewayToken, cookie: `mint_session=${randomBytes(32).toString("base64url")}` };
  const unavailable = createApiServer(dependencies);
  try {
    assert.equal((await unavailable.inject({ url: "/trpc/library.listFiles", headers })).statusCode, 503);
    assert.equal((await unavailable.inject({ url: "/trpc/accounts.session", headers })).statusCode, 200);
  } finally {
    await unavailable.close();
  }
  const invalid = createApiServer({
    ...dependencies, library: { listFiles: async () => ({
      items: [{
        id: "not-a-uuid", recordingId: null, title: "", artist: "Fixture", album: "Fixture",
        version: null, durationMs: -1,
      }], nextCursor: null,
    }) },
  });
  try {
    const response = await invalid.inject({ url: "/trpc/library.listFiles", headers });
    assert.equal(response.statusCode, 500);
    assert.match(response.body, /Internal server error/);
    assert.doesNotMatch(response.body, /not-a-uuid|Zod|stack/);
    assert.equal(logged.length, 1);
  } finally {
    await invalid.close();
  }
});

async function mediaFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "mint-api-media-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(LIBRARY_MEDIA_READ_MAX_BYTES * 4 + 17);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  await writeFile(path.join(directory, "fixture.flac"), bytes);
  await writeFile(path.join(directory, "unsupported.bin"), bytes);
  const probe = await open(path.join(directory, "fixture.flac"), "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const handles = new Set<FileHandle>();
  const originalStat = prototype.stat;
  t.mock.method(prototype, "stat", function (this: FileHandle, ...args: Parameters<FileHandle["stat"]>) {
    handles.add(this);
    return originalStat.apply(this, args);
  });
  const rootId = randomUUID();
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const gatewayToken = randomBytes(32).toString("base64url");
  const now = new Date();
  const evidence: SessionEvidence = {
    expiresAt: new Date(now.getTime() + 60_000),
    principal: {
      id: randomUUID(), email: "fixture@example.test", name: "Fixture", role: "user", status: "active",
    },
  };
  const state = {
    evidence: evidence as SessionEvidence | null,
    sessionReads: 0,
    targetReads: 0,
    target: {
      root: { id: rootId, path: directory },
      mediaFile: { rootId, relativePath: "fixture.flac" },
      availability: "verified", audioCodec: "flac",
    } as LibraryPlaybackTarget | null,
    failure: null as Error | null,
    sessionFailure: null as Error | null,
    writes: [] as Parameters<LibraryRepository["recordVerification"]>[],
    errors: [] as string[],
  };
  const headers = { "x-mint-gateway-token": gatewayToken, cookie: `mint_session=${token}` };
  const dependencies = {
    gatewayToken,
    sessions: { findByTokenHash: async (value: string) => {
      state.sessionReads++;
      if (state.sessionFailure) throw state.sessionFailure;
      return value === hash(token) ? state.evidence : null;
    } },
    decisions: { decidePendingAccess: async () => {}, countPending: async () => 0 },
    libraryMedia: {
      getPlaybackTarget: async (value: string) => {
        state.targetReads++;
        if (state.failure) throw state.failure;
        return value === id ? state.target : null;
      },
      recordVerification: async (...args: Parameters<LibraryRepository["recordVerification"]>) => {
        state.writes.push(args);
      },
    },
    notifyAccessRequests: async () => {},
    errors: { error: ({ name }: { name: string }) => { state.errors.push(name); } },
    now: () => now,
  };
  const app = createApiServer(dependencies);
  t.after(async () => {
    await app.close();
    assert.ok([...handles].every((handle) => handle.fd === -1), "Every opened media handle must be closed");
  });
  const request = (options: { method?: "GET" | "HEAD"; range?: string; cookie?: string; url?: string } = {}) =>
    app.inject({
      method: options.method ?? "GET", url: options.url ?? `/media/${id}`,
      headers: {
        ...headers,
        ...(options.range === undefined ? {} : { range: options.range }),
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      },
    });
  return { app, state, request, headers, id, bytes, handles, prototype, dependencies };
}

test("private media authenticates gateway before lookup and re-resolves active sessions on every request", async (t) => {
  const { app, state, request, headers, id } = await mediaFixture(t);
  for (const method of ["GET", "HEAD"] as const) {
    for (const value of ["", randomBytes(32).toString("base64url")]) {
      const response = await app.inject({
        method, url: `/media/${id}`,
        headers: { ...headers, "x-mint-gateway-token": value },
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers["cache-control"], "private, no-store");
    }
  }
  assert.equal(state.sessionReads, 0);
  assert.equal(state.targetReads, 0);
  for (const cookie of ["", "mint_session=unknown", `${headers.cookie}; ${headers.cookie}`, "mint_session=mn1.native"]) {
    assert.equal((await request({ cookie })).statusCode, 401);
  }
  const forged = await app.inject({
    url: `/media/${id}`,
    headers: {
      ...headers, cookie: "", authorization: "Bearer forged-session",
      "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1",
      "x-mint-client-ip": "127.0.0.1", "x-mint-user-role": "admin", "x-mint-user-status": "active",
    },
  });
  assert.equal(forged.statusCode, 401);
  const evidence = state.evidence!;
  for (const status of ["pending", "denied", "disabled"] as const) {
    state.evidence = { ...evidence, principal: { ...evidence.principal, status } };
    assert.equal((await request()).statusCode, 401);
  }
  state.evidence = { ...evidence, expiresAt: new Date(0) };
  assert.equal((await request()).statusCode, 401);
  state.evidence = null;
  assert.equal((await request()).statusCode, 401);
  assert.equal(state.targetReads, 0);
  for (const role of ["user", "admin"] as const) {
    state.evidence = { ...evidence, principal: { ...evidence.principal, role } };
    assert.equal((await request()).statusCode, 200);
  }
  state.evidence = { ...evidence, principal: { ...evidence.principal, status: "disabled" } };
  assert.equal((await request()).statusCode, 401);
  assert.equal(state.targetReads, 2);
  assert.deepEqual(state.errors, []);
});

test("media GET and HEAD preserve exact original bytes, safe headers and single-range semantics", async (t) => {
  const { request, bytes, state } = await mediaFixture(t);
  for (const [range, start, end] of [
    [undefined, 0, bytes.length - 1],
    [`bytes=0-${bytes.length - 1}`, 0, bytes.length - 1],
    ["bytes=31-1234", 31, 1234],
    ["bytes=950-", 950, bytes.length - 1],
    ["bytes=-777", bytes.length - 777, bytes.length - 1],
    [`bytes=${bytes.length - 10}-${bytes.length + 999}`, bytes.length - 10, bytes.length - 1],
    ["bytes=0-0", 0, 0],
  ] as const) {
    for (const method of ["GET", "HEAD"] as const) {
      const response = await request({ method, range });
      assert.equal(response.statusCode, range === undefined ? 200 : 206);
      assert.equal(response.headers["content-type"], "audio/flac");
      assert.equal(response.headers["content-length"], String(end - start + 1));
      assert.equal(response.headers["accept-ranges"], "bytes");
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.equal(response.headers["content-range"],
        range === undefined ? undefined : `bytes ${start}-${end}/${bytes.length}`);
      for (const header of ["location", "content-disposition", "etag", "last-modified", "set-cookie"]) {
        assert.equal(response.headers[header], undefined);
      }
      assert.deepEqual(response.rawPayload, method === "HEAD" ? Buffer.alloc(0) : bytes.subarray(start, end + 1));
    }
  }
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.errors, []);
});

test("media ranges reject malformed, multiple and unsatisfiable ranges with 416 and close the handle", async (t) => {
  const { request, bytes, state } = await mediaFixture(t);
  for (const range of [
    "bytes=", "items=0-1", "bytes=0-1,2-3", "bytes=-0", "bytes=3-2",
    `bytes=${bytes.length}-`, "bytes=9007199254740992-", "bytes=0-1 ",
  ]) {
    for (const method of ["GET", "HEAD"] as const) {
      const response = await request({ range, method });
      assert.equal(response.statusCode, 416);
      assert.equal(response.headers["content-range"], `bytes */${bytes.length}`);
      assert.equal(response.headers["accept-ranges"], "bytes");
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.doesNotMatch(response.body, /fixture|\.flac|stack/);
    }
  }
  assert.deepEqual(state.errors, []);
});

test("media validates IDs and intentionally hides missing/unverified files, unsupported formats and internal failures", async (t) => {
  const { app, request, state, dependencies, headers } = await mediaFixture(t);
  for (const id of ["not-a-uuid", "%2e%2e%2fprivate.flac", "0".repeat(36)]) {
    assert.equal((await request({ url: `/media/${id}` })).statusCode, 400);
  }
  assert.equal(state.targetReads, 0);
  const target = state.target!;
  for (const availability of ["unverified", "unavailable"] as const) {
    state.target = { ...target, availability };
    assert.equal((await request()).statusCode, 404);
  }
  state.target = null;
  assert.equal((await request()).statusCode, 404);
  state.target = { ...target, mediaFile: { ...target.mediaFile, relativePath: "absent.flac" } };
  assert.equal((await request()).statusCode, 404);
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0]?.[1].availability, "unavailable");
  state.target = { ...target, mediaFile: { ...target.mediaFile, relativePath: "unsupported.bin" } };
  assert.equal((await request()).statusCode, 415);
  state.failure = new Error("/private/fixture.flac SELECT password secret");
  const failure = await request();
  assert.equal(failure.statusCode, 500);
  assert.deepEqual(failure.json(), { error: "Internal server error" });
  state.failure = null;
  state.sessionFailure = new Error("private session database failure");
  assert.deepEqual((await request()).json(), { error: "Internal server error" });
  assert.deepEqual(state.errors, ["Error", "Error"]);
  const unavailable = createApiServer({ ...dependencies, libraryMedia: undefined });
  try {
    state.sessionFailure = null;
    const response = await unavailable.inject({ url: "/media/00000000-0000-4000-8000-000000000001", headers });
    assert.equal(response.statusCode, 503);
  } finally {
    await unavailable.close();
  }
  assert.equal(app.server.listening, false);
});

test("HEAD never reads bytes, while GET uses bounded lazy reads and closes after success", async (t) => {
  const { request, prototype, bytes } = await mediaFixture(t);
  const read = t.mock.method(prototype, "read");
  assert.equal((await request({ method: "HEAD" })).statusCode, 200);
  assert.equal(read.mock.callCount(), 0);
  const response = await request();
  assert.deepEqual(response.rawPayload, bytes);
  assert.equal(read.mock.callCount(), Math.ceil(bytes.length / LIBRARY_MEDIA_READ_MAX_BYTES));
  for (const call of read.mock.calls) {
    const args: readonly unknown[] = call.arguments;
    assert.ok(Number(args[2]) <= LIBRARY_MEDIA_READ_MAX_BYTES);
  }
});

test("media read errors close the handle and return only a sanitized error before headers", async (t) => {
  const { request, prototype, state } = await mediaFixture(t);
  t.mock.method(prototype, "read", async () => { throw new Error("/private/media read failed secret"); });
  const response = await request();
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: "Internal server error" });
  assert.equal(response.headers["content-range"], undefined);
  assert.equal(response.headers["accept-ranges"], undefined);
  assert.equal(Number(response.headers["content-length"]), Buffer.byteLength(response.body));
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(state.errors, ["LibraryMediaStreamError", "Error"]);
});

test("client disconnect during an in-flight read deterministically closes the media handle", { timeout: 10_000 }, async (t) => {
  const { app, headers, id, prototype, handles, state } = await mediaFixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { entered = resolve; });
  const read = prototype.read;
  let calls = 0;
  t.mock.method(prototype, "read", async function (this: FileHandle, ...args: Parameters<FileHandle["read"]>) {
    if (++calls === 2) {
      entered();
      await gate;
    }
    return read.apply(this, args);
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = httpRequest(`${address}/media/${id}`, { headers });
  const response = once(client, "response");
  client.end();
  try {
    const [incoming] = await response;
    await pending;
    const closed = Promise.all([...handles].map((handle) => {
      assert.ok(handle instanceof EventEmitter);
      return once(handle, "close");
    }));
    incoming.destroy();
    client.destroy();
    await closed;
    assert.ok([...handles].every((handle) => handle.fd === -1));
  } finally {
    release();
    client.destroy();
  }
  assert.deepEqual(state.errors, []);
});

test("client disconnect while the media opener is pending closes the handle before returning", {
  timeout: 10_000,
}, async (t) => {
  const { app, headers, id, prototype, handles, state } = await mediaFixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { entered = resolve; });
  const stat = prototype.stat;
  t.mock.method(prototype, "stat", async function (this: FileHandle, ...args: Parameters<FileHandle["stat"]>) {
    const info = await stat.apply(this, args);
    entered();
    await gate;
    return info;
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = httpRequest(`${address}/media/${id}`, { headers });
  client.on("error", () => {});
  const cancelled = new Promise<void>((resolve) => app.server.once("request", (_request, response) => {
    response.once("close", resolve);
  }));
  client.end();
  try {
    await pending;
    const closed = Promise.all([...handles].map((handle) => {
      assert.ok(handle instanceof EventEmitter);
      return once(handle, "close");
    }));
    client.destroy();
    await cancelled;
    release();
    await closed;
    assert.ok([...handles].every((handle) => handle.fd === -1));
    assert.deepEqual(state.errors, []);
  } finally {
    release();
    client.destroy();
  }
});

test("media read failure after headers terminates the HTTP body and closes the handle without leaking details", {
  timeout: 10_000,
}, async (t) => {
  const { app, headers, id, prototype, handles, state } = await mediaFixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const read = prototype.read;
  let calls = 0;
  t.mock.method(prototype, "read", async function (this: FileHandle, ...args: Parameters<FileHandle["read"]>) {
    if (++calls === 2) {
      await gate;
      throw new Error("/private/fixture.flac secret read failure");
    }
    return read.apply(this, args);
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = httpRequest(`${address}/media/${id}`, { headers });
  const response = once(client, "response");
  client.end();
  try {
    const [incoming] = await response;
    assert.equal(incoming.statusCode, 200);
    assert.equal(incoming.headers["content-type"], "audio/flac");
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    const aborted = once(incoming, "aborted");
    const closed = Promise.all([...handles].map((handle) => {
      assert.ok(handle instanceof EventEmitter);
      return once(handle, "close");
    }));
    incoming.on("error", () => {});
    release();
    await aborted;
    await closed;
    assert.equal(incoming.complete, false);
    assert.equal(Buffer.concat(chunks).length, LIBRARY_MEDIA_READ_MAX_BYTES);
    assert.deepEqual(state.errors, ["LibraryMediaStreamError"]);
  } finally {
    release();
    client.destroy();
  }
});
