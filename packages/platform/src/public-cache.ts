import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type PublicJson = null | boolean | number | string | PublicJson[] | { [key: string]: PublicJson };
export type PublicCacheLookup<T> =
  | { state: "miss" }
  | { state: "error"; retryUntil: Date }
  | { state: "fresh" | "stale" | "negative"; value: T; fetchedAt: Date; freshUntil: Date;
      expiresAt: Date; retryUntil: Date | null };

const maxBytes = 262_144;
const maxRetentionSeconds = 30 * 24 * 60 * 60;
const keyPattern = /^[0-9a-f]{64}$/;

function integer(value: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  }
}

function keySlot(key: string): number {
  if (!keyPattern.test(key)) throw new TypeError("Cache key must be a SHA-256 hex digest");
  return Number.parseInt(key.slice(0, 4), 16);
}

function json(value: unknown, limit: number): string {
  integer(limit, maxBytes, "maxBytes");
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new RangeError("Public JSON nesting exceeds 64 levels");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item === "string") {
      if (item.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)) {
        throw new TypeError("Public JSON contains an invalid PostgreSQL string");
      }
      return;
    }
    if (typeof item !== "object") throw new TypeError("Public cache accepts only JSON values");
    if (ancestors.has(item)) throw new TypeError("Public JSON must not be circular");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype
      && Object.getPrototypeOf(item) !== null) throw new TypeError("Public JSON must use plain objects");
    ancestors.add(item);
    if (Object.getOwnPropertySymbols(item).length || "toJSON" in item) {
      throw new TypeError("Public JSON must not have symbols or custom serialization");
    }
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new TypeError("Public JSON arrays must not have extra properties");
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i)) throw new TypeError("Public JSON arrays must not be sparse");
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !("value" in descriptor)) throw new TypeError("Public JSON must not have accessors");
        visit(descriptor.value, depth + 1);
      }
    } else {
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable || !("value" in descriptor)) throw new TypeError("Public JSON must have enumerable data properties");
        visit(name, depth + 1);
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > limit) {
    throw new RangeError("Public cache value exceeds its byte budget");
  }
  return serialized;
}

/** Only use public provider identity/version/parameters; hashing is not permission to include secrets. */
export function publicCacheKey(publicIdentity: string): string {
  if (typeof publicIdentity !== "string" || !publicIdentity.length || Buffer.byteLength(publicIdentity) > 4096) {
    throw new RangeError("Public cache identity must be 1 to 4096 UTF-8 bytes");
  }
  return createHash("sha256").update(publicIdentity).digest("hex");
}

interface Row {
  kind: "value" | "negative" | null;
  payload: unknown;
  fetched_at: Date | null;
  fresh_until: Date | null;
  expires_at: Date | null;
  retry_until: Date | null;
  retained: boolean;
  fresh: boolean;
  retrying: boolean;
}

/**
 * Public metadata only. The caller validates domain data, supplies public keys,
 * schedules cleanup, and owns provider-wide pacing and source deadlines.
 * A lease is an expiring capability: do not expose it to clients.
 */
export class PostgresPublicReadCache {
  private readonly pending = new Map<string, Promise<Row | undefined>>();
  constructor(private readonly db: Pick<Pool, "query">) {}

  async lookup<T>(key: string, validate: (value: unknown) => T, maxValueBytes: number): Promise<PublicCacheLookup<T>> {
    keySlot(key);
    integer(maxValueBytes, maxBytes, "maxBytes");
    let task = this.pending.get(key);
    if (!task) {
      if (this.pending.size >= 64) throw new Error("Public cache read admission is full");
      task = this.db.query<Row>(`
        SELECT kind, payload, fetched_at, fresh_until, expires_at, retry_until,
          COALESCE(expires_at > statement_timestamp(), false) AS retained,
          COALESCE(fresh_until > statement_timestamp(), false) AS fresh,
          COALESCE(retry_until > statement_timestamp(), false) AS retrying
        FROM platform.public_read_cache WHERE cache_key = $1
      `, [key]).then((result) => result.rows[0]).finally(() => {
        if (this.pending.get(key) === task) this.pending.delete(key);
      });
      this.pending.set(key, task);
    }
    const row = await task;
    if (!row) return { state: "miss" };
    if (!row.retained) {
      if (row.retrying && row.retry_until instanceof Date) return { state: "error", retryUntil: new Date(row.retry_until) };
      return { state: "miss" };
    }
    if ((row.kind !== "value" && row.kind !== "negative")
      || !(row.fetched_at instanceof Date) || !(row.fresh_until instanceof Date) || !(row.expires_at instanceof Date)
      || !Number.isFinite(row.fetched_at.getTime()) || !Number.isFinite(row.fresh_until.getTime())
      || !Number.isFinite(row.expires_at.getTime())) throw new Error("Invalid public cache row");
    json(row.payload, maxValueBytes);
    const validated = validate(structuredClone(row.payload));
    json(validated, maxValueBytes);
    return {
      state: row.kind === "negative" ? "negative" : row.fresh ? "fresh" : "stale",
      value: validated, fetchedAt: new Date(row.fetched_at), freshUntil: new Date(row.fresh_until), expiresAt: new Date(row.expires_at),
      retryUntil: row.retrying && row.retry_until ? new Date(row.retry_until) : null,
    };
  }

  /** Returns null when a live lease, cooldown or occupied hash slot prevents admission. */
  async acquire(key: string, leaseSeconds: number): Promise<string | null> {
    const slot = keySlot(key);
    integer(leaseSeconds, 120, "leaseSeconds");
    const token = randomUUID();
    const result = await this.db.query<{ lease_token: string }>(`
      INSERT INTO platform.public_read_cache AS cache (slot, cache_key, lease_token, lease_until)
      VALUES ($1, $2, $3::uuid, clock_timestamp() + make_interval(secs => $4::integer))
      ON CONFLICT (slot) DO UPDATE SET
        cache_key = EXCLUDED.cache_key,
        kind = CASE WHEN cache.cache_key = EXCLUDED.cache_key THEN cache.kind ELSE NULL END,
        payload = CASE WHEN cache.cache_key = EXCLUDED.cache_key THEN cache.payload ELSE NULL END,
        fetched_at = CASE WHEN cache.cache_key = EXCLUDED.cache_key THEN cache.fetched_at ELSE NULL END,
        fresh_until = CASE WHEN cache.cache_key = EXCLUDED.cache_key THEN cache.fresh_until ELSE NULL END,
        expires_at = CASE WHEN cache.cache_key = EXCLUDED.cache_key THEN cache.expires_at ELSE NULL END,
        retry_until = NULL,
        lease_token = EXCLUDED.lease_token,
        lease_until = clock_timestamp() + make_interval(secs => $4::integer)
      WHERE (cache.lease_until IS NULL OR cache.lease_until <= clock_timestamp())
        AND (cache.retry_until IS NULL OR cache.retry_until <= clock_timestamp())
        AND (cache.cache_key = EXCLUDED.cache_key OR cache.expires_at IS NULL OR cache.expires_at <= clock_timestamp())
      RETURNING lease_token::text
    `, [slot, key, token, leaseSeconds]);
    return result.rows[0]?.lease_token ?? null;
  }

  /** Publication and lease release are atomic; false means invalidated, expired or replaced. */
  async publish<T>(key: string, token: string, value: unknown, options: {
    validate: (value: unknown) => T; maxBytes: number; kind: "value" | "negative";
    freshSeconds: number; keepSeconds: number;
  }): Promise<boolean> {
    keySlot(key);
    integer(options.freshSeconds, maxRetentionSeconds, "freshSeconds");
    integer(options.keepSeconds, maxRetentionSeconds, "keepSeconds");
    if (options.kind !== "value" && options.kind !== "negative") throw new TypeError("Invalid cache kind");
    if (options.keepSeconds < options.freshSeconds
      || (options.kind === "negative" && options.keepSeconds !== options.freshSeconds)) {
      throw new RangeError("Invalid public cache retention");
    }
    const serialized = json(options.validate(value), options.maxBytes);
    const result = await this.db.query(`
      WITH locked AS MATERIALIZED (
        SELECT slot FROM platform.public_read_cache WHERE cache_key = $1 FOR UPDATE
      )
      UPDATE platform.public_read_cache SET kind = $3, payload = $4::jsonb,
        fetched_at = clock.now, fresh_until = clock.now + make_interval(secs => $5::integer),
        expires_at = clock.now + make_interval(secs => $6::integer),
        lease_token = NULL, lease_until = NULL, retry_until = NULL
      FROM locked CROSS JOIN LATERAL (SELECT clock_timestamp() AS now WHERE locked.slot IS NOT NULL) AS clock
      WHERE public_read_cache.slot = locked.slot AND lease_token = $2::uuid AND lease_until > clock.now
    `, [key, token, options.kind, serialized, options.freshSeconds, options.keepSeconds]);
    if (result.rowCount === null) throw new Error("Public cache publication returned no count");
    return result.rowCount === 1;
  }

  /** Records a bounded per-key retry delay without storing error details or changing retained values. */
  async fail(key: string, token: string, retrySeconds: number): Promise<boolean> {
    keySlot(key);
    integer(retrySeconds, 3600, "retrySeconds");
    const result = await this.db.query(`
      WITH locked AS MATERIALIZED (
        SELECT slot FROM platform.public_read_cache WHERE cache_key = $1 FOR UPDATE
      )
      UPDATE platform.public_read_cache SET lease_token = NULL, lease_until = NULL,
        retry_until = clock.now + make_interval(secs => $3::integer)
      FROM locked CROSS JOIN LATERAL (SELECT clock_timestamp() AS now WHERE locked.slot IS NOT NULL) AS clock
      WHERE public_read_cache.slot = locked.slot AND lease_token = $2::uuid AND lease_until > clock.now
    `, [key, token, retrySeconds]);
    if (result.rowCount === null) throw new Error("Public cache failure returned no count");
    return result.rowCount === 1;
  }

  async invalidate(key: string): Promise<void> {
    keySlot(key);
    await this.db.query("DELETE FROM platform.public_read_cache WHERE cache_key = $1", [key]);
    this.pending.delete(key);
  }

  async cleanupExpired(limit: number): Promise<number> {
    integer(limit, 1000, "limit");
    const result = await this.db.query(`
      WITH victims AS (
        SELECT slot FROM platform.public_read_cache
        WHERE (expires_at IS NULL OR expires_at <= statement_timestamp())
          AND (lease_until IS NULL OR lease_until <= statement_timestamp())
          AND (retry_until IS NULL OR retry_until <= statement_timestamp())
        ORDER BY slot LIMIT $1::integer FOR UPDATE SKIP LOCKED
      )
      DELETE FROM platform.public_read_cache AS cache USING victims WHERE cache.slot = victims.slot
    `, [limit]);
    if (result.rowCount === null) throw new Error("Public cache cleanup returned no count");
    return result.rowCount;
  }
}
