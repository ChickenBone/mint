import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPublicUrl, PublicCacheUnavailableError, PublicProviderBusyError, PublicReadCache,
  publicCacheKey, publicRetryAfter, redisPublicCacheStore, type PublicReadOptions } from "./public-cache";
import { publicCacheFixture } from "./public-cache-fixture";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

const validate = (value: unknown) => {
  if (!value || typeof value !== "object" || !("title" in value) || typeof value.title !== "string")
    throw new Error("Invalid metadata");
  return { title: value.title };
};
const options = (load: PublicReadOptions<{ title: string }>["load"], key = "fixture", provider = "fixture"): PublicReadOptions<{ title: string }> => ({
  key, provider, freshSeconds: 10, keepSeconds: 60, maxBytes: 1000, validate, load,
});
test("sequential, concurrent and independent store instances reuse exactly one upstream read", async () => {
  const fixture = publicCacheFixture();
  let calls = 0;
  const read = options(async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return { title: "Public title" }; });
  const second = fixture.instance();
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? second : fixture.cache).read(read)));
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.value.title === "Public title"));
  results[0]!.value.title = "Changed";
  assert.equal((await fixture.instance().read(read)).value.title, "Public title");
  await fixture.cache.read(read);
  assert.equal(calls, 1, "42 lookups require one source request (41 requests avoided)");
});
test("provider, version, every canonical parameter and variants isolate opaque cache identities", () => {
  const url = canonicalPublicUrl("https://example.org/api?b=2&a=one");
  assert.equal(url, canonicalPublicUrl("https://example.org/api?a=one&b=2"));
  const key = publicCacheKey("provider", "v1", [url, "album"]);
  assert.notEqual(key, publicCacheKey("provider", "v1", [url, "artist"]));
  assert.notEqual(key, publicCacheKey("provider", "v2", [url, "album"]));
  assert.notEqual(key, publicCacheKey("other", "v1", [url, "album"]));
  assert.notEqual(key, publicCacheKey("provider", "v1", [url.replace("b=2", "b=3"), "album"]));
  assert.ok(!key.includes("one"));
  assert.throws(() => canonicalPublicUrl("https://user:secret@example.org/api"), /credentials/);
  assert.throws(() => canonicalPublicUrl("https://example.org/api#fragment"), /fragments/);
});
test("validated negatives have a shorter TTL and do not become indefinitely stale no-matches", async () => {
  let now = 10_000, calls = 0;
  const fixture = publicCacheFixture(() => now);
  const read: PublicReadOptions<null> = { ...options(async () => ({ title: "" })), negativeSeconds: 5,
    validate: (value) => { assert.equal(value, null); return null; }, negative: () => true,
    load: async () => { calls++; return null; } };
  await fixture.cache.read(read); await fixture.instance().read(read);
  assert.equal(calls, 1);
  now += 6000;
  await fixture.instance().read(read);
  assert.equal(calls, 2);
  now += 6000;
  await assert.rejects(fixture.cache.read({ ...read, load: async () => { calls++; throw new Error("outage"); } }), /outage/);
  assert.equal(calls, 3);
});
test("429 cooldown is provider-wide, honors Retry-After, and allows another provider", async () => {
  let now = 100_000, calls = 0;
  const fixture = publicCacheFixture(() => now);
  const failure = options(async () => { calls++; throw new PublicProviderBusyError("fixture", 120); });
  await assert.rejects(fixture.cache.read(failure), PublicProviderBusyError);
  await assert.rejects(fixture.instance().read({ ...failure, key: "another-query" }), (error: unknown) =>
    error instanceof PublicProviderBusyError && error.retryAfter === 120);
  assert.equal(calls, 1);
  assert.equal((await fixture.cache.read(options(async () => ({ title: "Independent fallback" }), "fallback", "other"))).value.title, "Independent fallback");
  now += 121_000;
  await fixture.cache.read(options(async () => { calls++; return { title: "Recovered" }; }));
  assert.equal(calls, 2);
  assert.equal(publicRetryAfter("120", now), 120);
  assert.equal(publicRetryAfter(new Date(now + 90000).toUTCString(), now), 90);
  assert.equal(publicRetryAfter("invalid", now), 60);
});
test("failures never persist success-shaped emptiness, and validated stale values retain their original age", async () => {
  let now = 10_000, calls = 0;
  const fixture = publicCacheFixture(() => now);
  await fixture.cache.read(options(async () => { calls++; return { title: "Kept" }; }));
  now += 11_000;
  const stale = await fixture.instance().read(options(async () => { calls++; throw new Error("Unavailable"); }));
  assert.equal(stale.stale, true); assert.equal(stale.ageSeconds, 11); assert.equal(stale.value.title, "Kept");
  now += 20_000;
  assert.equal((await fixture.instance().read(options(async () => { calls++; throw new Error("Must not run"); }))).ageSeconds, 31);
  assert.equal(calls, 2);
  now += 40_000;
  await assert.rejects(fixture.cache.read(options(async () => { calls++; throw new Error("Unavailable"); })), /Unavailable/);
  assert.equal(calls, 3, "retention is not renewed by stale reads");
});
test("invalid shapes, oversize values and malformed store entries are never accepted", async () => {
  const fixture = publicCacheFixture();
  fixture.entries.set("fixture", { value: "{bad", until: Date.now() + 60000 });
  let calls = 0;
  await fixture.cache.read(options(async () => { calls++; return { title: "Valid" }; }));
  assert.equal(calls, 1);
  const bad = publicCacheFixture();
  await assert.rejects(bad.cache.read(options(async () => ({ no: "title" }) as unknown as { title: string })), /Invalid/);
  assert.equal(bad.entries.has("fixture"), false);
  const large = publicCacheFixture();
  await assert.rejects(large.cache.read({ ...options(async () => ({ title: "x".repeat(5000) })), maxBytes: 100 }), /byte budget/);
  assert.equal(large.entries.has("fixture"), false);
});
test("Redis unavailability fails closed and a bounded circuit prevents repeated cache attempts", async () => {
  let commands = 0, sourceCalls = 0, now = 10_000;
  const fixture = publicCacheFixture(() => now);
  const cache = new PublicReadCache({ ...fixture.store, get: async () => { commands++; throw new Error("private connection info"); } }, () => now);
  const read = options(async () => { sourceCalls++; return { title: "Should not run" }; });
  for (let index = 0; index < 10; index++) await assert.rejects(cache.read({ ...read, key: `query-${index}` }), PublicCacheUnavailableError);
  assert.equal(sourceCalls, 0); assert.equal(commands, 1);
  now += 31_000;
  await assert.rejects(cache.read(read), PublicCacheUnavailableError);
  assert.equal(commands, 2);
});
test("cache outages can serve only previously validated retained hot values", async () => {
  let now = 10_000, online = true, calls = 0;
  const fixture = publicCacheFixture(() => now);
  const cache = new PublicReadCache({ ...fixture.store, get: async (key) => {
    if (!online) throw new Error("offline");
    return fixture.store.get(key);
  } }, () => now);
  const read = options(async () => { calls++; return { title: "Kept" }; });
  await cache.read(read);
  online = false; now += 11_000;
  const stale = await cache.read(read);
  assert.equal(stale.stale, true); assert.equal(stale.ageSeconds, 11); assert.equal(calls, 1);
  now += 60_000;
  await assert.rejects(cache.read(read), PublicCacheUnavailableError);
});
test("cancelling one waiter does not abort the shared source or prevent cache publication", async () => {
  const fixture = publicCacheFixture(), abort = new AbortController();
  let calls = 0;
  const read = options(async (signal) => {
    calls++; await new Promise((resolve) => setTimeout(resolve, 30)); signal.throwIfAborted(); return { title: "Shared" };
  });
  const cancelled = fixture.cache.read({ ...read, signal: abort.signal });
  const waiting = fixture.cache.read(read);
  abort.abort(new Error("Cancelled"));
  await assert.rejects(cancelled, /Cancelled/);
  assert.equal((await waiting).value.title, "Shared");
  await fixture.instance().read(read);
  assert.equal(calls, 1);
});
test("an expired or replaced lease cannot publish an old result or release the new owner's lease", async () => {
  const fixture = publicCacheFixture();
  await assert.rejects(fixture.cache.read(options(async () => {
    fixture.entries.set("fixture:lease", { value: "new-owner", until: Date.now() + 60000 });
    return { title: "Obsolete" };
  })), PublicProviderBusyError);
  assert.equal(fixture.entries.has("fixture"), false);
  assert.equal(fixture.entries.get("fixture:lease")?.value, "new-owner");
});
test("sources are aborted at their bounded deadline without caching a failure", async () => {
  const fixture = publicCacheFixture();
  await assert.rejects(fixture.cache.read({ ...options(async (signal) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Failed to abort")), 200);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  })), timeoutMs: 20 }), /timeout|aborted/i);
  assert.equal(fixture.entries.has("fixture"), false);
});
test("real isolated Redis connections coalesce public reads and atomically fence publication/release", {
  skip: !process.env.PUBLIC_CACHE_TEST_REDIS_SOCKET && "Set PUBLIC_CACHE_TEST_REDIS_SOCKET to an owned disposable Redis socket",
}, async (t) => {
  const path = process.env.PUBLIC_CACHE_TEST_REDIS_SOCKET!;
  const clients = [new Redis({ path, maxRetriesPerRequest: 1, commandTimeout: 2000 }),
    new Redis({ path, maxRetriesPerRequest: 1, commandTimeout: 2000 })];
  const provider = `test-${randomUUID()}`, key = publicCacheKey(provider, "v1", "metadata");
  const lease = `${key}:lease`;
  t.after(async () => {
    try { await clients[0]!.del(key, lease, `mint:public:cooldown:${provider}`, `mint:public:throttle:${provider}`); }
    finally { for (const client of clients) client.disconnect(); }
  });
  assert.deepEqual(await Promise.all(clients.map((client) => client.ping())), ["PONG", "PONG"]);
  const stores = clients.map((client) => redisPublicCacheStore(() => client));
  const caches = stores.map((store) => new PublicReadCache(store));
  let calls = 0;
  const read = options(async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 30)); return { title: "Persisted public metadata" }; }, key, provider);
  const values = await Promise.all(Array.from({ length: 30 }, (_, index) => caches[index % 2]!.read(read)));
  assert.equal(calls, 1); assert.ok(values.every((result) => result.value.title === "Persisted public metadata"));
  await new PublicReadCache(stores[0]!).read(read); assert.equal(calls, 1);
  assert.ok(await clients[0]!.ttl(key) > 0);
  await stores[0]!.set(lease, "new-owner", 10);
  assert.equal(await stores[1]!.publish(key, "obsolete", 60, lease, "old-owner"), false);
  await stores[1]!.release(lease, "old-owner");
  assert.equal(await stores[0]!.get(lease), "new-owner");
  assert.equal(await stores[0]!.publish(key, "latest", 60, lease, "new-owner"), true);
  assert.equal(await stores[1]!.get(key), "latest");
  await stores[0]!.release(lease, "new-owner"); assert.equal(await stores[1]!.get(lease), null);
});
