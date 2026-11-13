import {
  CATALOG_LISTENBRAINZ_SEED_QUEUE_V1,
  createCatalogSeedIngestor, createCatalogSeedStore, scheduleCatalogStartupSeeds,
} from "@mint/domain-catalog";
import { startLocalJobRuntime, type LocalJobQueue, type LocalJobRuntime, type LocalJobRuntimeOptions } from "@mint/platform";
import pg from "pg";
import { isEnabledLocalWorker, validateLocalWorkerConfiguration, type LocalWorkerConfiguration } from "./local-job-config";
import { dispatchLibraryScans, LIBRARY_SCAN_QUEUE, requestLibraryScan, runLibraryScanBatch } from "./local-library-scan";

export type LocalWorkerError = Parameters<LocalJobRuntimeOptions["onError"]>[0]
  | { name: "LocalWorkerPoolError" | "LocalWorkerCleanupError" | "LocalWorkerScanDispatchError" }
  | { name: "LocalWorkerStartupError"; phase: "ingestor" | "job-runtime" | "seed-scheduling" | "scan-scheduling" };

export interface LocalWorkerRuntime {
  readonly status: "running" | "disabled";
  requestScan(rootId: string, mode: "resume" | "restart"): Promise<"accepted" | "busy">;
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
  if (!isEnabledLocalWorker(config)) return {
    status: "disabled", async stop() {},
    async requestScan() { throw new Error("Library scans are disabled."); },
  };
  const pool = new pg.Pool({ ...config.database, application_name: "mint-local-worker" });
  pool.on("error", () => bindings.onError({ name: "LocalWorkerPoolError" }));
  let jobs: LocalJobRuntime | undefined;
  let stopping: Promise<void> | undefined;
  let phase: "ingestor" | "job-runtime" | "seed-scheduling" | "scan-scheduling" = "ingestor";
  const shutdown = new AbortController();
  const signal = bindings.signal ? AbortSignal.any([bindings.signal, shutdown.signal]) : shutdown.signal;
  let dispatchTimer: ReturnType<typeof setInterval> | undefined;
  let dispatching: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= (async () => {
      shutdown.abort();
      clearInterval(dispatchTimer);
      let failed = false;
      try { await dispatching; } catch { failed = true; }
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
    const queues: LocalJobQueue[] = [];
    if (config.enabledSources.includes("listenbrainz")) {
      const ingestor = createCatalogSeedIngestor(pool, {
        enabledSources: ["listenbrainz"], ...(bindings.request ? { request: bindings.request } : {}),
      });
      queues.push({
        ...CATALOG_LISTENBRAINZ_SEED_QUEUE_V1,
        async handle(job) {
          await ingestor.ingest(job.payload, bindings.signal
            ? AbortSignal.any([job.signal, bindings.signal]) : job.signal);
        },
      });
    }
    const scan = config.libraryScan;
    if (scan) {
      queues.push({
        ...LIBRARY_SCAN_QUEUE,
        async handle(job) {
          if (Object.keys(job.payload).length !== 1 || typeof job.payload.rootId !== "string") {
            throw new Error("Invalid Library scan job payload.");
          }
          await runLibraryScanBatch(pool, job.payload.rootId, scan, AbortSignal.any([job.signal, signal]));
        },
      });
    }
    phase = "job-runtime";
    jobs = await startLocalJobRuntime(pool, {
      migrations: config.migrations,
      pollingIntervalSeconds: config.pollingIntervalSeconds,
      superviseIntervalSeconds: config.superviseIntervalSeconds,
      maintenanceIntervalSeconds: config.maintenanceIntervalSeconds,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      onError: bindings.onError,
      queues,
    });
    bindings.signal?.throwIfAborted();
    phase = "seed-scheduling";
    if (config.enabledSources.includes("listenbrainz")) {
      await scheduleCatalogStartupSeeds({
        enabledSources: ["listenbrainz"], countries: [], youtubeChannels: [], maxJobs: 1,
      }, createCatalogSeedStore(pool, jobs, CATALOG_LISTENBRAINZ_SEED_QUEUE_V1.name), signal);
    }
    if (scan) {
      phase = "scan-scheduling";
      for (const rootId of scan.rootIds) {
        signal.throwIfAborted();
        await requestLibraryScan(pool, rootId, "start");
      }
      const dispatch = () => dispatchLibraryScans(pool, jobs!, scan.rootIds);
      await dispatch();
      dispatchTimer = setInterval(() => {
        if (dispatching || signal.aborted) return;
        dispatching = dispatch().catch(() => bindings.onError({ name: "LocalWorkerScanDispatchError" }))
          .finally(() => { dispatching = undefined; });
      }, config.pollingIntervalSeconds * 1000);
    }
    bindings.signal?.throwIfAborted();
    return {
      status: "running", stop,
      async requestScan(rootId, mode) {
        if (stopping || signal.aborted) throw new Error("Local worker is stopping.");
        if (!scan?.rootIds.includes(rootId)) throw new Error("Library scan root is not enabled in this worker.");
        return requestLibraryScan(pool, rootId, mode);
      },
    };
  } catch (error) {
    let cleanupFailed = false;
    try { await stop(); } catch { cleanupFailed = true; }
    if (!cleanupFailed && error instanceof DOMException && error.name === "AbortError") throw error;
    bindings.onError({ name: "LocalWorkerStartupError", phase });
    throw new Error(`Local worker startup failed during ${phase}${cleanupFailed ? "; cleanup failed" : ""}.`);
  }
}
