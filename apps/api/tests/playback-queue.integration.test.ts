import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createMintSdk, MintSdkError } from "@mint/sdk";
import pg from "pg";
import { startApiRuntime } from "../src/runtime";

const exec = promisify(execFile);
const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("queue SDK traverses and edits migrated PostgreSQL snapshots through the API runtime", {
  timeout: 120_000,
}, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) { t.skip("Set MINT_TEST_POSTGRES_BIN to PostgreSQL 16 binaries"); return; }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-api-queue-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "sock");
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, PGHOST: socket, PGPORT: "5432",
    PGDATABASE: "postgres", PGUSER: "fixture",
  };
  const database = {
    host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
    max: 2, connectionTimeoutMillis: 2000, ssl: false as const,
  };
  const observer = new pg.Pool(database);
  const gatewayToken = randomBytes(32).toString("base64url");
  let postgresStarted = false;
  let runtime: Awaited<ReturnType<typeof startApiRuntime>> | undefined;
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ], { env });
    await exec(path.join(bin, "pg_ctl"), [
      "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-w", "start",
    ], { env });
    postgresStarted = true;
    runtime = await startApiRuntime({
      database, gatewayToken, migrations: { packagesRoot, lockTimeoutMs: 5000 },
      listen: { host: "127.0.0.1", port: 0 },
      notifyAccessRequests: async () => {},
      errors: { error: () => {} },
    });

    const user = (await observer.query<{ id: string }>(
      `INSERT INTO accounts.users (email, name, password_hash, status)
       VALUES ('queue@fixture.test', 'Queue fixture', 'fixture', 'active') RETURNING id`,
    )).rows[0]!;
    const other = (await observer.query<{ id: string }>(
      `INSERT INTO accounts.users (email, name, password_hash, status)
       VALUES ('other-queue@fixture.test', 'Other queue', 'fixture', 'active') RETURNING id`,
    )).rows[0]!;
    const token = randomBytes(32).toString("base64url");
    const otherToken = randomBytes(32).toString("base64url");
    await observer.query(
      `INSERT INTO accounts.sessions (id, user_id, expires_at) VALUES
       ($1, $2, now() + interval '1 day'), ($3, $4, now() + interval '1 day')`,
      [hash(token), user.id, hash(otherToken), other.id],
    );
    const root = (await observer.query<{ id: string }>(
      "INSERT INTO library.roots (path) VALUES ('/fixture/read-only') RETURNING id",
    )).rows[0]!;
    const fileIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      const file = (await observer.query<{ id: string }>(`
        INSERT INTO library.media_files (
          root_id, relative_path, availability, checked_at, verified_at,
          audio_stream_index, audio_codec, decoded_sample_frames, duration_ms,
          imported_title, imported_artist, imported_album
        ) VALUES (
          $1, $2, 'verified', now(), now(), 0, 'flac', 1000, 10000, $3, 'Artist', 'Album'
        ) RETURNING id
      `, [root.id, `track-${index}.flac`, `Track ${index}`])).rows[0]!;
      fileIds.push(file.id);
    }

    const sdk = createMintSdk({ url: `${runtime.address}/trpc`, gatewayToken, sessionToken: token });
    const opened = await sdk.playback.queue.open({
      selection: { source: "items", items: fileIds.map((mediaFileId) => ({ mediaFileId })) },
      shuffle: false,
      current: { mediaFileId: fileIds[1]! },
    });
    assert.equal(opened.context.total, 3);
    assert.equal(opened.context.position, 1);
    assert.deepEqual(opened.items.map((item) => item.id), fileIds);
    assert.equal(opened.items[1]?.title, "Track 1");

    const paged = await sdk.playback.queue.page(opened.context.id, { position: 2 });
    assert.equal(paged.context.position, 2);
    assert.equal(paged.context.revision, opened.context.revision);
    await assert.rejects(
      createMintSdk({ url: `${runtime.address}/trpc`, gatewayToken, sessionToken: otherToken })
        .playback.queue.page(opened.context.id, { position: 0 }),
      (error) => error instanceof MintSdkError && error.code === "RPC_ERROR",
    );
    const cleared = await sdk.playback.queue.edit(opened.context.id, {
      revision: opened.context.revision,
      currentEntryId: opened.items[1]!.queueId,
      edit: { action: "clear" },
    });
    assert.equal(cleared.context.total, 2);
    assert.equal(cleared.context.position, 1);
    assert.deepEqual(cleared.items.map((item) => item.id), fileIds.slice(0, 2));
    await assert.rejects(sdk.playback.queue.edit(opened.context.id, {
      revision: opened.context.revision,
      currentEntryId: opened.items[1]!.queueId,
      edit: { action: "clear" },
    }), (error) => error instanceof MintSdkError && error.code === "RPC_ERROR");
  } finally {
    try { await runtime?.stop(); } finally {
      await observer.end();
      if (postgresStarted) {
        await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env });
      }
      await rm(cluster, { recursive: true, force: true });
    }
  }
});
