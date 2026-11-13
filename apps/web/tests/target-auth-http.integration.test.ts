import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startApiRuntime } from "@mint/api";
import pg from "pg";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

test("existing Next forms onboard through trusted ingress, SDK and persisted API sessions without legacy storage", {
  timeout: 240_000,
}, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) { t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL 16 binaries"); return; }
  assert.ok(path.isAbsolute(bin));
  const work = await mkdtemp(path.join(tmpdir(), "mint-auth-next-"));
  const data = path.join(work, "pg");
  const socket = path.join(work, "sock");
  const app = path.join(work, "web");
  const mediaRoot = path.join(work, "media");
  const mediaBytes = Buffer.from("bounded target media fixture");
  const gatewayToken = randomBytes(32).toString("base64url");
  const ingressToken = randomBytes(32).toString("base64url");
  const password = "fixture-password";
  const observer = new pg.Pool({
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
    max: 2, connectionTimeoutMillis: 2000, ssl: false,
  });
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test" as const, PGHOST: socket, PGPORT: "5432",
    PGDATABASE: "postgres", PGUSER: "fixture",
  };
  const errors: string[] = [];
  let postgresStarted = false;
  let runtime: Awaited<ReturnType<typeof startApiRuntime>> | undefined;
  let next: ChildProcess | undefined;
  let logs = "";
  let succeeded = false;
  try {
    await mkdir(socket);
    await mkdir(app);
    await mkdir(mediaRoot);
    await writeFile(path.join(mediaRoot, "fixture.mp3"), mediaBytes);
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
        export default { ...config, output: undefined, outputFileTracingRoot: ${JSON.stringify(app)}, typescript: { ignoreBuildErrors: true } };
      `),
    ]);
    // Keep the real forms/actions; isolate only unrelated legacy layout/player queries.
    await Promise.all([
      writeFile(path.join(app, "src/app/layout.tsx"),
        "export default function Layout({children}) { return <html><body>{children}</body></html>; }"),
      writeFile(path.join(app, "src/app/(public)/layout.tsx"),
        "export default function Layout({children}) { return children; }"),
      writeFile(path.join(app, "src/app/app/layout.tsx"),
        "export default function Layout({children}) { return children; }"),
      writeFile(path.join(app, "src/app/app/page.tsx"), `
        import { requireUser } from "@/lib/auth";
        import { logout } from "@/app/actions/auth";
        export default async function Page() {
          const user = await requireUser();
          return <><p>{user.email}</p><form action={logout}><button>Sign out</button></form></>;
        }
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
    runtime = await startApiRuntime({
      database: { host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
        max: 2, connectionTimeoutMillis: 2000, ssl: false },
      gatewayToken, publicAuthProxy: "gateway",
      migrations: { packagesRoot, lockTimeoutMs: 5000 },
      listen: { host: "127.0.0.1", port: 0 },
      adminBootstrap: { email: "admin@fixture.test", name: "Admin", password },
      notifyAccessRequests: async () => {},
      errors: { error: ({ name }) => { errors.push(name); } },
    });
    const root = (await observer.query(
      "INSERT INTO library.roots (path) VALUES ($1) RETURNING id", [mediaRoot],
    )).rows[0];
    assert.ok(root);
    const mediaFile = (await observer.query(
      `INSERT INTO library.media_files
        (root_id, relative_path, availability, checked_at, verified_at, audio_stream_index, audio_codec, decoded_sample_frames)
       VALUES ($1, 'fixture.mp3', 'verified', now(), now(), 0, 'mp3', 1)
       RETURNING id`,
      [root.id],
    )).rows[0];
    assert.ok(mediaFile);
    const nextBin = require.resolve("next/dist/bin/next");
    try {
      await exec(process.execPath, [nextBin, "build", "--webpack"], {
        cwd: app,
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production",
          NEXT_TELEMETRY_DISABLED: "1",
          MINT_TARGET_API_URL: `${runtime.address}/trpc`, MINT_TARGET_GATEWAY_TOKEN: gatewayToken,
          MINT_TARGET_TRUSTED_PROXY: "authenticated-ingress", MINT_TARGET_INGRESS_TOKEN: ingressToken,
          MINT_TARGET_WEB_ORIGIN: "http://127.0.0.1:3000",
        },
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr : "";
      throw new Error(stderr || "Next production build failed.", { cause: error });
    }
    const script = `
      import { createRequire } from "node:module";
      import { createServer } from "node:http";
      const require = createRequire(${JSON.stringify(path.join(webRoot, "package.json"))});
      const next = require(${JSON.stringify(require.resolve("next"))});
      const reservation = createServer();
      await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
      const address = reservation.address();
      if (!address || typeof address === "string") throw new Error("Next test server did not bind.");
      const port = address.port;
      await new Promise(resolve => reservation.close(resolve));
      const origin = "http://127.0.0.1:" + port;
      process.env.MINT_TARGET_WEB_ORIGIN = origin;
      const app = next({dev:false, dir:${JSON.stringify(app)}, hostname:"127.0.0.1", port});
      await app.prepare();
      const server = createServer(app.getRequestHandler());
      server.listen(port, "127.0.0.1", () => {
        process.send({origin});
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
        PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
        MINT_TARGET_API_URL: `${runtime.address}/trpc`, MINT_TARGET_GATEWAY_TOKEN: gatewayToken,
        MINT_TARGET_TRUSTED_PROXY: "authenticated-ingress", MINT_TARGET_INGRESS_TOKEN: ingressToken,
        // No legacy database or Redis configuration is provided to Next.
      },
    });
    next.stdout!.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
    next.stderr!.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
    const child = next;
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Next startup timed out.")), 60_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Next exited during startup.")); });
      child.once("message", (message: unknown) => {
        clearTimeout(timer);
        assert.ok(message && typeof message === "object" && "origin" in message && typeof message.origin === "string");
        resolve(message.origin);
      });
    });
    async function form(url: string, values: Record<string, string>, extra: Record<string, string> = {}) {
      const page = await fetch(`${origin}${url}`, { headers: extra, signal: AbortSignal.timeout(90_000), redirect: "manual" });
      assert.equal(page.status, 200);
      const html = await page.text();
      const data = new FormData();
      for (const tag of html.matchAll(/<input\b[^>]*>/g)) {
        const name = /\bname="([^"]*)"/.exec(tag[0])?.[1];
        const value = /\bvalue="([^"]*)"/.exec(tag[0])?.[1] ?? "";
        if (name?.startsWith("$ACTION_")) data.append(decode(name), decode(value));
      }
      assert.ok([...data.keys()].some((key) => key.startsWith("$ACTION_")), "Use the actual rendered server action.");
      for (const [key, value] of Object.entries(values)) data.set(key, value);
      return fetch(`${origin}${url}`, {
        method: "POST", body: data, redirect: "manual",
        headers: { origin, ...extra }, signal: AbortSignal.timeout(90_000),
      });
    }
    const ingress = { "x-mint-ingress-token": ingressToken, "x-mint-client-ip": "192.0.2.50" };
    const credentials = { email: "admin@fixture.test", password };
    const invalidCookie = await fetch(`${origin}/login`, {
      headers: { cookie: "mint_session=first; mint_session=second" }, redirect: "manual",
    });
    assert.equal(invalidCookie.status, 200, "Malformed sessions must not prevent a new login.");
    assert.match(await invalidCookie.text(), /Welcome back/);
    const missingTrust = await form("/login", credentials, { "x-forwarded-for": "192.0.2.1" });
    assert.match(await missingTrust.text(), /Sign-in and access requests are unavailable/);
    assert.equal(Number((await observer.query("SELECT count(*) FROM accounts.sessions")).rows[0].count), 0);
    assert.equal(Number((await observer.query("SELECT count(*) FROM platform.rate_limits")).rows[0].count), 0);
    const invalid = await form("/login", { ...credentials, password: "wrong" }, ingress);
    assert.match(await invalid.text(), /don.t match an account/);
    assert.equal(invalid.headers.has("set-cookie"), false);
    const signedIn = await form("/login", { ...credentials, next: "https://attacker.test/" }, {
      ...ingress, "user-agent": "Fixture Browser", "x-mint-user-id": randomBytes(16).toString("hex"),
    });
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get("location"), "/app");
    const cookie = signedIn.headers.get("set-cookie");
    assert.ok(cookie);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=lax/i);
    assert.match(cookie, /Path=\//i);
    assert.match(cookie, /Expires=/i);
    const sessionToken = /mint_session=([A-Za-z0-9_-]+)/.exec(cookie)?.[1];
    assert.ok(sessionToken);
    const evidence = (await observer.query("SELECT * FROM accounts.sessions WHERE id = $1", [hash(sessionToken)])).rows[0];
    assert.equal(evidence.ip, "192.0.2.50");
    assert.equal(evidence.user_agent, "Fixture Browser");
    const sessionCookie = `mint_session=${sessionToken}`;
    const home = await fetch(`${origin}/app`, { headers: { cookie: sessionCookie } });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /admin@fixture.test/);
    const audioUrl = `${origin}/api/player/audio/${mediaFile.id}`;
    const anonymousMedia = await fetch(audioUrl);
    assert.equal(anonymousMedia.status, 401, (await anonymousMedia.text()).slice(0, 1000));
    assert.equal((await fetch(`${audioUrl}?format=mp3`)).status, 401);
    assert.equal((await fetch(`${origin}/api/player/audio/invalid`)).status, 401);
    const invalidSession = await fetch(audioUrl, { headers: { cookie: "mint_session=invalid" } });
    assert.equal(invalidSession.status, 401);
    assert.equal((await fetch(`${origin}/api/player/audio/invalid`, {
      headers: { cookie: sessionCookie },
    })).status, 400);
    const fullMedia = await fetch(audioUrl, { headers: { cookie: sessionCookie } });
    assert.equal(fullMedia.status, 200);
    assert.equal(fullMedia.headers.get("content-type"), "audio/mpeg");
    // Next strips Content-Length from streamed Route Handler responses.
    assert.equal(fullMedia.headers.get("content-length"), null);
    assert.equal(fullMedia.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await fullMedia.arrayBuffer()), mediaBytes);
    const partialMedia = await fetch(audioUrl, {
      headers: { cookie: sessionCookie, range: "bytes=3-9" },
    });
    assert.equal(partialMedia.status, 206);
    assert.equal(partialMedia.headers.get("content-range"), `bytes 3-9/${mediaBytes.length}`);
    assert.deepEqual(Buffer.from(await partialMedia.arrayBuffer()), mediaBytes.subarray(3, 10));
    const headMedia = await fetch(audioUrl, { method: "HEAD", headers: { cookie: sessionCookie } });
    assert.equal(headMedia.status, 200);
    assert.equal(headMedia.headers.get("content-length"), null);
    assert.equal(await headMedia.text(), "");
    const compatibilityFormat = await fetch(`${audioUrl}?format=mp3`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(compatibilityFormat.status, 415);
    assert.equal((await fetch(`${audioUrl}?format=unsupported`, {
      headers: { cookie: sessionCookie },
    })).status, 400);
    const invalidRange = await fetch(audioUrl, {
      headers: { cookie: sessionCookie, range: "bytes=0-1,4-5" },
    });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get("content-range"), `bytes */${mediaBytes.length}`);
    const missingMedia = await fetch(`${origin}/api/player/audio/00000000-0000-4000-8000-000000000000`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(missingMedia.status, 404);
    const logout = await form("/app", {}, { cookie: sessionCookie });
    assert.equal(logout.status, 303);
    assert.match(logout.headers.get("set-cookie") ?? "", /mint_session=;/);
    assert.equal((await observer.query("SELECT * FROM accounts.sessions WHERE id = $1", [hash(sessionToken)])).rows.length, 0);

    const applicant = { name: "Applicant", email: "new@fixture.test", password, confirm: password, website: "" };
    const request = await form("/request-access", applicant, ingress);
    assert.equal(request.headers.has("set-cookie"), false);
    assert.match(await request.text(), /Request sent/);
    const repeated = await form("/request-access", { ...applicant, email: applicant.email.toUpperCase() }, ingress);
    assert.match(await repeated.text(), /Request sent/);
    assert.equal(Number((await observer.query("SELECT count(*) FROM accounts.users WHERE lower(email) = $1", [applicant.email])).rows[0].count), 1);
    const pending = await form("/login", { email: applicant.email, password }, ingress);
    assert.match(await pending.text(), /waiting for approval/);
    const honeypot = await form("/request-access", { ...applicant, email: "bot@fixture.test", website: "spam" }, ingress);
    await honeypot.text();
    assert.equal((await observer.query("SELECT * FROM accounts.users WHERE email = 'bot@fixture.test'")).rows.length, 0);
    const csrf = await form("/request-access", { ...applicant, email: "csrf@fixture.test" }, { ...ingress, origin: "http://attacker.test" });
    await csrf.text();
    assert.equal((await observer.query("SELECT * FROM accounts.users WHERE email = 'csrf@fixture.test'")).rows.length, 0);
    assert.equal((await observer.query("SELECT to_regclass('public.users') AS name")).rows[0].name, null);
    assert.deepEqual(errors, []);
    succeeded = true;
  } finally {
    if (next && next.exitCode === null && next.signalCode === null) {
      const exited = once(next, "exit");
      next.kill("SIGTERM");
      const timer = setTimeout(() => next?.kill("SIGKILL"), 15_000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    if (!succeeded) {
      logs += "\nNext production server output is captured above.";
    }
    try { await runtime?.stop(); } finally {
      await observer.end();
      if (postgresStarted) {
        await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env });
      }
      await rm(work, { recursive: true, force: true });
    }
    if (!succeeded) t.diagnostic(logs.replaceAll(gatewayToken, "[redacted]").replaceAll(ingressToken, "[redacted]"));
  }
});
