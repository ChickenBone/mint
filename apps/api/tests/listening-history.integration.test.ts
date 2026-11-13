import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordings } from "@mint/domain-catalog";
import { createLibraryRepository, mediaFiles, roots } from "@mint/domain-library";
import { createMintSdk, MintSdkError } from "@mint/sdk";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { startApiRuntime } from "../src/runtime";

const exec = promisify(execFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));
const eventId = "00000000-0000-4000-8000-000000000001";
const secondEventId = "00000000-0000-4000-8000-000000000002";
const thirdEventId = "00000000-0000-4000-8000-000000000003";
const previous = () => new Date(Date.now() - 60_000).toISOString();
const current = () => new Date().toISOString();
const rpcError = (error: unknown) => error instanceof MintSdkError && error.code === "RPC_ERROR";

test("history SDK -> API -> PostgreSQL preserves account privacy, boundaries, and idempotency", {
  timeout: 90_000,
}, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL binaries");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-history-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "sock");
  const database = {
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
    max: 3, connectionTimeoutMillis: 2000, ssl: false as const,
  };
  const observer = new pg.Pool(database);
  const gatewayToken = randomBytes(32).toString("base64url");
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
    runtime = await startApiRuntime({
      database, migrations: { packagesRoot, lockTimeoutMs: 5000 },
      listen: { host: "127.0.0.1", port: 0 }, gatewayToken,
      notifyAccessRequests: async () => {},
      errors: { error: () => {} },
    });
    const url = `${runtime.address}/trpc`;
    const issue = (role: "user" | "admin", status: "active" | "pending" | "disabled", email: string) => ({
      role, status, email,
    });
    const accounts: [string, ReturnType<typeof issue>][] = [
      ["member", issue("user", "active", "member@fixture.test")],
      ["other", issue("user", "active", "other@fixture.test")],
      ["admin", issue("admin", "active", "admin@fixture.test")],
      ["pending", issue("user", "pending", "pending@fixture.test")],
      ["disabled", issue("user", "disabled", "disabled@fixture.test")],
      ["expired", issue("user", "active", "expired@fixture.test")],
      ["revoked", issue("user", "active", "revoked@fixture.test")],
    ];
    const tokens: Record<string, string> = {};
    const userIds: Record<string, string> = {};
    for (const [label, account] of accounts) {
      const token = randomBytes(32).toString("base64url");
      tokens[label] = token;
      const inserted = await observer.query<{ id: string }>(
        `INSERT INTO accounts.users (email, name, password_hash, role, status)
         VALUES ($1, $2, 'fixture', $3, $4) RETURNING id`,
        [account.email, label, account.role, account.status],
      );
      const userId = inserted.rows[0]!.id;
      userIds[label] = userId;
      if (label !== "revoked") {
        await observer.query(
          "INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES ($1, $2, $3)",
          [hash(token), userId, new Date(Date.now() + (label === "expired" ? -60_000 : 86_400_000))],
        );
      }
    }
    const sdk = (label: string) => createMintSdk({
      url, gatewayToken, sessionToken: tokens[label],
    });
    const library = createLibraryRepository(drizzle(observer, { schema: { roots, mediaFiles, recordings } }));
    const root = await library.createRoot({ path: "/fixture-private-root" });
    const db = drizzle(observer);
    const [recording] = await db.insert(recordings).values({ title: "Confirmed song", durationMs: 100_000 }).returning();
    assert.ok(recording);
    const mediaFile = await library.createMediaFile({
      rootId: root.id, relativePath: "fixture.flac", recordingId: recording.id,
      importedTags: { title: "Imported title", artist: "Imported artist", album: "Imported album" },
    });
    await library.recordVerification(mediaFile.id, {
      availability: "verified", checkedAt: new Date(),
      audio: { streamIndex: 0, codec: "flac", decodedSampleFrames: 100, durationMs: 100_000 },
    });
    const unverified = await library.createMediaFile({ rootId: root.id, relativePath: "unverified.flac" });

    const member = sdk("member");
    const other = sdk("other");
    assert.deepEqual(await member.playback.history.record({
      eventId, mediaFileId: mediaFile.id, listenedMs: 900,
    }), { recorded: false });
    assert.deepEqual(await member.playback.history.record({
      eventId, mediaFileId: mediaFile.id, listenedMs: 86_400_000,
      completed: true, startedAt: previous(),
    }), { recorded: true });
    assert.deepEqual(await member.playback.history.record({
      eventId, mediaFileId: mediaFile.id, listenedMs: 86_400_000,
      completed: true, startedAt: previous(),
    }), { recorded: false });
    assert.deepEqual(await other.playback.history.record({
      eventId, mediaFileId: mediaFile.id, listenedMs: 80_000,
      completed: true, startedAt: previous(),
    }), { recorded: true });
    assert.equal(await member.playback.history.privateSession(), false);
    assert.equal(await sdk("admin").playback.history.privateSession(), false);
    for (const label of ["pending", "disabled", "expired", "revoked"]) {
      await assert.rejects(sdk(label).playback.history.list(), rpcError);
    }
    assert.equal((await sdk("admin").playback.history.list()).entries.length, 0);

    const memberPage = await member.playback.history.list();
    assert.equal(memberPage.entries.length, 1);
    assert.deepEqual(memberPage.entries[0], {
      event: {
        id: memberPage.entries[0]!.event.id,
        createdAt: memberPage.entries[0]!.event.createdAt,
        listenedMs: 100_000,
        completed: true,
      },
      track: {
        id: mediaFile.id, recordingId: recording.id, title: "Imported title",
        artist: "Imported artist", album: "Imported album", version: null, durationMs: 100_000,
      },
    });
    assert.equal(memberPage.entries[0]!.track.id, mediaFile.id);
    assert.equal(JSON.stringify(memberPage).includes("fixture-private-root"), false);
    const memberEntryId = memberPage.entries[0]!.event.id;
    const otherEntryId = (await other.playback.history.list()).entries[0]!.event.id;
    await member.playback.history.delete({ entryId: otherEntryId });
    assert.equal((await other.playback.history.list()).entries.length, 1);

    await member.playback.history.setPrivateSession({ privateSession: true });
    assert.equal(await member.playback.history.privateSession(), true);
    assert.deepEqual(await member.playback.history.record({
      eventId: secondEventId, mediaFileId: mediaFile.id, listenedMs: 50_000, startedAt: current(),
    }), { recorded: false });
    await member.playback.history.setPrivateSession({ privateSession: false });
    assert.equal(await member.playback.history.privateSession(), false);
    assert.deepEqual(await member.playback.history.record({
      eventId: secondEventId, mediaFileId: mediaFile.id, listenedMs: 50_000, startedAt: current(),
    }), { recorded: true });
    await member.playback.history.delete({ entryId: memberEntryId });
    assert.equal((await member.playback.history.list()).entries.length, 1);
    assert.deepEqual(await member.playback.history.record({
      eventId: thirdEventId, mediaFileId: mediaFile.id, listenedMs: 50_000, startedAt: previous(),
    }), { recorded: false });
    await member.playback.history.delete();
    assert.equal((await member.playback.history.list()).entries.length, 0);
    assert.deepEqual(await member.playback.history.record({
      eventId: "00000000-0000-4000-8000-000000000004",
      mediaFileId: mediaFile.id, listenedMs: 50_000, startedAt: previous(),
    }), { recorded: false });
    await assert.rejects(member.playback.history.record({
      eventId: "00000000-0000-4000-8000-000000000005",
      mediaFileId: mediaFile.id, listenedMs: 50_000,
      startedAt: new Date(Date.now() + 60_000).toISOString(),
    }), rpcError);
    await assert.rejects(member.playback.history.record({
      eventId: "00000000-0000-4000-8000-000000000006",
      mediaFileId: unverified.id, listenedMs: 50_000, startedAt: current(),
    }), rpcError);
    await observer.query(
      `INSERT INTO playback.listening_history (user_id, event_id, media_file_id, listened_ms)
       SELECT $1, gen_random_uuid(), $2, 1000 FROM generate_series(1, 102)`,
      [userIds.member, mediaFile.id],
    );
    assert.equal((await member.playback.history.list({ page: 0 })).entries.length, 101);
    assert.equal((await member.playback.history.list({ page: 1 })).entries.length, 2);
    await member.playback.history.delete();
    assert.equal((await member.playback.history.list()).entries.length, 0);
  } finally {
    if (runtime) await runtime.stop();
    await observer.end();
    if (started) {
      await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
    }
    await rm(cluster, { recursive: true, force: true });
  }
});
