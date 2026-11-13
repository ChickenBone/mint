import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { PostgresEventLog, type EventAudience, type EventJson } from "../src/events";
import { runStartupMigrations } from "../src/startup-migrations";

const exec = promisify(execFile);
const publicAudience: EventAudience = { kind: "public" };
const accountA: EventAudience = { kind: "account", accountId: "fixture-a" };
const accountB: EventAudience = { kind: "account", accountId: "fixture-b" };
const event = { type: "library.changed", payload: { revision: 1 } };

test("event bounds reject invalid input before storage; failures propagate", async () => {
  const failure = new Error("storage unavailable");
  let queries = 0;
  const log = new PostgresEventLog({ query: async () => { queries++; throw failure; } });
  for (const accountId of ["", "\0", "a".repeat(129), "\u00e9".repeat(65)]) {
    await assert.rejects(log.append({ kind: "account", accountId }, event), TypeError);
  }
  for (const type of ["", "UPPER", "a".repeat(129), "'; DROP TABLE events"]) {
    await assert.rejects(log.append(publicAudience, { ...event, type }), TypeError);
  }
  for (const payload of [NaN, Infinity, { invalid: NaN }]) {
    await assert.rejects(log.append(publicAudience, { ...event, payload }), TypeError);
  }
  const circular: { next?: EventJson } = {};
  circular.next = circular;
  await assert.rejects(log.append(publicAudience, { ...event, payload: circular }), TypeError);
  await assert.rejects(log.append(publicAudience, { ...event, payload: "x".repeat(16_383) }), RangeError);
  await assert.rejects(log.append(publicAudience, { ...event, payload: "\u00e9".repeat(8_192) }), RangeError);
  for (const after of [-1n, 9_223_372_036_854_775_808n]) {
    await assert.rejects(log.replay(publicAudience, after, 1), RangeError);
    await assert.rejects(log.prune(publicAudience, after, 1), RangeError);
  }
  for (const limit of [0, -1, 0.1, NaN, Infinity, 101]) {
    await assert.rejects(log.replay(publicAudience, 0n, limit), RangeError);
  }
  for (const limit of [0, -1, 0.1, NaN, Infinity, 1_001]) {
    await assert.rejects(log.prune(publicAudience, 0n, limit), RangeError);
  }
  assert.equal(queries, 0);
  await assert.rejects(log.append(publicAudience, event), (error) => error === failure);
  await assert.rejects(log.replay(publicAudience, 0n, 100), (error) => error === failure);
  await assert.rejects(log.prune(publicAudience, 0n, 1_000), (error) => error === failure);
});

test("malformed storage results fail explicitly", async () => {
  const empty = new PostgresEventLog({
    query: async () => ({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] }),
  });
  await assert.rejects(empty.append(publicAudience, event), /did not return one event/);
  await assert.rejects(empty.prune(publicAudience, 0n, 1), /deletion count/);
  assert.deepEqual(await empty.replay(publicAudience, 0n, 1), {
    events: [], cursor: 0n, highWatermark: 0n, replayFloor: 0n, resetRequired: false,
  });
  assert.equal((await empty.replay(publicAudience, 1n, 1)).resetRequired, true);
});

test("durable audience replay on disposable PostgreSQL", { timeout: 90_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to existing PostgreSQL binaries for durable recovery proof");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-events-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "socket");
  const env = { ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture" };
  const pools: pg.Pool[] = [];
  const endings: Promise<void>[] = [];
  const pool = (application_name: string) => {
    const result = new pg.Pool({
      host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
      max: 8, connectionTimeoutMillis: 2_000, query_timeout: 15_000,
      options: "-c statement_timeout=10000", application_name,
    });
    result.on("connect", (client: pg.PoolClient) => {
      endings.push(new Promise<void>((resolve) => client.once("end", resolve)));
    });
    pools.push(result);
    return result;
  };
  const start = () => exec(path.join(bin, "pg_ctl"), [
    "-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
    `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
    "-w", "-t", "15", "start",
  ], { env, timeout: 30_000 });
  const stop = (mode: "fast" | "immediate" = "fast") => exec(path.join(bin, "pg_ctl"), [
    "-D", data, "-m", mode, "-w", "-t", "15", "stop",
  ], { env, timeout: 30_000 });
  const drain = async () => {
    const active = pools.splice(0);
    await Promise.all(active.map((connection) => connection.end()));
    await Promise.all(endings.splice(0));
  };
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), [
      "-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8",
    ], { env, timeout: 60_000 });
    await start();
    const first = pool("event_fixture_first");
    const second = pool("event_fixture_second");
    assert.equal((await first.query("SELECT 1 AS ready")).rows[0].ready, 1);
    assert.equal((await first.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
    await runStartupMigrations(first, {
      packagesRoot: fileURLToPath(new URL("../../", import.meta.url)), lockTimeoutMs: 5_000,
    });
    const a = new PostgresEventLog(first);
    const b = new PostgresEventLog(second);

    await t.test("real migration, audience isolation and bounded ascending paging", async () => {
      const empty = await a.replay(publicAudience, 0n, 100);
      assert.equal(empty.resetRequired, false);
      assert.equal(empty.highWatermark, 0n);
      for (let revision = 1; revision <= 5; revision++) {
        const appended = await a.append(publicAudience, { ...event, payload: { revision } });
        assert.equal(appended.sequence, BigInt(revision));
        assert.ok(appended.createdAt instanceof Date);
      }
      await a.append(accountA, { type: "private.changed", payload: { private: "a" } });
      await b.append(accountB, { type: "private.changed", payload: { private: "b" } });
      await b.append({ kind: "admin" }, { type: "admin.changed", payload: { private: "admin" } });
      const page = await b.replay(publicAudience, 0n, 2);
      assert.deepEqual(page.events.map((row) => row.sequence), [1n, 2n]);
      assert.equal(page.cursor, 2n);
      assert.equal(page.highWatermark, 5n);
      assert.equal(page.resetRequired, false);
      assert.deepEqual((await b.replay(publicAudience, page.cursor, 100)).events.map((row) => row.sequence), [3n, 4n, 5n]);
      assert.deepEqual((await b.replay(accountA, 0n, 100)).events.map((row) => row.payload), [{ private: "a" }]);
      assert.deepEqual((await a.replay(accountB, 0n, 100)).events.map((row) => row.payload), [{ private: "b" }]);
      assert.deepEqual((await a.replay({ kind: "admin" }, 0n, 100)).events.map((row) => row.payload), [{ private: "admin" }]);
      assert.equal((await a.replay(publicAudience, 6n, 100)).resetRequired, true);
    });

    await t.test("domain mutation and event both roll back, with no consumed sequence", async () => {
      await first.query("CREATE TABLE fixture_domain (id integer PRIMARY KEY)");
      const client = await first.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO fixture_domain VALUES (1)");
        assert.equal((await new PostgresEventLog(client).append(publicAudience, event)).sequence, 6n);
        assert.equal((await b.replay(publicAudience, 5n, 1)).events.length, 0);
        await client.query("ROLLBACK");
        assert.equal((await first.query("SELECT count(*) FROM fixture_domain")).rows[0].count, "0");
        assert.equal((await a.append(publicAudience, event)).sequence, 6n);
        await client.query("BEGIN");
        await client.query("INSERT INTO fixture_domain VALUES (2)");
        await new PostgresEventLog(client).append(publicAudience, event);
        await client.query("COMMIT");
        assert.equal((await first.query("SELECT count(*) FROM fixture_domain")).rows[0].count, "1");
        assert.equal((await b.replay(publicAudience, 6n, 1)).events[0]?.sequence, 7n);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    await t.test("row-locked allocation prevents out-of-order commit cursor loss across pools", async () => {
      const client = await first.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await client.query("BEGIN");
        assert.equal((await new PostgresEventLog(client).append(publicAudience, event)).sequence, 8n);
        pending = b.append(publicAudience, event);
        const deadline = performance.now() + 5_000;
        while (!(await first.query(`
          SELECT 1 FROM pg_stat_activity WHERE application_name = 'event_fixture_second'
            AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO platform.event_streams%'
        `)).rowCount) {
          assert.ok(performance.now() < deadline, "Second writer must wait for sequence owner");
          await delay(5);
        }
        assert.equal((await a.replay(publicAudience, 7n, 100)).events.length, 0);
        // Other audiences do not share the writer lock.
        assert.equal((await a.append(accountA, event)).sequence, 2n);
        await client.query("COMMIT");
        await pending;
        assert.deepEqual((await a.replay(publicAudience, 7n, 100)).events.map((row) => row.sequence), [8n, 9n]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
        if (pending) await pending;
      }
      const values = await Promise.all(Array.from({ length: 30 }, (_, index) =>
        (index % 2 ? a : b).append(publicAudience, event)));
      assert.deepEqual(values.map((value) => value.sequence).sort((x, y) => x < y ? -1 : 1),
        Array.from({ length: 30 }, (_, index) => BigInt(index + 10)));
    });

    await t.test("bounded retention advances floor and requests reset instead of silently losing events", async () => {
      assert.equal(await a.prune(publicAudience, 39n, 2), 2);
      const expired = await b.replay(publicAudience, 0n, 100);
      assert.equal(expired.resetRequired, true);
      assert.equal(expired.replayFloor, 2n);
      assert.deepEqual(expired.events, []);
      assert.equal((await b.replay(publicAudience, 2n, 100)).events[0]?.sequence, 3n);
      const removed = await Promise.all([a.prune(publicAudience, 39n, 10), b.prune(publicAudience, 39n, 10)]);
      assert.equal(removed.reduce((sum, count) => sum + count, 0), 20);
      assert.equal(await a.prune(publicAudience, 39n, 1_000), 17);
      assert.equal(await b.prune(publicAudience, 39n, 1_000), 0);
      assert.equal((await a.replay(publicAudience, 39n, 100)).resetRequired, false);
      assert.equal((await a.replay(publicAudience, 38n, 100)).resetRequired, true);
      assert.equal((await b.replay(accountA, 0n, 100)).events.length, 2);
      assert.equal((await a.append(publicAudience, event)).sequence, 40n);
    });

    await t.test("payload budgets, opaque account keys, exact bigint and real database failures", async () => {
      const opaque: EventAudience = { kind: "account", accountId: "'; DROP TABLE platform.events; --" };
      await a.append(opaque, { ...event, payload: "x".repeat(16_382) });
      assert.equal((await b.replay(opaque, 0n, 1)).events.length, 1);
      await first.query("INSERT INTO platform.event_streams VALUES ('account:bigint', 9007199254740992, 9007199254740992)");
      const large: EventAudience = { kind: "account", accountId: "bigint" };
      assert.equal((await a.append(large, event)).sequence, 9_007_199_254_740_993n);
      assert.equal((await a.replay(large, 9_007_199_254_740_992n, 1)).cursor, 9_007_199_254_740_993n);
      await assert.rejects(first.query(`
        INSERT INTO platform.events(stream,sequence,type,payload)
        VALUES ('public', 999, 'too.big', to_jsonb(repeat('x', 65537)))
      `), { code: "23514" });
      const client = await first.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await assert.rejects(new PostgresEventLog(client).append(publicAudience, event), { code: "25006" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      assert.equal((await a.replay(publicAudience, 39n, 100)).highWatermark, 40n);
    });

    await t.test("database crash recovers committed replay and discards an unfinished domain/event transaction", async () => {
      await drain();
      const abandoned = await pool("event_fixture_abandoned").connect();
      const connectionErrors: Error[] = [];
      abandoned.on("error", (error: Error) => connectionErrors.push(error));
      try {
        await abandoned.query("BEGIN");
        await abandoned.query("INSERT INTO fixture_domain VALUES (3)");
        assert.equal((await new PostgresEventLog(abandoned).append(publicAudience, event)).sequence, 41n);
        await stop("immediate");
      } finally {
        abandoned.release(true);
      }
      await drain();
      for (const error of connectionErrors) {
        assert.match(error.message, /terminating connection due to immediate shutdown|Connection terminated unexpectedly/);
      }
      await start();
      const recovered = pool("event_fixture_recovered");
      assert.equal((await recovered.query("SELECT 1 AS ready")).rows[0].ready, 1);
      assert.equal((await recovered.query("SELECT count(*) FROM fixture_domain WHERE id = 3")).rows[0].count, "0");
      const log = new PostgresEventLog(recovered);
      const page = await log.replay(publicAudience, 39n, 100);
      assert.equal(page.replayFloor, 39n);
      assert.equal(page.highWatermark, 40n);
      assert.deepEqual(page.events.map((row) => row.payload), [event.payload]);
      assert.equal((await log.replay(publicAudience, 0n, 1)).resetRequired, true);
      assert.equal((await log.replay(accountB, 0n, 1)).events.length, 1);
      assert.equal((await log.append(publicAudience, event)).sequence, 41n);
    });
  } finally {
    const failures: unknown[] = [];
    try { await drain(); } catch (error) { failures.push(error); }
    try {
      if (existsSync(path.join(data, "postmaster.pid"))) await stop();
      assert.equal(existsSync(path.join(data, "postmaster.pid")), false);
      await rm(cluster, { recursive: true, force: true });
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Event PostgreSQL fixture cleanup failed");
  }
  assert.equal(existsSync(cluster), false);
});
