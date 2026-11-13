import type { LocalJobRuntime } from "@mint/platform";
import type { Pool } from "pg";
import type { CatalogSeedStore } from "./startup-seeding";

/**
 * The pool and runtime must target the same database with startup migrations applied.
 * Receipts outlive queue retention; an existing queue intent can satisfy a new receipt.
 * This schedules intent only, without fetching or ingesting metadata.
 * Pool acquisition is capped at two seconds, lock waits at one second and the
 * borrowed transaction at five seconds. Cancellation evicts its client.
 */
export function createCatalogSeedStore(
  pool: Pool,
  runtime: Pick<LocalJobRuntime, "enqueue">,
  queue: string,
): CatalogSeedStore {
  if (!Number.isInteger(pool.options.connectionTimeoutMillis)
    || !pool.options.connectionTimeoutMillis || pool.options.connectionTimeoutMillis < 1
    || pool.options.connectionTimeoutMillis > 2000) {
    throw new RangeError("Catalog seed scheduling requires a pool connection timeout from 1 to 2000ms.");
  }
  return {
    async insertIfAbsent(job, signal) {
      signal?.throwIfAborted();
      const payload = { ...job };
      const client = await pool.connect();
      let discard = false;
      let released = false;
      let timedOut = false;
      const release = (destroy: boolean) => {
        if (released) return;
        released = true;
        client.release(destroy);
      };
      const abort = () => {
        discard = true;
        // Destroying the connection also terminates its query and rolls back
        // uncommitted receipt/queue writes; never return it to the idle pool.
        release(true);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, 5000);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        signal?.throwIfAborted();
        await client.query("BEGIN");
        await client.query(
          `SELECT set_config('statement_timeout', '5000ms', true),
            set_config('lock_timeout', '1000ms', true),
            set_config('idle_in_transaction_session_timeout', '5000ms', true)`,
        );
        const inserted = await client.query(
          `INSERT INTO catalog.startup_seed_receipts (key)
           VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`,
          [payload.key],
        );
        signal?.throwIfAborted();
        if (inserted.rowCount === 0) {
          await client.query("COMMIT");
          return "existing";
        }
        await runtime.enqueue(queue, { version: 1, job: payload }, { key: payload.key, transaction: client });
        signal?.throwIfAborted();
        await client.query("COMMIT");
        return "inserted";
      } catch (error) {
        if (!released) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            discard = true;
            throw new AggregateError([error, rollbackError], "Catalog seed transaction and rollback failed.");
          }
        }
        signal?.throwIfAborted();
        if (timedOut) throw new Error("Catalog seed scheduling transaction exceeded 5000ms.");
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        release(discard);
      }
    },
  };
}
