import { readFile } from "node:fs/promises";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { runMigrations } from "./migrations";

export interface StartupMigrationOptions {
  /** Absolute packages directory containing the central journal and domain SQL. */
  readonly packagesRoot: string;
  /** Advisory-lock acquisition timeout in milliseconds (positive PostgreSQL int4). */
  readonly lockTimeoutMs: number;
}

// Two-int session advisory locks are database-scoped. All target starters use this key.
const lockKey = [0x4d494e54, 0x4d494752] as const;
const files = [
  { tag: "0000_platform_rate_limits", path: "platform/migrations/0000_rate_limits.sql" },
  { tag: "0001_accounts", path: "domain-accounts/migrations/0000_accounts.sql" },
  { tag: "0002_catalog_recordings", path: "domain-catalog/migrations/0000_recordings.sql" },
  { tag: "0003_library_identity", path: "domain-library/migrations/0000_library_identity.sql" },
  { tag: "0004_library_listing", path: "domain-library/migrations/0001_library_listing.sql" },
  { tag: "0005_platform_events", path: "platform/migrations/0001_events.sql" },
  { tag: "0006_platform_public_read_cache", path: "platform/migrations/0002_public_read_cache.sql" },
  { tag: "0007_catalog_startup_seed_receipts", path: "domain-catalog/migrations/0001_startup_seed_receipts.sql" },
  { tag: "0008_catalog_listenbrainz_seed_ingestion", path: "domain-catalog/migrations/0002_listenbrainz_seed_ingestion.sql" },
  { tag: "0009_playback_listening_history", path: "domain-playback/migrations/0000_listening_history.sql" },
  { tag: "0010_library_scan_jobs", path: "domain-library/migrations/0002_library_scan_jobs.sql" },
  { tag: "0011_playback_queue_snapshots", path: "domain-playback/migrations/0001_queue_snapshots.sql" },
] as const;

/**
 * Fresh-target composition only; never runs on import or selects a pool/environment.
 * The supplied artifact tree must retain platform/migrations/meta/_journal.json
 * and every domain SQL path relative to packagesRoot.
 */
export async function runStartupMigrations(pool: Pool, options: StartupMigrationOptions): Promise<void> {
  if (typeof options?.packagesRoot !== "string" || !path.isAbsolute(options.packagesRoot)
    || options.packagesRoot.includes("\0")) {
    throw new Error("packagesRoot must be an explicit absolute packages directory");
  }
  if (!Number.isInteger(options.lockTimeoutMs) || options.lockTimeoutMs <= 0
    || options.lockTimeoutMs > 2_147_483_647) {
    throw new Error("lockTimeoutMs must be a positive PostgreSQL int4 number of milliseconds");
  }
  const journal: unknown = JSON.parse(await readFile(
    path.join(options.packagesRoot, "platform/migrations/meta/_journal.json"), "utf8",
  ));
  const client = await pool.connect();
  const errors: unknown[] = [];
  let originalTimeout: string | undefined;
  let lockAttempted = false;
  let locked = false;
  let discard = false;
  const onClientError = (error: Error) => {
    discard = true;
    if (!errors.includes(error)) errors.push(error);
  };
  client.on("error", onClientError);
  try {
    const result = await client.query<{ lock_timeout: string }>("SHOW lock_timeout");
    originalTimeout = result.rows[0]?.lock_timeout;
    if (originalTimeout === undefined) throw new Error("PostgreSQL did not return lock_timeout");
    await client.query("SELECT set_config('lock_timeout', $1, false)", [`${options.lockTimeoutMs}ms`]);
    lockAttempted = true;
    await client.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [...lockKey]);
    locked = true;
    await client.query("SELECT set_config('lock_timeout', $1, false)", [originalTimeout]);
    await runMigrations(drizzle(client), {
      journal,
      migrationsRoot: options.packagesRoot,
      files,
      history: { schema: "mint_migrations", table: "__drizzle_migrations" },
    });
  } catch (error) {
    if (!errors.includes(error)) errors.push(error);
  } finally {
    if (lockAttempted) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked", [...lockKey],
        );
        const unlocked = result.rows[0]?.unlocked;
        if (typeof unlocked !== "boolean" || (!unlocked && locked)) {
          throw new Error("Startup migration advisory lock was not held during cleanup");
        }
      } catch (error) {
        discard = true;
        errors.push(error);
      }
    }
    if (originalTimeout !== undefined) {
      try {
        await client.query("SELECT set_config('lock_timeout', $1, false)", [originalTimeout]);
      } catch (error) {
        discard = true;
        errors.push(error);
      }
    }
    // A destroyed connection may still emit its final transport error asynchronously.
    if (!discard) client.removeListener("error", onClientError);
    client.release(discard);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Startup migration and cleanup failed");
}
