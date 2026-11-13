import { sql } from "drizzle-orm";
import { bigint, check, index, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

export const rateLimits = pgSchema("platform").table("rate_limits", {
  key: text("key").primaryKey(),
  attempts: bigint("attempts", { mode: "bigint" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  check("rate_limits_attempts_positive", sql`${table.attempts} > 0`),
  index("rate_limits_expiry_idx").on(table.expiresAt),
]);

const maxPgInteger = 2_147_483_647;

function positiveInteger(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer at most ${maximum}`);
  }
}

/** Inject a pool or client; connection and migration ownership stay with composition. */
export class PostgresRateLimiter {
  constructor(private readonly db: Pick<Pool, "query">) {}

  /**
   * First hit starts the window; every hit counts, including denials.
   * Limits fit JS safe integers; windows fit PostgreSQL int4 seconds.
   * PostgreSQL bigint counter overflow and all storage failures propagate.
   */
  async allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    positiveInteger(limit, Number.MAX_SAFE_INTEGER, "limit");
    positiveInteger(windowSeconds, maxPgInteger, "windowSeconds");
    // The correlated conflict subquery samples one clock after acquiring the row lock.
    const result = await this.db.query<{ allowed: boolean }>(`
      INSERT INTO platform.rate_limits AS counter (key, attempts, expires_at)
      VALUES ($1, 1, clock_timestamp() + make_interval(secs => $3::integer))
      ON CONFLICT (key) DO UPDATE
      SET (attempts, expires_at) = (
        SELECT
          CASE WHEN counter.expires_at <= clock.now THEN 1 ELSE counter.attempts + 1 END,
          CASE WHEN counter.expires_at <= clock.now
            THEN clock.now + make_interval(secs => $3::integer) ELSE counter.expires_at END
        FROM (SELECT clock_timestamp() AS now) AS clock
        WHERE counter.key = $1
      )
      RETURNING attempts <= $2::bigint AS allowed
    `, [key, limit, windowSeconds]);
    const row = result.rows[0];
    if (!row || typeof row.allowed !== "boolean") {
      throw new Error("Rate limit query did not return an admission result");
    }
    return row.allowed;
  }

  /** One bounded sweep; callers own retention scheduling. Never removes live counters. */
  async cleanupExpired(batchLimit: number): Promise<number> {
    positiveInteger(batchLimit, maxPgInteger, "batchLimit");
    const result = await this.db.query(`
      WITH expired AS (
        SELECT key FROM platform.rate_limits
        WHERE expires_at <= statement_timestamp()
        ORDER BY expires_at
        LIMIT $1::integer
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM platform.rate_limits AS counter
      USING expired
      WHERE counter.key = expired.key
    `, [batchLimit]);
    if (result.rowCount === null) {
      throw new Error("Rate limit cleanup did not return a deletion count");
    }
    return result.rowCount;
  }
}
