import type { Pool, PoolClient } from "pg";
import { PgBoss, type Db, type QueueOptions } from "pg-boss";
import { runStartupMigrations, type StartupMigrationOptions } from "./startup-migrations";

export type JobJson = null | boolean | number | string | JobJson[] | { [key: string]: JobJson };
export type JobPayload = { [key: string]: JobJson };

export interface LocalJob {
  readonly id: string;
  readonly payload: JobPayload;
  /** Attempt number is not a domain fencing token. */
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export interface LocalJobQueue {
  readonly name: string;
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly retryBackoff: boolean;
  /** Required with backoff; must be omitted for fixed-delay retries. */
  readonly retryDelayMaxSeconds?: number;
  readonly expireInSeconds: number;
  readonly retentionSeconds: number;
  readonly deleteAfterSeconds: number;
  readonly concurrency: number;
  /** Omit in producer-only processes. Handlers must validate their domain payload. */
  readonly handle?: (job: LocalJob) => Promise<void>;
}

export interface LocalJobRuntimeOptions {
  readonly migrations: StartupMigrationOptions;
  readonly queues: readonly LocalJobQueue[];
  readonly pollingIntervalSeconds: number;
  /** Shared cadence for supervision and expired-claim monitoring. */
  readonly superviseIntervalSeconds: number;
  readonly maintenanceIntervalSeconds: number;
  readonly shutdownTimeoutMs: number;
  /** Deliberately excludes payloads, database errors and handler exception text. */
  readonly onError: (error: {
    name: "LocalJobRuntimeError" | "LocalJobRuntimeWarning" | "LocalJobHandlerError";
    queue?: string;
    jobId?: string;
  }) => void;
}

export type JobEnqueueResult = { status: "enqueued"; id: string } | { status: "duplicate" };

export interface LocalJobRuntime {
  /**
   * Deduplicates the key only while a job is queued, retrying or active.
   * For atomic domain writes, pass the SAME client used by the caller's open
   * transaction. The caller owns BEGIN/COMMIT/ROLLBACK and client release.
   */
  enqueue(queue: string, payload: JobPayload, options: {
    key: string;
    transaction?: PoolClient;
  }): Promise<JobEnqueueResult>;
  /** Stops consumers/maintenance; the caller still owns the PostgreSQL pool. */
  stop(): Promise<void>;
}

const schema = "mint_jobs";
const namePattern = /^[a-z][a-z0-9._-]{0,62}$/;
const maxPayloadBytes = 16 * 1024;
const int4Max = 2_147_483_647;

function integer(value: number, min: number, max = int4Max): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validateJson(value: unknown, depth = 0): asserts value is JobJson {
  if (depth > 64) throw new Error("Job payload nesting exceeds 64 levels.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "object" && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
    for (const item of Array.isArray(value) ? value : Object.values(value)) validateJson(item, depth + 1);
    if (Object.getOwnPropertySymbols(value).length === 0) return;
  }
  throw new Error("Job payload must contain only JSON values.");
}

function envelope(payload: unknown): { version: 1; payload: JobPayload } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new Error("Job payload must be a JSON object.");
  }
  validateJson(payload);
  const serialized = JSON.stringify({ version: 1, payload });
  if (Buffer.byteLength(serialized, "utf8") > maxPayloadBytes) {
    throw new Error("Job envelope exceeds 16384 bytes.");
  }
  // Detach the payload from caller mutations before any database await.
  return JSON.parse(serialized) as { version: 1; payload: JobPayload };
}

function adapter(client: Pick<Pool, "query"> | PoolClient): Db {
  return { executeSql: (text, values) => client.query(text, values) };
}

function policy(queue: LocalJobQueue): QueueOptions {
  return {
    retryLimit: queue.retryLimit,
    retryDelay: queue.retryDelaySeconds,
    retryBackoff: queue.retryBackoff,
    ...(queue.retryBackoff ? { retryDelayMax: queue.retryDelayMaxSeconds } : {}),
    expireInSeconds: queue.expireInSeconds,
    retentionSeconds: queue.retentionSeconds,
    deleteAfterSeconds: queue.deleteAfterSeconds,
  };
}

/**
 * Callable local runtime only: no environment reads, signal handlers, pool
 * ownership, remote execution or exactly-once domain side-effect guarantee.
 * pg-boss owns its internal schema/versioning; domain SQL uses the central journal.
 */
export async function startLocalJobRuntime(pool: Pool, options: LocalJobRuntimeOptions): Promise<LocalJobRuntime> {
  if (!options || !Array.isArray(options.queues) || options.queues.length < 1 || options.queues.length > 64
    || !Number.isFinite(options.pollingIntervalSeconds) || options.pollingIntervalSeconds < 0.5
    || options.pollingIntervalSeconds > 60 || !integer(options.superviseIntervalSeconds, 1, 86_400)
    || !integer(options.maintenanceIntervalSeconds, 1, 86_400)
    || !integer(options.shutdownTimeoutMs, 1_000) || typeof options.onError !== "function") {
    throw new Error("Invalid local job runtime configuration.");
  }
  const queues = options.queues.map((queue) => ({ ...queue }));
  const names = new Set<string>();
  for (const queue of queues) {
    if (typeof queue.name !== "string" || !namePattern.test(queue.name) || names.has(queue.name)
      || !integer(queue.retryLimit, 0, 20) || !integer(queue.retryDelaySeconds, 0)
      || typeof queue.retryBackoff !== "boolean"
      || (queue.retryBackoff
        ? typeof queue.retryDelayMaxSeconds !== "number" || !integer(queue.retryDelayMaxSeconds, 1)
          || queue.retryDelayMaxSeconds < queue.retryDelaySeconds
        : queue.retryDelayMaxSeconds !== undefined)
      || !integer(queue.expireInSeconds, 1, 86_400)
      || !integer(queue.retentionSeconds, 1) || !integer(queue.deleteAfterSeconds, 1)
      || !integer(queue.concurrency, 1, 32) || (queue.handle !== undefined && typeof queue.handle !== "function")) {
      throw new Error("Invalid or duplicate local job queue configuration.");
    }
    names.add(queue.name);
  }
  const boss = new PgBoss({
    db: adapter(pool), schema, schedule: false, supervise: true,
    superviseIntervalSeconds: options.superviseIntervalSeconds,
    monitorIntervalSeconds: options.superviseIntervalSeconds,
    maintenanceIntervalSeconds: options.maintenanceIntervalSeconds,
    // Schema upgrades remain pg-boss-owned and advisory-lock serialized.
    migrate: true, createSchema: true,
  });
  boss.on("error", () => options.onError({ name: "LocalJobRuntimeError" }));
  boss.on("warning", () => options.onError({ name: "LocalJobRuntimeWarning" }));
  let stopping: Promise<void> | undefined;
  try {
    await runStartupMigrations(pool, options.migrations);
    await boss.start();
    for (const queue of queues) {
      const expected = policy(queue);
      await boss.createQueue(queue.name, { ...expected, policy: "exclusive" });
      const actual = await boss.getQueue(queue.name);
      if (!actual || actual.policy !== "exclusive"
        || Object.entries(expected).some(([key, value]) => actual[key as keyof QueueOptions] !== value)) {
        throw new Error(`Persisted job queue configuration differs for ${queue.name}.`);
      }
    }
    // All queue contracts are verified before any domain handler can run.
    for (const queue of queues) {
      if (!queue.handle) continue;
      const handle = queue.handle;
      await boss.work<unknown>(queue.name, {
        batchSize: 1, localConcurrency: queue.concurrency,
        pollingIntervalSeconds: options.pollingIntervalSeconds,
      }, async ([job]) => {
        if (!job) throw new Error("Local job worker received an empty batch.");
        try {
          const data = job.data;
          if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("payload" in data)) {
            throw new Error("Unsupported local job envelope.");
          }
          const validated = envelope(data.payload);
          await handle({ id: job.id, payload: validated.payload, attempt: job.retryCount + 1, signal: job.signal });
        } catch {
          options.onError({ name: "LocalJobHandlerError", queue: queue.name, jobId: job.id });
          // pg-boss persists thrown errors; never persist domain text or credentials.
          throw new Error("Local job handler failed.");
        }
      });
    }
    return {
      async enqueue(queue, payload, sendOptions) {
        if (stopping) throw new Error("Local job runtime is stopping.");
        if (!names.has(queue)) throw new Error("Unknown local job queue.");
        if (typeof sendOptions?.key !== "string" || !sendOptions.key || sendOptions.key.includes("\0")
          || Buffer.byteLength(sendOptions.key, "utf8") > 256) {
          throw new Error("Job key must contain 1 to 256 UTF-8 bytes without NUL.");
        }
        const data = envelope(payload);
        const id = await boss.send(queue, data, {
          singletonKey: sendOptions.key,
          ...(sendOptions.transaction ? { db: adapter(sendOptions.transaction) } : {}),
        });
        return id === null ? { status: "duplicate" } : { status: "enqueued", id };
      },
      stop() {
        stopping ??= boss.stop({ close: false, graceful: true, timeout: options.shutdownTimeoutMs });
        return stopping;
      },
    };
  } catch (error) {
    try {
      await boss.stop({ close: false, graceful: false });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Local job startup and cleanup failed.");
    }
    throw error;
  }
}
