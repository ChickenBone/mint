import type { LocalJobQueue } from "@mint/platform";
import type { Pool } from "pg";
import type { CatalogSeedJob, CatalogSeedSource } from "./startup-seeding";
import {
  CATALOG_SEED_INGESTION_LIMITS,
  CatalogSeedIngestionError,
  LISTENBRAINZ_SEED_KEY,
  fetchListenBrainzSnapshot,
} from "./listenbrainz-source";
import { claimCatalogSeed, failCatalogSeed, publishCatalogSeed } from "./seed-ingestion-store";

export { CATALOG_SEED_INGESTION_LIMITS, CatalogSeedIngestionError } from "./listenbrainz-source";

export const CATALOG_LISTENBRAINZ_SEED_QUEUE_V1 = Object.freeze({
  name: "catalog.seed.listenbrainz.v1",
  retryLimit: 5,
  retryDelaySeconds: 60,
  retryBackoff: true,
  retryDelayMaxSeconds: 3600,
  expireInSeconds: 60,
  retentionSeconds: 604800,
  deleteAfterSeconds: 604800,
  concurrency: 1,
} satisfies LocalJobQueue);

export interface CatalogSeedIngestionPayloadV1 {
  readonly version: 1;
  readonly job: CatalogSeedJob;
}

export interface CatalogSeedIngestionResult {
  readonly version: 1;
  readonly key: string;
  readonly status: "ingested" | "already_ingested";
  readonly outcome: "observations" | "empty_feed" | "no_identified_recordings";
  readonly received: number;
  readonly persisted: number;
  readonly missingIdentifiers: number;
}

export interface CatalogSeedIngestor {
  ingest(payload: unknown, signal?: AbortSignal): Promise<CatalogSeedIngestionResult>;
}

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Object.getOwnPropertySymbols(value).length === 0;
}

function validatePayload(payload: unknown): void {
  if (!plain(payload) || payload.version !== 1 || Object.keys(payload).length !== 2
    || !plain(payload.job)) throw new CatalogSeedIngestionError("invalid_payload", false);
  const job = payload.job;
  const expected = {
    key: LISTENBRAINZ_SEED_KEY, source: "listenbrainz", task: "lb-chart",
    host: "api.listenbrainz.org", kind: "song", country: "global", identifier: "",
    priority: 100, reason: "startup",
  };
  if (job.source !== "listenbrainz") {
    throw new CatalogSeedIngestionError("unsupported_source", false);
  }
  if (Object.keys(job).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => job[key] !== value)) {
    throw new CatalogSeedIngestionError("invalid_payload", false);
  }
}

export function createCatalogSeedIngestor(
  pool: Pool,
  options: {
    readonly enabledSources: readonly CatalogSeedSource[];
    readonly request?: typeof fetch;
  },
): CatalogSeedIngestor {
  if (!options || !Array.isArray(options.enabledSources)
    || options.enabledSources.length > 1 || options.enabledSources.some((source) => source !== "listenbrainz")
    || (options.request !== undefined && typeof options.request !== "function")) {
    throw new TypeError("Catalog ingestion supports only an explicitly enabled ListenBrainz source.");
  }
  if (!pool.options.connectionTimeoutMillis || pool.options.connectionTimeoutMillis > 2000
    || pool.options.connectionTimeoutMillis < 1) {
    throw new RangeError("Catalog ingestion requires a pool connection timeout from 1 to 2000ms.");
  }
  const enabled = options.enabledSources.includes("listenbrainz");
  const request = options.request ?? fetch;
  return {
    async ingest(payload, callerSignal) {
      validatePayload(payload);
      if (!enabled) throw new CatalogSeedIngestionError("disabled_source", false);
      const signal = AbortSignal.any([
        ...(callerSignal ? [callerSignal] : []),
        AbortSignal.timeout(CATALOG_SEED_INGESTION_LIMITS.commandTimeoutMs),
      ]);
      if (signal.aborted) throw new CatalogSeedIngestionError("aborted", true);
      const claim = await claimCatalogSeed(pool, signal);
      if ("result" in claim) return claim.result;
      try {
        const snapshot = await fetchListenBrainzSnapshot(request, signal);
        return await publishCatalogSeed(pool, claim.token, snapshot, signal);
      } catch (error) {
        const failure = error instanceof CatalogSeedIngestionError ? error
          : error instanceof AggregateError
            ? error.errors.find((item: unknown): item is CatalogSeedIngestionError => item instanceof CatalogSeedIngestionError)
            : undefined;
        if (failure && failure.code !== "lease_lost") {
          try {
            await failCatalogSeed(pool, claim.token, failure);
          } catch (failureError) {
            throw new AggregateError([error, failureError], "Catalog ingestion and failure persistence failed.");
          }
        }
        throw error;
      }
    },
  };
}
