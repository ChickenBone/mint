import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startApiRuntime } from "@mint/api";
import { listeningHistoryPageSchema } from "@mint/contracts";
import pg from "pg";
import { analysisSchema, type TrackAnalysis } from "@mint/core/analysis";
import { normalizationGain, smartTransition } from "../src/lib/smart-fades";
import { defaultDsp, type PlayerItem, type PlayerState } from "../src/lib/player-protocol";
import { ListeningHistory } from "../src/lib/listening-history";
import { randomId } from "../src/lib/id";

const analysis: TrackAnalysis = analysisSchema.parse({
  version: 1, algorithm: "mint-dsp-v1", fingerprint: { sha256: "a".repeat(64), bytes: 1000, mtimeMs: 1 },
  measuredAt: new Date().toISOString(), durationSec: 120, integratedLufs: -20, truePeakDbtp: -5,
  leadingSilenceSec: 1.5, trailingSilenceSec: 2, energy: { rms: .1, peak: .5, dynamicRangeDb: 10 },
  waveform: Array(120).fill(.2), tempo: { bpm: 120, confidence: .7 }, key: { name: "C major", confidence: .5 },
  similarity: { method: "audio-descriptors-v1", vector: Array(25).fill(.2), confidence: .7 },
  provenance: { engine: "ffmpeg+mint-dsp", sampleRate: 8000, notes: [] },
});
const from: PlayerItem = { id: "00000000-0000-4000-8000-000000000001", queueId: "1", title: "Original fixture", type: "track", album: "Album", albumId: "al_a" };
const to: PlayerItem = { ...from, id: "00000000-0000-4000-8000-000000000002", queueId: "2", albumId: "al_b" };
test("Smart Fades use measured silence/energy, with safe album and missing-analysis fallbacks", () => {
  const input = { from, to, outgoing: analysis, incoming: analysis, settings: { ...defaultDsp, fadeMode: "smart" as const, crossfade: 8 }, shuffled: false, outgoingDuration: 120 };
  const plan = smartTransition(input);
  assert.equal(plan.endAt, 118); assert.equal(plan.skipIntro, 1.5); assert.equal(plan.seconds, 8);
  const dense = smartTransition({ ...input, outgoing: { ...analysis, waveform: Array(120).fill(.9) } });
  assert.equal(dense.seconds, 3.2);
  assert.equal(smartTransition({ ...input, to: { ...to, albumId: from.albumId } }).seconds, 0);
  assert.equal(smartTransition({ ...input, incoming: null }).seconds, 3);
  assert.equal(smartTransition({ ...input, settings: { ...input.settings, fadeMode: "off" } }).seconds, 0);
});
test("normalization honors loudness target, true-peak ceiling and bounded gain", () => {
  assert.equal(normalizationGain(analysis, -16), 3.5);
  assert.equal(normalizationGain({ ...analysis, truePeakDbtp: -.2 }, -16), -1.3);
  assert.equal(normalizationGain({ ...analysis, integratedLufs: null }, -16), 0);
  assert.equal(normalizationGain(null, -16), 0);
  assert.equal(normalizationGain({ ...analysis, integratedLufs: -100, truePeakDbtp: -100 }, -16), 12);
});
test("history measures audible elapsed time, rejects seek jumps, and flushes once per episode", () => {
  const events: { listenedMs: number; trackId: string; eventId: string }[] = [];
  let now = 0;
  const recorder = new ListeningHistory((event) => events.push(event), () => now);
  const state: PlayerState = { playing: true, track: from, time: 0, duration: 120_000, volume: 100, shuffle: false, repeat: 0, queue: [from, to], queueTotal: 2, queueOffset: 0 };
  recorder.update(state);
  now += 2000; recorder.update({ ...state, time: 2000 });
  now += 2000; recorder.update({ ...state, time: 80_000 });
  now += 2000; recorder.update({ ...state, playing: false, time: 82_000 });
  now += 10_000; recorder.update({ ...state, playing: false, time: 82_000 });
  now += 100; recorder.update({ ...state, track: to });
  recorder.flush(); recorder.flush();
  assert.equal(events.length, 1); assert.equal(events[0]!.listenedMs, 4000); assert.equal(events[0]!.trackId, from.id);
});
test("ids stay valid UUIDs when the page is served over plain HTTP", () => {
  const id = randomId({ getRandomValues: (bytes: ArrayBufferView) => crypto.getRandomValues(bytes) });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("real Next history gateway uses target SDK, active sessions and disposable PostgreSQL without legacy storage", {
  timeout: 240_000,
}, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL binaries");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const exec = promisify(execFile);
  const require = createRequire(import.meta.url);
  const webRoot = fileURLToPath(new URL("../", import.meta.url));
  const work = await mkdtemp(path.join(tmpdir(), "mint-history-next-"));
  const app = path.join(work, "web");
  const data = path.join(work, "pg");
  const socket = path.join(work, "sock");
  const gatewayToken = randomBytes(32).toString("base64url");
  const memberToken = randomBytes(32).toString("base64url");
  const otherToken = randomBytes(32).toString("base64url");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const database = {
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
    max: 2, connectionTimeoutMillis: 2000, ssl: false as const,
  };
  const observer = new pg.Pool(database);
  let postgresStarted = false;
  let runtime: Awaited<ReturnType<typeof startApiRuntime>> | undefined;
  let next: ChildProcess | undefined;
  let nextLogs = "";
  let succeeded = false;
  const errors: string[] = [];

  async function stopNext() {
    if (!next || next.exitCode !== null || next.signalCode !== null) return;
    const exited = once(next, "exit");
    const child = next;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try { await exited; } finally { clearTimeout(timer); }
  }

  async function startNext(mode: "target" | "partial" | "legacy") {
    const script = `
      import { createRequire } from "node:module";
      import { createServer } from "node:http";
      const require = createRequire(${JSON.stringify(path.join(webRoot, "package.json"))});
      const app = require(${JSON.stringify(require.resolve("next"))})({
        dev: true, webpack: true, dir: ${JSON.stringify(app)},
      });
      await app.prepare();
      const server = createServer(app.getRequestHandler());
      server.listen(0, "127.0.0.1", () => {
        const origin = "http://127.0.0.1:" + server.address().port;
        if (${mode === "target"}) process.env.MINT_TARGET_WEB_ORIGIN = origin;
        process.send({ origin });
      });
      process.once("SIGTERM", async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await app.close();
        process.exit(0);
      });
    `;
    const bootstrap = path.join(work, `next-${mode}.mjs`);
    await writeFile(bootstrap, script);
    next = spawn(process.execPath, [bootstrap], {
      cwd: app, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
        ...(mode !== "legacy" ? { MINT_TARGET_API_URL: `${runtime!.address}/trpc` } : {}),
        ...(mode === "target" ? { MINT_TARGET_GATEWAY_TOKEN: gatewayToken } : {}),
      },
    });
    next.stdout!.on("data", (chunk: Buffer) => { nextLogs += chunk.toString(); });
    next.stderr!.on("data", (chunk: Buffer) => { nextLogs += chunk.toString(); });
    const child = next;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Owned Next startup timed out.")), 60_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Owned Next exited during startup: ${nextLogs.slice(-6000)}`)); });
      child.once("message", (message: unknown) => {
        clearTimeout(timer);
        assert.ok(message && typeof message === "object" && "origin" in message && typeof message.origin === "string");
        resolve(message.origin);
      });
    });
  }

  async function checked(response: Response, status = 200) {
    assert.equal(response.status, status, nextLogs.slice(-6000));
    assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
    assert.equal(response.headers.has("set-cookie"), false);
    const text = await response.text();
    for (const secret of [gatewayToken, memberToken, otherToken, socket, runtime?.address].filter(Boolean)) {
      assert.equal(text.includes(secret!), false);
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
    ]);
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(work, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-w", "start",
    ]);
    postgresStarted = true;
    assert.equal((await observer.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    runtime = await startApiRuntime({
      database, gatewayToken,
      migrations: { packagesRoot: fileURLToPath(new URL("../../../packages/", import.meta.url)), lockTimeoutMs: 5000 },
      listen: { host: "127.0.0.1", port: 0 },
      notifyAccessRequests: async () => {},
      errors: { error: ({ name }) => { errors.push(name); } },
    });
    const { rows: [member, other] } = await observer.query<{ id: string }>(
      `INSERT INTO accounts.users (email, name, password_hash, role, status) VALUES
       ('member@history.test', 'Member', 'fixture', 'user', 'active'),
       ('other@history.test', 'Other', 'fixture', 'user', 'active') RETURNING id`,
    );
    assert.ok(member && other);
    await observer.query(
      `INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES
       ($1, $2, now() + interval '1 day'), ($3, $4, now() + interval '1 day')`,
      [hash(memberToken), member.id, hash(otherToken), other.id],
    );
    const { rows: [root] } = await observer.query<{ id: string }>(
      "INSERT INTO library.roots (path) VALUES ('/private-history-fixture') RETURNING id",
    );
    const { rows: [file, unverified] } = await observer.query<{ id: string }>(
      `INSERT INTO library.media_files
       (root_id, relative_path, availability, checked_at, verified_at, audio_stream_index,
        audio_codec, decoded_sample_frames, duration_ms, imported_title, imported_artist, imported_album) VALUES
       ($1, 'fixture.flac', 'verified', now(), now(), 0, 'flac', 100, 100000, 'Fixture song', 'Fixture artist', 'Fixture album'),
       ($1, 'unverified.flac', 'unverified', null, null, null, null, null, null, null, null, null) RETURNING id`,
      [root!.id],
    );
    assert.ok(file && unverified);
    const origin = await startNext("target");
    const request = (resource: string, method = "GET", body?: unknown, token = memberToken,
      extraHeaders: Record<string, string> = {}) => fetch(`${origin}/api/music/${resource}`, {
      method, headers: {
        cookie: `mint_session=${token}`, origin, "content-type": "application/json", ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const previous = () => new Date(Date.now() - 60_000).toISOString();
    const event = {
      eventId: randomUUID(), trackId: file.id, listenedMs: 120_000, completed: true, startedAt: previous(),
    };
    const page = async (query = "", token = memberToken) =>
      listeningHistoryPageSchema.parse(await checked(await request(`history${query}`, "GET", undefined, token)));

    await t.test("records exact target media IDs, clamps, deduplicates and isolates accounts", async () => {
      assert.deepEqual(await checked(await request("history", "POST", event)), { recorded: true });
      assert.deepEqual(await checked(await request("history", "POST", event)), { recorded: false });
      assert.deepEqual(await checked(await request("history", "POST", event, otherToken)), { recorded: true });
      const first = await page();
      assert.equal(first.entries.length, 1);
      assert.deepEqual(first.entries[0]!.track, {
        id: file.id, recordingId: null, title: "Fixture song", artist: "Fixture artist",
        album: "Fixture album", version: null, durationMs: 100_000,
      });
      assert.equal(first.entries[0]!.event.listenedMs, 100_000);
      assert.equal(first.entries[0]!.event.completed, true);
      assert.notEqual(first.entries[0]!.event.id, event.eventId);
      assert.notEqual(first.entries[0]!.event.id, (await page("", otherToken)).entries[0]!.event.id);
      await checked(await request("history", "POST", { ...event, eventId: randomUUID(), trackId: unverified.id }), 502);
      await checked(await request("history", "POST", { ...event, eventId: randomUUID(), trackId: randomUUID() }), 502);
      const stored = await observer.query(
        "SELECT media_file_id FROM playback.listening_history WHERE user_id = $1", [member.id],
      );
      assert.deepEqual(stored.rows, [{ media_file_id: file.id }]);
      assert.equal(JSON.stringify(first).includes("private-history-fixture"), false);
    });

    await t.test("validates bounded requests, exact paths, queries and canonical mutation origins", async () => {
      for (const query of [
        "?page=-1", "?page=10001", "?page=1.5", "?page=1e2", "?page=01", "?page=",
        "?page=0&page=0", "?page=0&actor=admin", "?cursor=anything",
      ]) await checked(await request(`history${query}`), 400);
      for (const input of [
        { ...event, userId: other.id }, { ...event, mediaFileId: file.id },
        { ...event, trackId: undefined }, { ...event, listenedMs: -1 }, { ...event, listenedMs: 1.5 },
        { ...event, listenedMs: 86_400_001 }, { ...event, startedAt: "yesterday" },
      ]) await checked(await request("history", "POST", input), 400);
      await checked(await request("history", "POST", "{"), 400);
      await checked(await request("history", "POST", " ".repeat(1025)), 413);
      await checked(await request("history", "POST", event, memberToken, { "content-type": "text/plain" }), 415);
      await checked(await request("preferences", "PATCH", { privateSession: true, exclusions: [] }), 400);
      await checked(await request("history/not-a-uuid", "DELETE"), 400);
      await checked(await request("history/extra"), 404);
      await checked(await request("history/extra/more", "DELETE"), 404);
      await checked(await request("preferences/extra"), 404);
      await checked(await request("history", "PATCH", {}), 405);
      await checked(await request("preferences", "DELETE"), 405);
      for (const badOrigin of ["", "null", "https://attacker.test"]) {
        for (const [resource, method, body] of [
          ["history", "POST", event], ["history", "DELETE", undefined],
          ["preferences", "PATCH", { privateSession: true }],
        ] as const) {
          await checked(await request(resource, method, body, memberToken, {
            origin: badOrigin, "x-forwarded-host": "attacker.test", "x-forwarded-proto": "https",
          }), 403);
        }
      }
    });

    await t.test("rejects forged, inactive, expired, revoked and ambiguous browser sessions", async () => {
      for (const token of ["", randomBytes(32).toString("base64url"), `mn1.${memberToken}`]) {
        await checked(await request("history", "GET", undefined, token), 401);
      }
      await checked(await request("history", "GET", undefined, memberToken, {
        cookie: `mint_session=${memberToken}; mint_session=${otherToken}`,
      }), 401);
      const forged = {
        cookie: "", "x-mint-user-id": member.id, "x-mint-role": "admin",
        "x-mint-gateway-token": gatewayToken, authorization: `Bearer ${memberToken}`,
      };
      await checked(await request("history", "GET", undefined, memberToken, forged), 401);
      for (const status of ["pending", "denied", "disabled"]) {
        await observer.query("UPDATE accounts.users SET status = $1 WHERE id = $2", [status, member.id]);
        await checked(await request("history"), 401);
        await checked(await request("history", "POST", event), 401);
        await checked(await request("history", "DELETE"), 401);
        await checked(await request("preferences"), 401);
        await checked(await request("preferences", "PATCH", { privateSession: true }), 401);
      }
      await observer.query("UPDATE accounts.users SET status = 'active' WHERE id = $1", [member.id]);
      await observer.query("UPDATE accounts.sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [hash(memberToken)]);
      await checked(await request("history"), 401);
      await observer.query("DELETE FROM accounts.sessions WHERE id = $1", [hash(memberToken)]);
      await checked(await request("history"), 401);
      await observer.query(
        "INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [hash(memberToken), member.id],
      );
    });

    await t.test("private-session and deletion boundaries reject delayed player episodes", async () => {
      assert.deepEqual(await checked(await request("preferences")), { privateSession: false });
      assert.deepEqual(await checked(await request("preferences", "PATCH", { privateSession: true })), { privateSession: true });
      assert.deepEqual(await checked(await request("history", "POST", { ...event, eventId: randomUUID() })), { recorded: false });
      assert.equal((await page()).entries.length, 1);
      assert.deepEqual(await checked(await request("preferences", "PATCH", { privateSession: false })), { privateSession: false });
      assert.deepEqual(await checked(await request("history", "POST", { ...event, eventId: randomUUID() })), { recorded: false });
      assert.deepEqual(await checked(await request("history", "POST", {
        ...event, eventId: randomUUID(), startedAt: undefined,
      })), { recorded: false });
      assert.deepEqual(await checked(await request("history", "POST", {
        ...event, eventId: randomUUID(), startedAt: new Date().toISOString(),
      })), { recorded: true });
      const own = (await page()).entries;
      const otherEntry = (await page("", otherToken)).entries[0]!;
      await checked(await request(`history/${otherEntry.event.id}`, "DELETE"));
      assert.equal((await page("", otherToken)).entries.length, 1);
      await checked(await request(`history/${own[0]!.event.id}`, "DELETE"));
      assert.equal((await page()).entries.length, 1);
      assert.deepEqual(await checked(await request("history", "POST", { ...event, eventId: randomUUID() })), { recorded: false });
      await checked(await request("history", "DELETE"));
      assert.equal((await page()).entries.length, 0);
      assert.deepEqual(await checked(await request("history", "POST", { ...event, eventId: randomUUID() })), { recorded: false });
    });

    await t.test("paginates 101-row lookahead without fabricating a legacy track projection", async () => {
      await observer.query(
        `INSERT INTO playback.listening_history (user_id, event_id, media_file_id, listened_ms)
         SELECT $1, gen_random_uuid(), $2, 1000 FROM generate_series(1, 102)`,
        [member.id, file.id],
      );
      const first = await page("?page=0"), second = await page("?page=1");
      assert.equal(first.entries.length, 101);
      assert.equal(second.entries.length, 2);
      assert.equal(new Set([...first.entries.slice(0, 100), ...second.entries].map((e) => e.event.id)).size, 102);
      assert.deepEqual(await page("?page=10000"), { entries: [] });
      assert.equal((await observer.query("SELECT to_regclass('public.users') AS name")).rows[0].name, null);
      assert.equal((await observer.query("SELECT to_regclass('public.music_history') AS name")).rows[0].name, null);
    });

    await t.test("upstream failure and partial configuration do not fall back to legacy storage", async () => {
      await runtime!.stop();
      await checked(await request("history"), 502);
      await checked(await request("preferences"), 502);
      await stopNext();
      const partialOrigin = await startNext("partial");
      for (const resource of ["history", "preferences"]) {
        await checked(await fetch(`${partialOrigin}/api/music/${resource}`), 503);
      }
    });

    await t.test("unconfigured mode retains the legacy unauthenticated response", async () => {
      await stopNext();
      const legacyOrigin = await startNext("legacy");
      for (const resource of ["history", "preferences"]) {
        assert.deepEqual(await checked(await fetch(`${legacyOrigin}/api/music/${resource}`), 401),
          { error: "Approved membership required." });
      }
    });
    assert.ok(errors.every((name) => name === "NOT_FOUND"));
    succeeded = true;
  } finally {
    try {
      await stopNext();
      await runtime?.stop();
      await observer.end();
      if (postgresStarted) await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
    } finally {
      if (!succeeded) console.error("History gateway fixture failed:", nextLogs.slice(-6000));
      await rm(work, { recursive: true, force: true });
    }
  }
});
