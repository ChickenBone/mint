import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_STARTUP_SEED_LIMITS,
  planCatalogStartupSeeds,
  scheduleCatalogStartupSeeds,
  type CatalogSeedJob,
  type CatalogSeedSource,
  type CatalogSeedStore,
  type CatalogStartupSeedConfig,
} from "../src/startup-seeding";

const channelA = `UC${"a".repeat(22)}`;
const channelB = `UC${"b".repeat(22)}`;
const allSources: CatalogSeedSource[] = [
  "apple", "listenbrainz", "ytmusic", "youtube", "deezer",
  "audius", "archive", "openverse", "openwhyd",
];
const base: CatalogStartupSeedConfig = {
  enabledSources: ["listenbrainz"], countries: [], youtubeChannels: [], maxJobs: 128,
};

function fixtureStore() {
  const rows = new Map<string, CatalogSeedJob>();
  const store: CatalogSeedStore = {
    async insertIfAbsent(job) {
      if (rows.has(job.key)) return "existing";
      rows.set(job.key, job);
      return "inserted";
    },
  };
  return { rows, store };
}

test("startup plans retain standalone source scope, host, kind and priority", () => {
  const jobs = planCatalogStartupSeeds({
    ...base, enabledSources: allSources, countries: ["US", "gb"],
    youtubeChannels: [channelB, channelA],
  });
  assert.equal(jobs.length, 12);
  assert.equal(new Set(jobs.map((job) => job.key)).size, 12);
  assert.deepEqual(jobs.map((job) => [
    job.source, job.task, job.country, job.kind, job.identifier, job.priority,
  ]), [
    ["apple", "chart", "gb", "song", "", 100],
    ["apple", "chart", "us", "song", "", 100],
    ["listenbrainz", "lb-chart", "global", "song", "", 100],
    ["ytmusic", "ytm-chart", "gb", "artist", "", 100],
    ["ytmusic", "ytm-chart", "us", "artist", "", 100],
    ["youtube", "yt-feed", "global", "artist", channelA, 20],
    ["youtube", "yt-feed", "global", "artist", channelB, 20],
    ["deezer", "deezer-chart", "global", "song", "", 100],
    ["audius", "audius-chart", "global", "song", "", 100],
    ["archive", "archive-chart", "global", "album", "", 100],
    ["openverse", "openverse-chart", "global", "song", "", 100],
    ["openwhyd", "openwhyd-chart", "global", "song", "", 100],
  ]);
  assert.deepEqual(jobs.map((job) => job.host), [
    "rss.marketingtools.apple.com", "rss.marketingtools.apple.com",
    "api.listenbrainz.org", "music.youtube.com", "music.youtube.com",
    "www.youtube.com", "www.youtube.com", "api.deezer.com",
    "discoveryprovider.audius.co", "archive.org", "api.openverse.org", "openwhyd.org",
  ]);
  assert.ok(jobs.every((job) => job.reason === "startup"));
  assert.ok(Object.isFrozen(jobs));
  assert.ok(jobs.every(Object.isFrozen));
});

test("empty configuration never enables providers or invents YouTube channels", async () => {
  const { rows, store } = fixtureStore();
  const config = { ...base, enabledSources: [], youtubeChannels: [channelA] };
  assert.deepEqual(planCatalogStartupSeeds(config), []);
  assert.deepEqual(await scheduleCatalogStartupSeeds(config, store), {
    planned: 0, inserted: 0, existing: 0,
  });
  assert.equal(rows.size, 0);
  assert.deepEqual(planCatalogStartupSeeds({ ...base, enabledSources: ["youtube"] }), []);
});

test("scope normalization and duplicates preserve stable keys across reordered config", () => {
  const config: CatalogStartupSeedConfig = {
    ...base, enabledSources: ["youtube", "apple", "apple", "ytmusic"],
    countries: ["US", "us", "gb"], youtubeChannels: [channelB, channelA, channelA],
  };
  assert.deepEqual(planCatalogStartupSeeds(config), planCatalogStartupSeeds({
    ...config, enabledSources: ["ytmusic", "apple", "youtube"],
    countries: ["gb", "us"], youtubeChannels: [channelA, channelB],
  }));
  assert.equal(planCatalogStartupSeeds(config)[0]?.key, "catalog:startup:chart:gb");
});

test("unsupported sources are errors, never name-search or oEmbed chart substitutes", () => {
  for (const source of ["musicbrainz", "spotify", "soundcloud", "amazon", "omdb", "__proto__"]) {
    assert.throws(() => planCatalogStartupSeeds({
      ...base, enabledSources: [source as CatalogSeedSource],
    }), /Unsupported Catalog startup source/);
  }
});

test("invalid and missing storefronts and channel URLs are rejected explicitly", () => {
  for (const source of ["apple", "ytmusic"] as const) {
    assert.throws(() => planCatalogStartupSeeds({
      ...base, enabledSources: [source],
    }), /at least one country/);
  }
  for (const country of ["global", "", "usa", " us", "u1", "us\n"]) {
    assert.throws(() => planCatalogStartupSeeds({ ...base, countries: [country] }), /two-letter/);
  }
  for (const channel of ["", "@artist", "https://youtube.com/channel/" + channelA, channelA + "\n"]) {
    assert.throws(() => planCatalogStartupSeeds({ ...base, youtubeChannels: [channel] }), /channel IDs/);
  }
});

test("input and output budgets reject overflow rather than silently dropping scopes", () => {
  for (const maxJobs of [0, -1, 1.5, 129, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => planCatalogStartupSeeds({ ...base, maxJobs }), /maxJobs/);
  }
  assert.throws(() => planCatalogStartupSeeds({
    ...base, countries: Array<string>(51).fill("us"),
  }), /50 countries/);
  assert.throws(() => planCatalogStartupSeeds({
    ...base, youtubeChannels: Array<string>(65).fill(channelA),
  }), /64 YouTube/);
  assert.throws(() => planCatalogStartupSeeds({
    ...base, enabledSources: [...allSources, "apple"],
  }), /Too many/);
  assert.throws(() => planCatalogStartupSeeds({
    ...base, enabledSources: ["apple"], countries: ["us", "gb"], maxJobs: 1,
  }), /exceeds maxJobs/);
  const countries = Array.from({ length: 50 }, (_, index) =>
    `a${String.fromCharCode(97 + index % 26)}`.replace(/^a/, index < 26 ? "a" : "b"));
  const channels = Array.from({ length: 64 }, (_, index) =>
    `UC${String(index).padStart(22, "0")}`);
  const config: CatalogStartupSeedConfig = {
    ...base, enabledSources: ["apple", "youtube"],
    countries, youtubeChannels: channels, maxJobs: 114,
  };
  assert.equal(planCatalogStartupSeeds(config).length, 114);
  const exact = {
    ...config, enabledSources: ["apple", "ytmusic", "youtube"] as const,
    countries: countries.slice(0, 32),
  };
  assert.equal(planCatalogStartupSeeds({ ...exact, maxJobs: 128 }).length, 128);
  assert.throws(() => planCatalogStartupSeeds({
    ...exact, countries: countries.slice(0, 33), maxJobs: 128,
  }), /exceeds maxJobs/);
  assert.equal(CATALOG_STARTUP_SEED_LIMITS.maxJobs, 128);
});

test("scheduling validates the entire plan before the first write", async () => {
  const { rows, store } = fixtureStore();
  await assert.rejects(scheduleCatalogStartupSeeds({
    ...base, enabledSources: ["listenbrainz", "apple"], countries: ["us"], maxJobs: 1,
  }, store), /exceeds maxJobs/);
  assert.equal(rows.size, 0);
});

test("repeated and concurrent scheduling use atomic storage keys, not process receipts", async () => {
  const { rows, store } = fixtureStore();
  const config = { ...base, enabledSources: allSources, countries: ["us"], youtubeChannels: [channelA] };
  const results = await Promise.all([
    scheduleCatalogStartupSeeds(config, store), scheduleCatalogStartupSeeds(config, store),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.inserted, 0), 9);
  assert.equal(results.reduce((sum, result) => sum + result.existing, 0), 9);
  const original = [...rows.values()];
  assert.deepEqual(await scheduleCatalogStartupSeeds(config, store), {
    planned: 9, inserted: 0, existing: 9,
  });
  assert.deepEqual([...rows.values()], original);
});

test("storage failure propagates and a partial batch can be retried idempotently", async () => {
  const { rows, store } = fixtureStore();
  const config: CatalogStartupSeedConfig = { ...base, enabledSources: ["listenbrainz", "deezer"] };
  const failure = new Error("storage unavailable");
  let calls = 0;
  await assert.rejects(scheduleCatalogStartupSeeds(config, {
    async insertIfAbsent(job) {
      if (++calls === 2) throw failure;
      return store.insertIfAbsent(job);
    },
  }), (error) => error === failure);
  assert.equal(rows.size, 1);
  assert.deepEqual(await scheduleCatalogStartupSeeds(config, store), {
    planned: 2, inserted: 1, existing: 1,
  });
});

test("invalid storage outcomes cannot be reported as successful scheduling", async () => {
  await assert.rejects(scheduleCatalogStartupSeeds(base, {
    // @ts-expect-error Runtime adapters must not return success-shaped invalid outcomes.
    async insertIfAbsent() { return "executed"; },
  }), /Invalid Catalog seed store outcome/);
});

test("aborted startup performs no writes; mid-batch cancellation stops later writes", async () => {
  const aborted = AbortSignal.abort(new Error("cancelled startup"));
  const { rows, store } = fixtureStore();
  await assert.rejects(scheduleCatalogStartupSeeds(base, store, aborted), /cancelled startup/);
  assert.equal(rows.size, 0);
  const controller = new AbortController();
  await assert.rejects(scheduleCatalogStartupSeeds({
    ...base, enabledSources: ["listenbrainz", "deezer"],
  }, {
    async insertIfAbsent(job, signal) {
      assert.equal(signal, controller.signal);
      const result = await store.insertIfAbsent(job);
      controller.abort(new Error("stopped"));
      return result;
    },
  }, controller.signal), /stopped/);
  assert.equal(rows.size, 1);
});
