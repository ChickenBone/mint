import {
  CATALOG_LISTENBRAINZ_SEED_QUEUE_V1,
  createCatalogSeedIngestor, createCatalogSeedStore, scheduleCatalogStartupSeeds,
} from "@mint/domain-catalog";
import { startLocalJobRuntime, type LocalJobRuntime, type LocalJobRuntimeOptions } from "@mint/platform";
import pg from "pg";
import { isEnabledLocalWorker, validateLocalWorkerConfiguration, type LocalWorkerConfiguration } from "./local-job-config";

export type LocalWorkerError = Parameters<LocalJobRuntimeOptions["onError"]>[0]
  | { name: "LocalWorkerPoolError" | "LocalWorkerCleanupError" }
  | { name: "LocalWorkerStartupError"; phase: "ingestor" | "job-runtime" | "seed-scheduling" };

export interface LocalWorkerRuntime {
  readonly status: "running" | "disabled";
  stop(): Promise<void>;
}

export async function startLocalWorker(
  config: LocalWorkerConfiguration,
  bindings: { onError(error: LocalWorkerError): void; request?: typeof fetch; signal?: AbortSignal },
): Promise<LocalWorkerRuntime> {
  validateLocalWorkerConfiguration(config);
  if (typeof bindings?.onError !== "function" || (bindings.request !== undefined && typeof bindings.request !== "function")) {
    throw new Error("Invalid local worker bindings.");
  }
  bindings.signal?.throwIfAborted();
  if (!isEnabledLocalWorker(config)) return { status: "disabled", async stop() {} };
  const pool = new pg.Pool({ ...config.database, application_name: "mint-local-worker" });
  pool.on("error", () => bindings.onError({ name: "LocalWorkerPoolError" }));
  let jobs: LocalJobRuntime | undefined;
  let stopping: Promise<void> | undefined;
  let phase: "ingestor" | "job-runtime" | "seed-scheduling" = "ingestor";
  function stop(): Promise<void> {
    stopping ??= (async () => {
      let failed = false;
      try { await jobs?.stop(); } catch { failed = true; }
      try { await pool.end(); } catch { failed = true; }
      if (failed) {
        bindings.onError({ name: "LocalWorkerCleanupError" });
        throw new Error("Local worker cleanup failed.");
      }
    })();
    return stopping;
  }
  try {
    const ingestor = createCatalogSeedIngestor(pool, {
      enabledSources: config.enabledSources, ...(bindings.request ? { request: bindings.request } : {}),
    });
    phase = "job-runtime";
    jobs = await startLocalJobRuntime(pool, {
      migrations: config.migrations,
      pollingIntervalSeconds: config.pollingIntervalSeconds,
      superviseIntervalSeconds: config.superviseIntervalSeconds,
      maintenanceIntervalSeconds: config.maintenanceIntervalSeconds,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      onError: bindings.onError,
      queues: [{
        ...CATALOG_LISTENBRAINZ_SEED_QUEUE_V1,
        async handle(job) {
          await ingestor.ingest(job.payload, bindings.signal
            ? AbortSignal.any([job.signal, bindings.signal]) : job.signal);
        },
      }],
    });
    bindings.signal?.throwIfAborted();
    phase = "seed-scheduling";
    await scheduleCatalogStartupSeeds({
      enabledSources: config.enabledSources, countries: [], youtubeChannels: [], maxJobs: 1,
    }, createCatalogSeedStore(pool, jobs, CATALOG_LISTENBRAINZ_SEED_QUEUE_V1.name), bindings.signal);
    bindings.signal?.throwIfAborted();
    return { status: "running", stop };
  } catch (error) {
    let cleanupFailed = false;
    try { await stop(); } catch { cleanupFailed = true; }
    if (!cleanupFailed && error instanceof DOMException && error.name === "AbortError") throw error;
    bindings.onError({ name: "LocalWorkerStartupError", phase });
    throw new Error(`Local worker startup failed during ${phase}${cleanupFailed ? "; cleanup failed" : ""}.`);
  }
}
