import {
  createLibraryScanRepository, LibraryRepositoryInputError, scanLibraryRoot,
  type LibraryScanOptions,
} from "@mint/domain-library";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import type { LocalJobQueue, LocalJobRuntime } from "@mint/platform";
import { isAbsolute } from "node:path";

export type LocalLibraryScanOptions = Omit<LibraryScanOptions, "cursor" | "signal">;
export interface LocalLibraryScanConfiguration {
  /** Existing persisted roots only. Configuring a root creates its first explicit intent. */
  rootIds: readonly string[];
  options: LocalLibraryScanOptions;
}

export const LIBRARY_SCAN_QUEUE = {
  name: "library.scan.v1", retryLimit: 2, retryDelaySeconds: 1, retryBackoff: false,
  expireInSeconds: 3600, retentionSeconds: 86_400, deleteAfterSeconds: 86_400, concurrency: 1,
} as const satisfies LocalJobQueue;

export function validateLibraryScanRootId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("Library scan roots must be canonical lowercase UUIDs.");
  }
}

export function validateLocalLibraryScanConfiguration(value: LocalLibraryScanConfiguration): void {
  if (!value || !Array.isArray(value.rootIds) || value.rootIds.length < 1 || value.rootIds.length > 32
    || new Set(value.rootIds).size !== value.rootIds.length) {
    throw new Error("Library scanning requires 1 to 32 distinct explicit root IDs.");
  }
  value.rootIds.forEach(validateLibraryScanRootId);
  const options = value.options;
  const audio = options?.audio;
  if (!options || !audio || "cursor" in options || "signal" in options || "signal" in audio) {
    throw new Error("Invalid local Library scan options.");
  }
  for (const [number, min, max] of [
    [options.maxEntries, 1, 100_000], [options.maxFiles, 1, 10_000],
    [options.maxDepth, 0, 64], [options.timeoutMs, 1, 3_600_000],
    [options.maxReplayEntries ?? 100_000, 0, 100_000],
    [audio.maxProbeInputBytes, 1, 512 * 1024 * 1024],
    [audio.maxDecodeInputBytes, 1, 512 * 1024 * 1024],
    [audio.maxOutputBytes, 1, 1024 * 1024],
    [audio.probeTimeoutMs, 1, 120_000], [audio.decodeTimeoutMs, 1, 120_000],
  ] as const) {
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error("Local Library scan budgets exceed supported bounds.");
    }
  }
  for (const tool of [audio.ffmpegPath, audio.ffprobePath]) {
    if (typeof tool !== "string" || !isAbsolute(tool) || tool.length > 4096 || tool.includes("\0")) {
      throw new Error("Library scan media tools require absolute paths.");
    }
  }
}

async function withRootLock<T>(pool: Pool, rootId: string, operation: (client: PoolClient) => Promise<T>):
  Promise<{ status: "busy" } | { status: "locked"; value: T }> {
  validateLibraryScanRootId(rootId);
  const client = await pool.connect();
  let locked = false;
  let lockAttempted = false;
  let lockResolved = false;
  let damaged = false;
  const onClientError = () => { damaged = true; };
  client.on("error", onClientError);
  try {
    lockAttempted = true;
    locked = (await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('mint.library.scan:' || $1, 0)) AS locked", [rootId],
    )).rows[0]!.locked;
    lockResolved = true;
    if (!locked) return { status: "busy" };
    const value = await operation(client);
    if (damaged) throw new Error("Library scan database connection was lost.");
    return { status: "locked", value };
  } finally {
    try {
      if (lockAttempted && (!lockResolved || locked) && !damaged) {
        const unlocked = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended('mint.library.scan:' || $1, 0)) AS unlocked", [rootId],
        );
        if (typeof unlocked.rows[0]?.unlocked !== "boolean" || (locked && !unlocked.rows[0].unlocked)) {
          throw new Error("Library scan root lock was lost.");
        }
      }
    } catch (error) {
      damaged = true;
      throw error;
    } finally {
      if (!damaged) client.removeListener("error", onClientError);
      client.release(damaged);
    }
  }
}

/**
 * start preserves all existing intent, including terminal states. resume retries the saved
 * cursor; restart alone discards it. Never call implicitly for unconfigured roots.
 */
export async function requestLibraryScan(pool: Pool, rootId: string, mode: "start" | "resume" | "restart"):
  Promise<"accepted" | "busy"> {
  if (!["start", "resume", "restart"].includes(mode)) throw new Error("Invalid Library scan request mode.");
  const result = await withRootLock(pool, rootId, async (client) => {
    if (mode === "start") {
      await client.query("INSERT INTO library.scan_jobs (root_id) VALUES ($1) ON CONFLICT (root_id) DO NOTHING", [rootId]);
    } else {
      await client.query(`INSERT INTO library.scan_jobs (root_id) VALUES ($1)
        ON CONFLICT (root_id) DO UPDATE SET status = 'pending', failures = 0, last_error = NULL,
          cursor = CASE WHEN $2 THEN NULL ELSE scan_jobs.cursor END,
          had_issues = CASE WHEN $2 THEN false ELSE scan_jobs.had_issues END,
          last_result = CASE WHEN $2 THEN NULL ELSE scan_jobs.last_result END, updated_at = now()
        WHERE $2 OR scan_jobs.status NOT IN ('completed', 'partial')`, [rootId, mode === "restart"]);
    }
  });
  return result.status === "busy" ? "busy" : "accepted";
}

/** Recovery reads durable intent, not queue internals; it also recovers exhausted/deleted jobs. */
export async function dispatchLibraryScans(pool: Pool, jobs: LocalJobRuntime, rootIds: readonly string[]): Promise<void> {
  const pending = await pool.query<{ root_id: string }>(
    "SELECT root_id FROM library.scan_jobs WHERE root_id = ANY($1::uuid[]) AND status = 'pending' ORDER BY root_id",
    [rootIds],
  );
  for (const row of pending.rows) {
    await jobs.enqueue(LIBRARY_SCAN_QUEUE.name, { rootId: row.root_id }, { key: row.root_id });
  }
}

export async function runLibraryScanBatch(
  pool: Pool, rootId: string, config: LocalLibraryScanConfiguration, signal: AbortSignal,
): Promise<void> {
  validateLocalLibraryScanConfiguration(config);
  validateLibraryScanRootId(rootId);
  if (!config.rootIds.includes(rootId)) throw new Error("Library scan root is not enabled in this worker.");
  await withRootLock(pool, rootId, async (client) => {
    signal.throwIfAborted();
    const row = (await client.query<{ cursor: string | null; had_issues: boolean }>(
      "SELECT cursor, had_issues FROM library.scan_jobs WHERE root_id = $1 AND status = 'pending'", [rootId],
    )).rows[0];
    if (!row) return;
    let result;
    try {
      result = await scanLibraryRoot(createLibraryScanRepository(drizzle(client)), rootId, {
        ...config.options, signal, ...(row.cursor === null ? {} : { cursor: row.cursor }),
      });
    } catch (error) {
      if (signal.aborted && (error === signal.reason || (error instanceof Error && error.name === "AbortError"))) {
        return;
      }
      const rejected = error instanceof LibraryRepositoryInputError;
      await client.query(`UPDATE library.scan_jobs SET failures = least(failures + 1, 5),
        status = CASE WHEN $2 THEN 'blocked' WHEN failures >= 4 THEN 'failed' ELSE 'pending' END,
        last_error = CASE WHEN $2 THEN 'cursor-rejected' ELSE 'scan-failed' END, updated_at = now()
        WHERE root_id = $1`, [rootId, rejected]);
      throw new Error(rejected ? "Library scan cursor rejected; explicit restart may be required." : "Library scan batch failed.");
    }
    const { nextCursor, issues: _issues, ...summary } = result;
    const hadIssues = row.had_issues || result.issueCount > 0 || result.skippedDirectories > 0;
    const noProgress = result.status === "limited" && (!nextCursor || nextCursor === row.cursor);
    const error = result.status === "root-unavailable" ? "root-unavailable" : noProgress ? "no-progress" : null;
    const status = error ? "blocked"
      : nextCursor || result.status === "cancelled" ? "pending"
      : hadIssues || result.status === "partial" ? "partial" : "completed";
    await client.query(`UPDATE library.scan_jobs SET cursor = $2, status = $3, had_issues = $4,
      failures = CASE WHEN $7 THEN failures ELSE 0 END,
      last_result = $5::jsonb, last_error = CASE WHEN $7 THEN last_error ELSE $6 END,
      updated_at = now() WHERE root_id = $1`,
    [rootId, nextCursor ?? (error || result.status === "cancelled" ? row.cursor : null),
      status, hadIssues, JSON.stringify(summary), error, result.status === "cancelled"]);
    if (error) throw new Error("Library scan blocked; inspect persisted status and explicitly resume or restart.");
  });
}
