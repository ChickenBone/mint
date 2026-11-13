import assert from "node:assert/strict";
import { test } from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import pg from "pg";
import {
  CATALOG_LISTENBRAINZ_SEED_QUEUE_V1,
  CATALOG_SEED_INGESTION_LIMITS,
  createCatalogSeedIngestor,
  type CatalogSeedIngestionPayloadV1,
} from "../src/index";
import { planCatalogStartupSeeds } from "../src/startup-seeding";
import { listenbrainzSeedIngestions, listenbrainzSeedObservations } from "../src/seed-ingestion-schema";
import { recordings } from "../src/schema";

const job = planCatalogStartupSeeds({
  enabledSources: ["listenbrainz"], countries: [], youtubeChannels: [], maxJobs: 1,
})[0]!;
const payload = { version: 1, job } satisfies CatalogSeedIngestionPayloadV1;
const poolOptions = { host: "/nonexistent-mint-ingestion-fixture", connectionTimeoutMillis: 100 };

test("strict domain version and fixed source tuple reject before storage or upstream access", async () => {
  const pool = new pg.Pool(poolOptions);
  let fetched = false;
  const ingest = createCatalogSeedIngestor(pool, {
    enabledSources: ["listenbrainz"],
    request: async () => { fetched = true; throw new Error("unexpected upstream"); },
  });
  try {
    for (const invalid of [
      null, [], {}, job, { ...payload, version: 2 }, { ...payload, extra: true },
      { ...payload, job: null }, { ...payload, job: { ...job, extra: 1 } },
      ...Object.keys(job).filter((key) => key !== "source").map((key) => ({
        ...payload, job: { ...job, [key]: "forged" },
      })),
    ]) await assert.rejects(ingest.ingest(invalid), { code: "invalid_payload" });
    await assert.rejects(ingest.ingest({ ...payload, job: { ...job, source: "apple" } }),
      { code: "unsupported_source" });
    assert.equal(fetched, false);
  } finally { await pool.end(); }
});

test("disabled, unsupported configuration and caller abort cannot acknowledge work", async () => {
  const pool = new pg.Pool(poolOptions);
  try {
    const disabled = createCatalogSeedIngestor(pool, { enabledSources: [] });
    await assert.rejects(disabled.ingest(payload), { code: "disabled_source" });
    assert.throws(() => createCatalogSeedIngestor(pool, { enabledSources: ["apple"] }), TypeError);
    assert.throws(() => createCatalogSeedIngestor(pool, { enabledSources: ["listenbrainz", "listenbrainz"] }), TypeError);
    const enabled = createCatalogSeedIngestor(pool, { enabledSources: ["listenbrainz"] });
    await assert.rejects(enabled.ingest(payload, AbortSignal.abort()), { code: "aborted" });
    await assert.rejects(enabled.ingest(payload), (error: unknown) =>
      error instanceof Error && !error.message.includes("already_ingested"));
  } finally { await pool.end(); }
});

test("pool waits must be explicitly bounded; the shared queue has publication margin", async () => {
  const pool = new pg.Pool();
  try {
    assert.throws(() => createCatalogSeedIngestor(pool, { enabledSources: ["listenbrainz"] }), RangeError);
    assert.equal(Object.isFrozen(CATALOG_LISTENBRAINZ_SEED_QUEUE_V1), true);
    assert.deepEqual(CATALOG_LISTENBRAINZ_SEED_QUEUE_V1, {
      name: "catalog.seed.listenbrainz.v1", retryLimit: 5, retryDelaySeconds: 60,
      retryBackoff: true, retryDelayMaxSeconds: 3600, expireInSeconds: 60,
      retentionSeconds: 604800, deleteAfterSeconds: 604800, concurrency: 1,
    });
    assert.ok(CATALOG_SEED_INGESTION_LIMITS.commandTimeoutMs < CATALOG_SEED_INGESTION_LIMITS.leaseSeconds * 1000);
    assert.ok(CATALOG_SEED_INGESTION_LIMITS.leaseSeconds < CATALOG_LISTENBRAINZ_SEED_QUEUE_V1.expireInSeconds);
  } finally { await pool.end(); }
});

test("new source-only schema does not change canonical recordings or invent identity FKs", () => {
  assert.equal(getTableConfig(recordings).columns.length, 6);
  const observations = getTableConfig(listenbrainzSeedObservations);
  const ingestions = getTableConfig(listenbrainzSeedIngestions);
  assert.equal(ingestions.name, "listenbrainz_seed_ingestions");
  assert.equal(ingestions.columns.length, 24);
  assert.equal(observations.columns.length, 8);
  assert.equal(observations.foreignKeys.length, 1);
  assert.equal(observations.foreignKeys[0]?.reference().foreignTable, listenbrainzSeedIngestions);
  assert.equal(observations.foreignKeys[0]?.onDelete, "restrict");
  assert.equal(ingestions.foreignKeys.length, 0);
  assert.ok(observations.columns.some((column) => column.name === "artist_mbids" && column.getSQLType() === "uuid[]"));
});
