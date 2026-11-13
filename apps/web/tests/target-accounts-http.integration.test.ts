import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startApiRuntime } from "@mint/api";
import { libraryFilePageSchema, type LibraryFileListItem } from "@mint/contracts";
import pg from "pg";

const exec = promisify(execFile);
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));
const require = createRequire(import.meta.url);
const apiRoot = path.resolve(path.dirname(require.resolve("@mint/api")), "..");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function stopNext(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try { await exited; } finally { clearTimeout(timer); }
}

test("real Next gateways use generated audio, confined verification, SDK, API and fresh PostgreSQL storage", {
  timeout: 240_000,
}, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL 16 binaries");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const work = await mkdtemp(path.join(tmpdir(), "mint-next-"));
  const data = path.join(work, "pg");
  const socket = path.join(work, "sock");
  const app = path.join(work, "web");
  const music = path.join(work, "music");
  const buildInfo = path.join(webRoot, "tsconfig.tsbuildinfo");
  const originalBuildInfo = hash(await readFile(buildInfo));
  const gatewayToken = randomBytes(32).toString("base64url");
  const adminToken = randomBytes(32).toString("base64url");
  const memberToken = randomBytes(32).toString("base64url");
  const expiredToken = randomBytes(32).toString("base64url");
  const database = {
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
    max: 2, connectionTimeoutMillis: 2000, ssl: false as const,
  };
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test" as const, PGHOST: socket,
    PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture",
  };
  const observer = new pg.Pool(database);
  const notifications: number[] = [];
  const errors: string[] = [];
  let postgresStarted = false;
  let runtime: Awaited<ReturnType<typeof startApiRuntime>> | undefined;
  let next: ChildProcess | undefined;
  let nextLogs = "";
  let succeeded = false;

  async function mediaFixture(removeId?: string): Promise<LibraryFileListItem[]> {
    // Resolve public domain exports from their existing API workspace dependency context.
    // The Next project itself never imports a domain package or receives a media mount.
    const script = `
      import assert from "node:assert/strict";
      import { execFile } from "node:child_process";
      import { createHash } from "node:crypto";
      import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
      import path from "node:path";
      import { promisify } from "node:util";
      import { recordings } from "@mint/domain-catalog";
      import { createLibraryRepository, mediaFiles, roots, verifyLibraryMediaFile } from "@mint/domain-library";
      import { eq } from "drizzle-orm";
      import { drizzle } from "drizzle-orm/node-postgres";
      import pg from "pg";
      const pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 2000 });
      const db = drizzle(pool, { schema: { roots, mediaFiles, recordings } });
      const repository = createLibraryRepository(db);
      const music = ${JSON.stringify(music)};
      const removeId = ${JSON.stringify(removeId ?? null)};
      const options = {
        ffprobePath: "/usr/bin/ffprobe", ffmpegPath: "/usr/bin/ffmpeg",
        maxProbeInputBytes: 2 * 1024 * 1024, maxDecodeInputBytes: 2 * 1024 * 1024,
        maxOutputBytes: 1024 * 1024, probeTimeoutMs: 5000, decodeTimeoutMs: 5000,
      };
      try {
        if (removeId) {
          const [before] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, removeId));
          assert.ok(before);
          await rm(path.join(music, "original-0.wav"));
          const missing = await verifyLibraryMediaFile(repository, removeId, options);
          assert.equal(missing.status, "unavailable");
          assert.equal(missing.outcome.reason, "missing");
          const [after] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, removeId));
          assert.deepEqual(after, {
            ...before, availability: "unavailable",
            checkedAt: missing.outcome.checkedAt, unavailableReason: "missing",
          });
        } else {
          await mkdir(music);
          const seed = path.join(music, "generated.wav");
          await promisify(execFile)("/usr/bin/ffmpeg", [
            "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.5",
            "-c:a", "pcm_s16le", "-metadata", "title=Caf\\u00e9 Echo",
            "-metadata", "artist=Fixture Artist", "-metadata", "album=Fixture Album", seed,
          ], { timeout: 10000 });
          const digest = bytes => createHash("sha256").update(bytes).digest("hex");
          const originalHash = digest(await readFile(seed));
          const root = await repository.createRoot({ path: music });
          const [recording] = await db.insert(recordings).values({
            title: "Confirmed title", version: "Catalog version", durationMs: 9999,
          }).returning();
          const unverified = await repository.createMediaFile({
            rootId: root.id, relativePath: "generated.wav", importedTags: { title: "Unverified audio" },
          });
          for (let index = 0; index < 105; index++) {
            const relativePath = "original-" + index + ".wav";
            await copyFile(seed, path.join(music, relativePath));
            const file = await repository.createMediaFile({
              rootId: root.id, relativePath, recordingId: index < 2 ? recording.id : null,
              importedTags: { version: index === 0 ? "Original" : index === 1 ? "Live" : null },
            });
            const result = await verifyLibraryMediaFile(repository, file.id, options);
            assert.equal(result.status, "verified");
            assert.equal(result.metadata, "imported");
            assert.deepEqual(result.observation.audio, {
              streamIndex: 0, codec: "pcm_s16le", decodedSampleFrames: 22050, durationMs: 500,
            });
            const [stored] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, file.id));
            assert.equal(stored.availability, "verified");
            assert.equal(stored.importedTitle, "Caf\\u00e9 Echo");
            assert.equal(stored.importedArtist, "Fixture Artist");
            assert.equal(stored.importedAlbum, "Fixture Album");
            assert.equal(stored.audioCodec, "pcm_s16le");
            assert.equal(stored.decodedSampleFrames, 22050);
            assert.equal(stored.durationMs, 500);
            assert.equal(digest(await readFile(path.join(music, relativePath))), originalHash);
            if (index >= 3) await repository.replaceImportedTags(file.id, {
              title: "Fixture song " + index, artist: "Other artist", album: "Other album",
            });
          }
          assert.equal(digest(await readFile(seed)), originalHash);
          const [untouched] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, unverified.id));
          assert.equal(untouched.availability, "unverified");
          assert.equal(untouched.verifiedAt, null);
          assert.equal((await db.select().from(recordings)).length, 1);
        }
        const pages = [];
        let cursor;
        do {
          const page = await repository.listFiles({ limit: 100, cursor });
          pages.push(page);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        console.log(JSON.stringify(pages));
      } finally { await pool.end(); }
    `;
    const result = await exec(process.execPath, [
      "--import", require.resolve("tsx/esm"), "--input-type=module", "--eval", script,
    ], { cwd: apiRoot, env, timeout: 90_000, maxBuffer: 1024 * 1024 });
    const pages: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(pages));
    return pages.flatMap((page: unknown) => libraryFilePageSchema.parse(page).items);
  }

  async function startNext(configured: boolean): Promise<string> {
    nextLogs = "";
    // The isolated project copies the actual application sources and links installed packages.
    // Next's generated types/build output must not rewrite the shared checkout.
    const script = `
      import { createRequire } from "node:module";
      import { createServer } from "node:http";
      const require = createRequire(${JSON.stringify(path.join(webRoot, "package.json"))});
      const next = require(${JSON.stringify(require.resolve("next"))});
      const app = next({ dev: true, webpack: true, dir: ${JSON.stringify(app)} });
      await app.prepare();
      const server = createServer(app.getRequestHandler());
      server.listen(0, "127.0.0.1", () => {
        const origin = "http://127.0.0.1:" + server.address().port;
        if (${configured}) process.env.MINT_TARGET_WEB_ORIGIN = origin;
        process.send({ origin });
      });
      process.once("SIGTERM", async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await app.close();
        process.exit(0);
      });
    `;
    next = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: app, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
        ...(configured ? {
          MINT_TARGET_API_URL: `${runtime!.address}/trpc`,
          MINT_TARGET_GATEWAY_TOKEN: gatewayToken,
        } : {}),
      },
    });
    next.stdout!.on("data", (chunk: Buffer) => { nextLogs += chunk.toString(); });
    next.stderr!.on("data", (chunk: Buffer) => { nextLogs += chunk.toString(); });
    const child = next;
    const origin = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Owned Next server startup timed out.")), 60_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("Owned Next server exited during startup.")); });
      child.once("message", (message: unknown) => {
        clearTimeout(timeout);
        assert.ok(message && typeof message === "object" && "origin" in message && typeof message.origin === "string");
        resolve(message.origin);
      });
    });
    const probe = await fetch(`${origin}/api/accounts/session`, { signal: AbortSignal.timeout(60_000) });
    assert.equal(probe.status, configured ? 200 : 503, "Owned Next must execute the real session route.");
    await probe.text();
    return origin;
  }

  async function checked(response: Response, status: number, message?: string) {
    assert.equal(response.status, status, message);
    assert.match(response.headers.get("cache-control") ?? "", /private/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(response.headers.has("access-control-allow-origin"), false);
    const text = await response.text();
    for (const secret of [gatewayToken, adminToken, memberToken, expiredToken, runtime?.address, music].filter(Boolean)) {
      assert.equal(text.includes(secret!), false, "Public response must not expose connection or session evidence.");
    }
    return JSON.parse(text) as unknown;
  }

  try {
    await mkdir(socket);
    await mkdir(app);
    await Promise.all([
      cp(path.join(webRoot, "src"), path.join(app, "src"), { recursive: true }),
      symlink(path.join(webRoot, "node_modules"), path.join(app, "node_modules"), "dir"),
      symlink(path.join(webRoot, "package.json"), path.join(app, "package.json")),
      writeFile(path.join(app, "tsconfig.json"), JSON.stringify({
        extends: path.join(webRoot, "tsconfig.json"),
        compilerOptions: { incremental: false, baseUrl: app },
        include: ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", ".next/types/**/*.ts"],
      })),
      writeFile(path.join(app, "next.config.mjs"), `
        import config from ${JSON.stringify(new URL("../next.config.ts", import.meta.url).href)};
        export default { ...config, output: undefined };
      `),
    ]);
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ], { env });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(work, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`, "-w", "start",
    ], { env });
    postgresStarted = true;
    assert.match((await observer.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.equal((await observer.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    runtime = await startApiRuntime({
      database, gatewayToken, migrations: { packagesRoot, lockTimeoutMs: 5000 },
      listen: { host: "127.0.0.1", port: 0 },
      notifyAccessRequests: async ({ pending }) => { notifications.push(pending); },
      errors: { error: ({ name }) => { errors.push(name); } },
    });
    assert.equal((await observer.query("SELECT to_regclass('public.users') AS name")).rows[0].name, null);
    const { rows: [admin, member, pending] } = await observer.query<{
      id: string; email: string; name: string; role: string; status: string;
    }>(`INSERT INTO accounts.users (email, name, password_hash, role, status) VALUES
      ('admin@gateway.test', 'Admin', 'fixture', 'admin', 'active'),
      ('member@gateway.test', 'Member', 'fixture', 'user', 'active'),
      ('pending@gateway.test', 'Pending', 'fixture', 'user', 'pending')
      RETURNING id, email, name, role, status`);
    assert.ok(admin && member && pending);
    await observer.query(
      `INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES
       ($1, $2, now() + interval '30 days'), ($3, $4, now() + interval '30 days'),
       ($5, $4, now() - interval '1 second')`,
      [hash(adminToken), admin.id, hash(memberToken), member.id, hash(expiredToken)],
    );
    const inactiveTokens: string[] = [];
    for (const status of ["pending", "denied", "disabled"]) {
      const token = randomBytes(32).toString("base64url");
      const { rows: [user] } = await observer.query<{ id: string }>(
        `INSERT INTO accounts.users (email, name, password_hash, role, status)
         VALUES ($1, 'Inactive', 'fixture', 'user', $2) RETURNING id`,
        [`inactive-${status}@gateway.test`, status],
      );
      await observer.query(
        "INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [hash(token), user!.id],
      );
      inactiveTokens.push(token);
    }
    const verifiedFiles = await mediaFixture();
    assert.equal(verifiedFiles.length, 105);
    const origin = await startNext(true);
    const session = (headers: Record<string, string> = {}) => fetch(`${origin}/api/accounts/session`, { headers });
    const library = (query = "", headers: Record<string, string> = { cookie: `mint_session=${memberToken}` }) =>
      fetch(`${origin}/api/library/files${query ? `?${query}` : ""}`, { headers });
    const page = async (query = "") => libraryFilePageSchema.parse(await checked(await library(query), 200));
    const forged = {
      authorization: `Bearer ${adminToken}`, "x-mint-user-id": admin.id, "x-mint-role": "admin",
      "x-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.2",
      "x-forwarded-host": "attacker.test", "x-forwarded-proto": "https",
      "x-mint-gateway-token": randomBytes(32).toString("base64url"),
    };
    assert.deepEqual(await checked(await session(forged), 200), { user: null });
    assert.deepEqual(await checked(await session({
      ...forged, cookie: `unrelated=opaque; mint_session=${memberToken}; another=ignored`,
    }), 200), { user: member });
    assert.deepEqual(await checked(await session({ cookie: `mint_session=${expiredToken}` }), 200), { user: null });
    for (const cookie of [
      `mint_session=${memberToken}; mint_session=${adminToken}`,
      `mint_session=${memberToken}; mint_session=${memberToken}`,
      `mint_session=mn1.${memberToken}`, `mint_session="${memberToken}"`,
      `mint_session=%61${memberToken}`, `mint_session =${memberToken}`, "mint_session=",
    ]) {
      await checked(await session({ cookie }), 401);
      await checked(await library("", { cookie }), 401);
    }
    for (const token of [expiredToken, ...inactiveTokens, randomBytes(32).toString("base64url")]) {
      await checked(await library("", { cookie: `mint_session=${token}` }), 401);
    }
    await checked(await library("", forged), 401);
    await checked(await library("", {}), 401);
    assert.equal((await page()).items.length, 50);
    assert.equal((await page("limit=100")).items.length, 100);
    assert.equal(libraryFilePageSchema.parse(await checked(await library("limit=1", {
      ...forged, cookie: `mint_session=${memberToken}`,
    }), 200)).items.length, 1);
    const listed: LibraryFileListItem[] = [];
    let cursor: string | null = null;
    do {
      const result = await page(`limit=17${cursor ? `&cursor=${cursor}` : ""}`);
      assert.ok(result.items.length <= 17);
      listed.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);
    assert.deepEqual(listed, verifiedFiles, "Next must expose exactly the real verified files, excluding unverified media.");
    assert.equal(new Set(listed.map((item) => item.id)).size, 105);
    for (const item of listed) {
      assert.deepEqual(Object.keys(item).sort(), ["album", "artist", "durationMs", "id", "recordingId", "title", "version"]);
      assert.equal(item.durationMs, 500, "Decoded duration must precede Catalog duration.");
    }
    const search = await page("search=ECHO%20caf%C3%A9&limit=1");
    assert.ok(search.nextCursor);
    const rest = await page(`search=echo%20cafe&limit=100&cursor=${search.nextCursor}`);
    const matches = [...search.items, ...rest.items];
    assert.equal(matches.length, 3);
    assert.ok(matches.every((item) => item.title === "Caf\u00e9 Echo"
      && item.artist === "Fixture Artist" && item.album === "Fixture Album"));
    assert.equal(matches.filter((item) => item.recordingId === null).length, 1);
    assert.equal(new Set(matches.filter((item) => item.recordingId !== null).map((item) => item.recordingId)).size, 1);
    assert.deepEqual(matches.map((item) => item.version).sort(), ["Live", "Original", null].sort());
    assert.equal(rest.nextCursor, null);
    assert.deepEqual(await page("search=%25"), { items: [], nextCursor: null });
    for (const query of [
      "limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=1e2", "limit=0x10", "limit=NaN",
      "limit=Infinity", "limit=", "limit=%201", "limit=01", "limit=1&limit=2", "limit=1&limit=1",
      "offset=0", "actor=admin", "search=a&search=b", "cursor=a&cursor=b",
      `search=${"x".repeat(201)}`, "search=%00", "cursor=", "cursor=a%3D", `cursor=${"x".repeat(2049)}`,
    ]) await checked(await library(query), 400, `Invalid query: ${query}`);
    // Semantic cursor rejection is deliberately sanitized by the SDK, not decoded again in Next.
    await checked(await library("cursor=a"), 502);
    await checked(await library(`search=different&cursor=${search.nextCursor}`), 502);
    const { rows: [removed] } = await observer.query<{ id: string }>(
      "SELECT id FROM library.media_files WHERE relative_path = 'original-0.wav'",
    );
    assert.ok(removed);
    const remaining = await mediaFixture(removed.id);
    assert.equal(remaining.length, 104);
    assert.equal(remaining.some((item) => item.id === removed.id), false);
    assert.deepEqual(await page("search=echo%20cafe"), {
      items: matches.filter((item) => item.id !== removed.id), nextCursor: null,
    });
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM library.media_files")).rows[0].count, 106);
    assert.equal((await observer.query(
      "SELECT availability FROM library.media_files WHERE id = $1", [removed.id],
    )).rows[0].availability, "unavailable");

    const decisionUrl = `${origin}/api/admin/access-requests/decision`;
    const input = { userId: pending.id, approve: true };
    const decision = (headers: Record<string, string>, body = JSON.stringify(input)) =>
      fetch(decisionUrl, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    const adminHeaders = { origin, cookie: `mint_session=${adminToken}` };
    await checked(await decision({ origin }), 401);
    await checked(await decision({ ...forged, origin, cookie: `mint_session=${memberToken}` }), 403);
    await checked(await decision({ ...adminHeaders, origin: "https://attacker.test" }), 403);
    await checked(await decision({ ...adminHeaders, origin: "null" }), 403);
    await checked(await decision({ cookie: adminHeaders.cookie }), 403);
    await checked(await decision({ ...adminHeaders, origin: "https://attacker.test", host: "attacker.test",
      "x-forwarded-host": "attacker.test", "x-forwarded-proto": "https" }), 403);
    await checked(await decision(adminHeaders, JSON.stringify({ ...input, actor: admin })), 400);
    await checked(await decision(adminHeaders, JSON.stringify({ userId: pending.id, approve: "true" })), 400);
    await checked(await decision(adminHeaders, "{"), 400);
    await checked(await decision(adminHeaders, " ".repeat(1025)), 413);
    await checked(await decision({ ...adminHeaders, "content-type": "text/plain" }), 415);
    assert.equal((await observer.query("SELECT status FROM accounts.users WHERE id = $1", [pending.id])).rows[0].status, "pending");
    assert.deepEqual(notifications, []);
    assert.deepEqual(await checked(await decision(adminHeaders, JSON.stringify(input).padEnd(1024)), 200), { ok: true });
    const approved = (await observer.query(
      "SELECT status, approved_by, approved_at FROM accounts.users WHERE id = $1", [pending.id],
    )).rows[0];
    assert.equal(approved.status, "active");
    assert.equal(approved.approved_by, admin.id);
    assert.ok(approved.approved_at instanceof Date);
    assert.deepEqual(notifications, [1]);

    const statusUrl = `${origin}/api/admin/members/status`;
    const statusInput = { userId: member.id, status: "disabled" };
    const setStatus = (headers: Record<string, string>, body = JSON.stringify(statusInput)) =>
      fetch(statusUrl, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    await checked(await setStatus({ origin }), 401);
    await checked(await setStatus({ ...forged, origin, cookie: `mint_session=${memberToken}` }), 403);
    for (const token of inactiveTokens) {
      await checked(await setStatus({ origin, cookie: `mint_session=${token}` }), 401);
    }
    for (const badOrigin of ["https://attacker.test", "null", `${origin}/`, ""]) {
      const headers = { ...adminHeaders, origin: badOrigin, "x-forwarded-host": "attacker.test",
        "x-forwarded-proto": "https" };
      if (!badOrigin) Reflect.deleteProperty(headers, "origin");
      await checked(await setStatus(headers), 403);
    }
    for (const input of [
      { ...statusInput, actor: admin }, { userId: member.id, status: "pending" },
      { userId: member.id, status: true }, { userId: "../member", status: "disabled" },
      { userId: member.id }, null,
    ]) await checked(await setStatus(adminHeaders, JSON.stringify(input)), 400);
    await checked(await setStatus(adminHeaders, "{"), 400);
    await checked(await setStatus(adminHeaders, " ".repeat(1025)), 413);
    await checked(await setStatus({ ...adminHeaders, "content-type": "text/plain" }), 415);
    await checked(await setStatus(adminHeaders, JSON.stringify({ userId: admin.id, status: "disabled" })), 502);
    assert.equal((await observer.query("SELECT status FROM accounts.users WHERE id = $1", [admin.id])).rows[0].status, "active");
    assert.deepEqual(await checked(await setStatus(adminHeaders, JSON.stringify(statusInput).padEnd(1024)), 200), { ok: true });
    assert.equal((await observer.query("SELECT status FROM accounts.users WHERE id = $1", [member.id])).rows[0].status, "disabled");
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM accounts.sessions WHERE user_id = $1", [member.id])).rows[0].count, 0);
    assert.deepEqual(await checked(await session({ cookie: `mint_session=${memberToken}` }), 200), { user: null });
    await checked(await library(), 401);
    assert.deepEqual(await checked(await setStatus(adminHeaders, JSON.stringify({ userId: member.id, status: "active" })), 200), { ok: true });
    assert.equal((await observer.query("SELECT status FROM accounts.users WHERE id = $1", [member.id])).rows[0].status, "active");
    await checked(await library(), 401);
    await observer.query(
      "INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
      [hash(memberToken), member.id],
    );
    assert.equal((await page("limit=1")).items.length, 1);
    await observer.query("DELETE FROM accounts.sessions WHERE id = $1", [hash(memberToken)]);
    assert.deepEqual(await checked(await session({ cookie: `mint_session=${memberToken}` }), 200), { user: null });
    await checked(await library(), 401);
    await observer.query("UPDATE accounts.users SET status = 'disabled' WHERE id = $1", [admin.id]);
    assert.deepEqual(await checked(await session({ cookie: adminHeaders.cookie }), 200), { user: null });
    await checked(await decision(adminHeaders), 401);
    await checked(await library("", adminHeaders), 401);
    await checked(await setStatus(adminHeaders), 401);
    await observer.query("UPDATE accounts.users SET status = 'active' WHERE id = $1", [admin.id]);
    assert.deepEqual(await checked(await session({ cookie: adminHeaders.cookie }), 200), { user: admin });
    await runtime.stop();
    await checked(await session({ cookie: adminHeaders.cookie }), 502);
    await checked(await library("", adminHeaders), 502);
    await checked(await setStatus(adminHeaders), 502);
    await stopNext(next!);
    assert.equal(nextLogs.includes(gatewayToken), false, "Next logs must not contain the gateway credential.");
    next = undefined;
    const staticRoot = path.join(app, ".next", "dev", "static");
    const browserFiles = (await readdir(staticRoot, { recursive: true })).filter((file) => file.endsWith(".js"));
    assert.ok(browserFiles.length > 0);
    for (const file of browserFiles) {
      const code = await readFile(path.join(staticRoot, file), "utf8");
      for (const privateValue of [gatewayToken, `${runtime.address}/trpc`, adminToken, memberToken]) {
        assert.equal(code.includes(privateValue), false, "Browser bundles must not contain private API configuration.");
      }
    }

    const unconfigured = await startNext(false);
    const missing = await checked(await fetch(`${unconfigured}/api/accounts/session`), 503);
    assert.deepEqual(missing, { error: "Target API unavailable." });
    await checked(await fetch(`${unconfigured}/api/admin/access-requests/decision`, {
      method: "POST", headers: { origin: unconfigured, "content-type": "application/json" }, body: JSON.stringify(input),
    }), 503);
    await checked(await fetch(`${unconfigured}/api/library/files`), 503);
    await checked(await fetch(`${unconfigured}/api/admin/members/status`, {
      method: "POST", headers: { origin: unconfigured, "content-type": "application/json" },
      body: JSON.stringify(statusInput),
    }), 503);
    assert.deepEqual(errors, []);
    assert.equal(hash(await readFile(buildInfo)), originalBuildInfo);
    succeeded = true;
  } finally {
    if (!succeeded) {
      await writeFile(path.join(work, "next.log"), nextLogs, { mode: 0o600 });
      t.diagnostic(`Private fixture diagnostics: ${work}`);
    }
    // Never remove a cluster or build tree until its actual owned processes have stopped.
    if (next) await stopNext(next);
    await runtime?.stop();
    await observer.end();
    if (postgresStarted) {
      await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env });
    }
    if (succeeded) await rm(work, { recursive: true, force: true });
  }
});
