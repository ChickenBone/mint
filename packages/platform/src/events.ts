import type { Pool } from "pg";

export type EventAudience = { readonly kind: "public" | "admin" }
  | { readonly kind: "account"; readonly accountId: string };
export type EventJson = null | boolean | number | string | readonly EventJson[]
  | { readonly [key: string]: EventJson };
export interface EventInput {
  readonly type: string;
  readonly payload: EventJson;
}
export interface StoredEvent extends EventInput {
  readonly sequence: bigint;
  readonly createdAt: Date;
}
export interface EventPage {
  readonly events: readonly StoredEvent[];
  readonly cursor: bigint;
  readonly highWatermark: bigint;
  readonly replayFloor: bigint;
  /** Refetch authoritative state before restarting from highWatermark. */
  readonly resetRequired: boolean;
}

const maximumSequence = 9_223_372_036_854_775_807n;

function cursor(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n || value > maximumSequence) {
    throw new RangeError("Event cursor must be a nonnegative PostgreSQL bigint");
  }
}

function batch(value: number, maximum: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`Event batch size must be an integer from 1 to ${maximum}`);
  }
}

function stream(audience: EventAudience): string {
  if (audience.kind === "public" || audience.kind === "admin") return audience.kind;
  if (audience.kind !== "account" || typeof audience.accountId !== "string"
    || !audience.accountId.length || audience.accountId.includes("\0")
    || Buffer.byteLength(audience.accountId, "utf8") > 128) {
    throw new TypeError("Event audience must be public, admin or a bounded account identity");
  }
  return `account:${audience.accountId}`;
}

function payloadJson(event: EventInput): string {
  if (typeof event.type !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/.test(event.type)) {
    throw new TypeError("Event type must be a lowercase identifier of at most 128 characters");
  }
  const json = JSON.stringify(event.payload, (_key, value: unknown) => {
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol"
      || (typeof value === "number" && !Number.isFinite(value))) {
      throw new TypeError("Event payload must contain only JSON values");
    }
    return value;
  });
  if (json === undefined || Buffer.byteLength(json, "utf8") > 16_384) {
    throw new RangeError("Event payload must be JSON of at most 16384 UTF-8 bytes");
  }
  return json;
}

interface EventRow {
  sequence: string;
  type: string;
  payload: EventJson;
  created_at: Date;
}

function stored(row: EventRow): StoredEvent {
  const sequence = BigInt(row.sequence);
  if (sequence <= 0n || sequence > maximumSequence || !(row.created_at instanceof Date)
    || !Number.isFinite(row.created_at.getTime())) {
    throw new Error("Event storage returned an invalid event");
  }
  return { sequence, type: row.type, payload: row.payload, createdAt: row.created_at };
}

/**
 * Server-only replay storage, not authorization or a WebSocket transport.
 * Callers select audiences after fresh authorization and validate domain payloads.
 * Inject a transaction's client to commit domain writes and events atomically;
 * a pool is suitable only for independent event writes, reads and retention.
 */
export class PostgresEventLog {
  constructor(private readonly db: Pick<Pool, "query">) {}

  /**
   * Per-audience row locking makes sequence order match commit order. A global
   * sequence would let a reconnect cursor skip a slower, uncommitted writer.
   * Rollbacks leave neither an event nor a sequence increment.
   */
  async append(audience: EventAudience, event: EventInput): Promise<StoredEvent> {
    const key = stream(audience);
    const json = payloadJson(event);
    const result = await this.db.query<EventRow>(`
      WITH next AS (
        INSERT INTO platform.event_streams AS streams (stream, last_sequence, replay_floor)
        VALUES ($1, 1, 0)
        ON CONFLICT (stream) DO UPDATE SET last_sequence = streams.last_sequence + 1
        RETURNING stream, last_sequence
      )
      INSERT INTO platform.events (stream, sequence, type, payload)
      SELECT stream, last_sequence, $2, $3::jsonb FROM next
      RETURNING sequence::text, type, payload, created_at
    `, [key, event.type, json]);
    if (result.rows.length !== 1) throw new Error("Event append did not return one event");
    return stored(result.rows[0]!);
  }

  /** One snapshot covers both retention bounds and the bounded audience page. */
  async replay(audience: EventAudience, after: bigint, limit: number): Promise<EventPage> {
    const key = stream(audience);
    cursor(after);
    batch(limit, 100);
    const result = await this.db.query<{
      high: string;
      floor: string;
      sequence: string | null;
      type: string | null;
      payload: EventJson;
      created_at: Date | null;
    }>(`
      SELECT streams.last_sequence::text AS high, streams.replay_floor::text AS floor,
        events.sequence::text, events.type, events.payload, events.created_at
      FROM platform.event_streams AS streams
      LEFT JOIN LATERAL (
        SELECT sequence, type, payload, created_at FROM platform.events
        WHERE stream = streams.stream AND sequence > $2::bigint
          AND $2::bigint >= streams.replay_floor AND $2::bigint <= streams.last_sequence
        ORDER BY sequence LIMIT $3::integer
      ) AS events ON true
      WHERE streams.stream = $1
      ORDER BY events.sequence
    `, [key, after.toString(), limit]);
    const highWatermark = BigInt(result.rows[0]?.high ?? "0");
    const replayFloor = BigInt(result.rows[0]?.floor ?? "0");
    const resetRequired = after < replayFloor || after > highWatermark;
    const events = result.rows.flatMap((row) => {
      if (row.sequence === null) return [];
      if (row.type === null || row.created_at === null) {
        throw new Error("Event replay returned an incomplete event");
      }
      return [stored({
        sequence: row.sequence, type: row.type, payload: row.payload, created_at: row.created_at,
      })];
    });
    return {
      events, highWatermark, replayFloor, resetRequired,
      cursor: resetRequired ? after : (events.at(-1)?.sequence ?? after),
    };
  }

  /**
   * Caller owns retention policy/scheduling. Deletes only a bounded prefix and
   * retains a durable floor, so reconnects never mistake pruned events for none.
   * Stream rows intentionally survive even after the final event is removed.
   */
  async prune(audience: EventAudience, through: bigint, limit: number): Promise<number> {
    const key = stream(audience);
    cursor(through);
    batch(limit, 1_000);
    const result = await this.db.query<{ removed: number }>(`
      WITH locked AS MATERIALIZED (
        SELECT stream, replay_floor FROM platform.event_streams WHERE stream = $1 FOR UPDATE
      ), victims AS MATERIALIZED (
        SELECT events.stream, events.sequence FROM platform.events AS events
        JOIN locked ON locked.stream = events.stream
        WHERE events.sequence > locked.replay_floor AND events.sequence <= $2::bigint
        ORDER BY events.sequence LIMIT $3::integer
      ), deleted AS (
        DELETE FROM platform.events AS events USING victims
        WHERE events.stream = victims.stream AND events.sequence = victims.sequence
        RETURNING events.sequence
      ), advanced AS (
        UPDATE platform.event_streams
        SET replay_floor = (SELECT max(sequence) FROM deleted)
        WHERE stream = $1 AND EXISTS (SELECT 1 FROM deleted)
        RETURNING stream
      )
      SELECT count(*)::integer AS removed FROM deleted
    `, [key, through.toString(), limit]);
    const removed = result.rows[0]?.removed;
    if (!Number.isInteger(removed) || removed === undefined || removed < 0 || removed > limit) {
      throw new Error("Event retention did not return a bounded deletion count");
    }
    return removed;
  }
}
