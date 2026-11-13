import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { PostgresPublicReadCache, publicCacheKey } from "../src/public-cache";

const exec = promisify(execFile);
const validate = (value: unknown) => {
  if (!value || typeof value !== "object" || !("title" in value) || typeof value.title !== "string") {
    throw new TypeError("Invalid public metadata");
  }
  return { title: value.title };
};
const policy = { validate, maxBytes: 1024, kind: "value" as const, freshSeconds: 30, keepSeconds: 120 };

test("admission and JSON validation reject invalid inputs before storage; failures propagate", async () => {
  const failure = new Error("storage failure");
  let queries = 0;
  const cache = new PostgresPublicReadCache({ query: async () => { queries++; throw failure; } });
  const key = publicCacheKey("public:fixture:v1");
  assert.throws(() => publicCacheKey(""), RangeError);
  assert.throws(() => publicCacheKey("x".repeat(4097)), RangeError);
  await assert.rejects(cache.acquire("bad", 10), TypeError);
  await assert.rejects(cache.acquire(key, 121), RangeError);
  await assert.rejects(cache.cleanupExpired(1001), RangeError);
  const accessor = Object.defineProperty({}, "title", { enumerable: true, get: () => "unsafe" });
  const customJson = Object.defineProperty({}, "toJSON", { value: () => "unsafe" });
  for (const invalid of [NaN, Infinity, undefined, { x: undefined }, [1, , 2], "\0", "\ud800", new Date(), accessor, customJson]) {
    await assert.rejects(cache.publish(key, "unused", invalid, {
      validate: (v) => v, maxBytes: 1024, kind: "value", freshSeconds: 1, keepSeconds: 1,
    }), /JSON|PostgreSQL/);
  }
  await assert.rejects(cache.publish(key, "unused", { title: "x".repeat(1024) }, policy), RangeError);
  await assert.rejects(cache.publish(key, "unused", { title: "x" }, { ...policy, keepSeconds: 1 }), RangeError);
  assert.equal(queries, 0);
  await assert.rejects(cache.lookup(key, validate, 1024), (error) => error === failure);
  await assert.rejects(cache.acquire(key, 10), (error) => error === failure);
});

test("public cache on disposable PostgreSQL 16", { timeout: 90_000 }, async (t) => {
  const bin = process.env.MINT_TEST_POSTGRES_BIN;
  if (!bin) {
    t.skip("Set MINT_TEST_POSTGRES_BIN to disposable PostgreSQL 16 binaries");
    return;
  }
  assert.ok(path.isAbsolute(bin));
  const cluster = await mkdtemp(path.join(tmpdir(), "mint-public-cache-pg-"));
  const data = path.join(cluster, "data");
  const socket = path.join(cluster, "socket");
  const env = { ...process.env, PGHOST: socket, PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "fixture" };
  const pools: pg.Pool[] = [];
  const endings: Promise<void>[] = [];
  const pool = (application_name: string) => {
    const connection = new pg.Pool({ host: socket, port: 5432, database: "postgres", user: "fixture", password: "",
      max: 8, connectionTimeoutMillis: 3000, query_timeout: 15000,
      options: "-c statement_timeout=10000", application_name });
    connection.on("connect", (client: pg.PoolClient) => {
      endings.push(new Promise<void>((resolve) => client.once("end", resolve)));
    });
    pools.push(connection);
    return connection;
  };
  try {
    await mkdir(socket);
    await exec(path.join(bin, "initdb"), ["-D", data, "-U", "fixture", "--auth-local=trust", "--auth-host=reject",
      "--no-locale", "-E", "UTF8"], { env, timeout: 60_000 });
    await exec(path.join(bin, "pg_ctl"), ["-D", data, "-l", path.join(cluster, "postgres.log"), "-o",
      `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`,
      "-w", "-t", "15", "start"], { env, timeout: 30_000 });
    const first = pool("public_cache_first"), second = pool("public_cache_second");
    assert.match((await first.query("SHOW server_version")).rows[0].server_version, /^16\./);
    assert.equal((await first.query("SELECT 1 AS ready")).rows[0].ready, 1);
    await first.query("CREATE SCHEMA platform");
    await first.query(await readFile(new URL("../migrations/0002_public_read_cache.sql", import.meta.url), "utf8"));
    const a = new PostgresPublicReadCache(first), b = new PostgresPublicReadCache(second);
    const key = publicCacheKey("public:fixture:v1");

    await t.test("concurrent leases coalesce refresh and fresh, stale, error and expiry remain distinct", async () => {
      assert.deepEqual(await a.lookup(key, validate, 1024), { state: "miss" });
      const attempts = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).acquire(key, 30)));
      const leases = attempts.filter((token): token is string => token !== null);
      assert.equal(leases.length, 1);
      assert.equal(await a.publish(key, leases[0]!, { title: "Public" }, policy), true);
      const fresh = await b.lookup(key, validate, 1024);
      assert.equal(fresh.state, "fresh");
      if (fresh.state !== "fresh") throw new Error("Expected fresh value");
      assert.equal(fresh.value.title, "Public");
      fresh.value.title = "changed";
      const reread = await a.lookup(key, validate, 1024);
      assert.equal(reread.state === "fresh" && reread.value.title, "Public");
      await assert.rejects(a.lookup(key, () => ({ title: "x" }), 2), RangeError);
      await assert.rejects(a.lookup(key, () => { throw new Error("validation failure"); }, 1024), /validation failure/);
      await first.query("UPDATE platform.public_read_cache SET fresh_until = clock_timestamp() - interval '1 second', fetched_at = clock_timestamp() - interval '2 seconds' WHERE cache_key = $1", [key]);
      const lease = await b.acquire(key, 30);
      assert.ok(lease);
      assert.equal(await b.fail(key, lease, 30), true);
      const stale = await a.lookup(key, validate, 1024);
      assert.equal(stale.state, "stale");
      assert.ok(stale.state === "stale" && stale.retryUntil);
      assert.equal(await a.acquire(key, 30), null);
      await first.query("UPDATE platform.public_read_cache SET expires_at = clock_timestamp() - interval '1 second' WHERE cache_key = $1", [key]);
      assert.equal((await a.lookup(key, validate, 1024)).state, "error");
      await first.query("UPDATE platform.public_read_cache SET retry_until = clock_timestamp() - interval '1 second' WHERE cache_key = $1", [key]);
      assert.deepEqual(await a.lookup(key, validate, 1024), { state: "miss" });
    });

    await t.test("negative JSON null expires without becoming stale", async () => {
      const k = publicCacheKey("public:no-match:v1"), token = await a.acquire(k, 30);
      assert.ok(token);
      const negative = { validate: (v: unknown) => { assert.equal(v, null); return null; },
        maxBytes: 1024, kind: "negative" as const, freshSeconds: 30, keepSeconds: 30 };
      assert.equal(await a.publish(k, token, null, negative), true);
      assert.equal((await b.lookup(k, negative.validate, 1024)).state, "negative");
      await first.query("UPDATE platform.public_read_cache SET fetched_at = clock_timestamp() - interval '2 seconds', fresh_until = clock_timestamp() - interval '1 second', expires_at = clock_timestamp() - interval '1 second' WHERE cache_key = $1", [k]);
      assert.equal((await b.lookup(k, negative.validate, 1024)).state, "miss");
    });

    await t.test("local lookups coalesce and invalidation detaches older pending reads", async () => {
      const k = publicCacheKey("public:pending:v1"), token = await a.acquire(k, 30);
      assert.ok(token);
      assert.equal(await a.publish(k, token, { title: "before" }, policy), true);
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const queried = new Promise<void>((resolve) => { started = resolve; });
      let reads = 0;
      const wrapped = new Proxy(first, {
        get(target, property, receiver) {
          if (property !== "query") return Reflect.get(target, property, receiver);
          return async (sql: string, args: unknown[]) => {
            const result = await target.query(sql, args);
            if (sql.includes("SELECT kind, payload")) {
              reads++;
              if (reads === 1) { started(); await gate; }
            }
            return result;
          };
        },
      });
      const cache = new PostgresPublicReadCache(wrapped);
      const old = cache.lookup(k, validate, 1024);
      await queried;
      const joined = cache.lookup(k, validate, 1024);
      assert.equal(reads, 1);
      await cache.invalidate(k);
      assert.equal((await cache.lookup(k, validate, 1024)).state, "miss");
      assert.equal(reads, 2);
      release();
      const [left, right] = await Promise.all([old, joined]);
      assert.equal(left.state, "fresh");
      assert.equal(right.state, "fresh");
      if (left.state !== "fresh" || right.state !== "fresh") throw new Error("Expected fresh values");
      left.value.title = "changed";
      left.fetchedAt.setTime(0);
      assert.equal(right.value.title, "before");
      assert.notEqual(right.fetchedAt.getTime(), 0);
    });

    await t.test("takeover, invalidation and live slot collisions fence old writers", async () => {
      const k = publicCacheKey("public:fence:v1"), old = await a.acquire(k, 30);
      assert.ok(old);
      await a.invalidate(k);
      const replacement = await b.acquire(k, 30);
      assert.ok(replacement);
      assert.equal(await a.publish(k, old, { title: "obsolete" }, policy), false);
      assert.equal(await a.fail(k, old, 30), false);
      assert.equal(await b.publish(k, replacement, { title: "new" }, policy), true);
      const expired = await a.acquire(k, 30);
      assert.ok(expired);
      await first.query("UPDATE platform.public_read_cache SET lease_until = clock_timestamp() - interval '1 second' WHERE cache_key = $1", [k]);
      const takeover = await b.acquire(k, 30);
      assert.ok(takeover);
      assert.equal(await a.publish(k, expired, { title: "expired" }, policy), false);
      assert.equal(await b.publish(k, takeover, { title: "takeover" }, policy), true);
      let collision = "";
      for (let i = 0; i < 1_000_000; i++) {
        const candidate = publicCacheKey(`public:collision:${i}`);
        if (candidate.slice(0, 4) === k.slice(0, 4) && candidate !== k) { collision = candidate; break; }
      }
      assert.ok(collision);
      assert.equal(await a.acquire(collision, 30), null);
      await a.invalidate(k);
      assert.ok(await a.acquire(collision, 30));
    });

    await t.test("publication and failure sample lease expiry after row lock waits", async () => {
      for (const method of ["publish", "fail"] as const) {
        const k = publicCacheKey(`public:lock:${method}`), token = await a.acquire(k, 30);
        assert.ok(token);
        await first.query("UPDATE platform.public_read_cache SET lease_until = clock_timestamp() + interval '500 milliseconds' WHERE cache_key = $1", [k]);
        const locker = await first.connect();
        let pending: Promise<boolean> | undefined;
        try {
          await locker.query("BEGIN");
          await locker.query("SELECT slot FROM platform.public_read_cache WHERE cache_key = $1 FOR UPDATE", [k]);
          pending = method === "publish" ? b.publish(k, token, { title: "late" }, policy) : b.fail(k, token, 30);
          const deadline = performance.now() + 5000;
          while (!(await first.query("SELECT 1 FROM pg_stat_activity WHERE application_name = 'public_cache_second' AND wait_event_type = 'Lock'")).rowCount) {
            assert.ok(performance.now() < deadline);
            await delay(5);
          }
          await delay(600);
          await locker.query("COMMIT");
          assert.equal(await pending, false);
        } finally {
          await locker.query("ROLLBACK");
          locker.release();
          if (pending) await pending;
        }
      }
    });

    await t.test("bounded cleanup preserves active leases, cooldowns and retained values", async () => {
      const live = publicCacheKey("public:live:v1"), token = await a.acquire(live, 30);
      assert.ok(token);
      assert.equal(await a.publish(live, token, { title: "retained" }, policy), true);
      const active = publicCacheKey("public:active:v1");
      assert.ok(await a.acquire(active, 30));
      const cooldown = publicCacheKey("public:cooldown:v1"), failed = await a.acquire(cooldown, 30);
      assert.ok(failed);
      assert.equal(await a.fail(cooldown, failed, 30), true);
      const before = Number((await first.query("SELECT count(*) FROM platform.public_read_cache")).rows[0].count);
      assert.equal(await a.cleanupExpired(1), 1);
      assert.equal(Number((await first.query("SELECT count(*) FROM platform.public_read_cache")).rows[0].count), before - 1);
      await a.cleanupExpired(1000);
      assert.equal((await a.lookup(live, validate, 1024)).state, "fresh");
      assert.equal((await a.lookup(cooldown, validate, 1024)).state, "error");
      assert.equal(await b.acquire(active, 30), null);
    });
  } finally {
    try {
      await Promise.all(pools.map((connection) => connection.end()));
      await Promise.all(endings);
    } finally {
      if (existsSync(path.join(data, "postmaster.pid"))) {
        await exec(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "-t", "15", "stop"], { env, timeout: 30_000 });
      }
      assert.equal(existsSync(path.join(data, "postmaster.pid")), false);
      await rm(cluster, { recursive: true, force: true });
    }
  }
});
