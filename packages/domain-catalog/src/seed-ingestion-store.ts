import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CatalogSeedIngestionResult } from "./seed-ingestion";
import {
  CATALOG_SEED_INGESTION_LIMITS as limits,
  CatalogSeedIngestionError,
  LISTENBRAINZ_SEED_KEY,
  type ListenBrainzSnapshot,
} from "./listenbrainz-source";

type Query = <Row extends object>(text: string, values?: unknown[]) => Promise<readonly Row[]>;

async function transaction<T>(
  pool: Pool,
  work: (query: Query) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + limits.transactionTimeoutMs;
  const client: PoolClient = await pool.connect();
  let begun = false;
  let discard = false;
  const raw = async <Row extends object>(text: string, values?: unknown[], timeoutMs = deadline - Date.now()) => {
    if (timeoutMs <= 0) throw new CatalogSeedIngestionError("aborted", true);
    const config = { text, values, query_timeout: timeoutMs };
    try {
      return await client.query<Row>(config);
    } catch (error) {
      if (Date.now() >= deadline) discard = true;
      throw error;
    }
  };
  const query: Query = async <Row extends object>(text: string, values?: unknown[]) => {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CatalogSeedIngestionError("aborted", true);
    await raw(
      "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
      [`${remaining}ms`, `${Math.min(remaining, 1000)}ms`],
    );
    return (await raw<Row>(text, values)).rows;
  };
  try {
    signal?.throwIfAborted();
    await raw("BEGIN");
    begun = true;
    const result = await work(query);
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new CatalogSeedIngestionError("aborted", true);
    await raw("COMMIT");
    return result;
  } catch (error) {
    if (begun && !discard) {
      try {
        await raw("ROLLBACK", undefined, 1000);
      } catch (rollbackError) {
        discard = true;
        throw new AggregateError([error, rollbackError], "Catalog ingestion transaction and rollback failed.");
      }
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

interface Receipt {
  state: string;
  paused: boolean;
  blocked: boolean;
  active: boolean;
  not_before: Date;
  lease_until: Date | null;
  outcome: CatalogSeedIngestionResult["outcome"] | null;
  received: number;
  persisted: number;
  missing_identifiers: number;
}

export async function claimCatalogSeed(
  pool: Pool,
  signal: AbortSignal,
): Promise<{ token: string } | { result: CatalogSeedIngestionResult }> {
  return transaction(pool, async (query) => {
    await query(
      "INSERT INTO catalog.listenbrainz_seed_ingestions (seed_key) VALUES ($1) ON CONFLICT DO NOTHING",
      [LISTENBRAINZ_SEED_KEY],
    );
    const [row] = await query<Receipt>(
      `SELECT *, not_before > clock_timestamp() AS blocked,
        lease_until > clock_timestamp() AS active
       FROM catalog.listenbrainz_seed_ingestions WHERE seed_key = $1 FOR UPDATE`,
      [LISTENBRAINZ_SEED_KEY],
    );
    if (!row) throw new Error("Catalog ingestion receipt missing after insert.");
    if (row.paused) throw new CatalogSeedIngestionError("paused", true);
    if (row.state === "completed") {
      if (!row.outcome) throw new Error("Catalog ingestion completion has no outcome.");
      return { result: {
        version: 1, key: LISTENBRAINZ_SEED_KEY, status: "already_ingested", outcome: row.outcome,
        received: row.received, persisted: row.persisted, missingIdentifiers: row.missing_identifiers,
      } };
    }
    if (row.active) throw new CatalogSeedIngestionError("busy", true, row.lease_until ?? undefined);
    if (row.blocked) throw new CatalogSeedIngestionError("cooldown", true, row.not_before);
    const token = randomUUID();
    await query(
      `UPDATE catalog.listenbrainz_seed_ingestions SET state = 'running', lease_token = $2,
        lease_until = clock_timestamp() + $3 * interval '1 second', attempts = attempts + 1,
        not_before = clock_timestamp() + $4 * interval '1 second'
       WHERE seed_key = $1`,
      [LISTENBRAINZ_SEED_KEY, token, limits.leaseSeconds, limits.minimumIntervalSeconds],
    );
    return { token };
  }, signal);
}

export async function publishCatalogSeed(
  pool: Pool,
  token: string,
  snapshot: ListenBrainzSnapshot,
  signal: AbortSignal,
): Promise<CatalogSeedIngestionResult> {
  const outcome = snapshot.observations.length > 0 ? "observations"
    : snapshot.received === 0 ? "empty_feed" : "no_identified_recordings";
  const hash = createHash("sha256").update(JSON.stringify([
    snapshot.from, snapshot.to, snapshot.updated, snapshot.received,
    snapshot.missingIdentifiers, snapshot.observations,
  ])).digest("hex");
  return transaction(pool, async (query) => {
    const owned = await query(
      `SELECT seed_key FROM catalog.listenbrainz_seed_ingestions
       WHERE seed_key = $1 AND state = 'running' AND lease_token = $2
         AND lease_until > clock_timestamp() AND NOT paused FOR UPDATE`,
      [LISTENBRAINZ_SEED_KEY, token],
    );
    if (owned.length !== 1) throw new CatalogSeedIngestionError("lease_lost", true);
    await query(
      `INSERT INTO catalog.listenbrainz_seed_observations
        (seed_key, position, recording_mbid, title, artist, release, artist_mbids, listen_count)
       SELECT $1, position, recording_mbid, title, artist, release, artist_mbids, listen_count
       FROM jsonb_to_recordset($2::jsonb) AS r(
         position smallint, recording_mbid uuid, title text, artist text,
         release text, artist_mbids uuid[], listen_count bigint)`,
      [LISTENBRAINZ_SEED_KEY, JSON.stringify(snapshot.observations.map((row) => ({
        position: row.position, recording_mbid: row.recordingMbid,
        title: row.title, artist: row.artist, release: row.release,
        artist_mbids: row.artistMbids, listen_count: row.listenCount,
      })))],
    );
    const completed = await query(
      `UPDATE catalog.listenbrainz_seed_ingestions SET state = 'completed',
        lease_token = NULL, lease_until = NULL, last_error = NULL,
        period_from = $3, period_to = $4, source_updated_at = $5, fetched_at = $6,
        completed_at = clock_timestamp(), outcome = $7, received = $8,
        persisted = $9, missing_identifiers = $10, content_hash = $11
       WHERE seed_key = $1 AND state = 'running' AND lease_token = $2
         AND lease_until > clock_timestamp() AND NOT paused RETURNING seed_key`,
      [LISTENBRAINZ_SEED_KEY, token, snapshot.from, snapshot.to, snapshot.updated,
        snapshot.fetched, outcome, snapshot.received, snapshot.observations.length,
        snapshot.missingIdentifiers, hash],
    );
    if (completed.length !== 1) throw new CatalogSeedIngestionError("lease_lost", true);
    return {
      version: 1, key: LISTENBRAINZ_SEED_KEY, status: "ingested", outcome,
      received: snapshot.received, persisted: snapshot.observations.length,
      missingIdentifiers: snapshot.missingIdentifiers,
    };
  }, signal);
}

export async function failCatalogSeed(
  pool: Pool,
  token: string,
  failure: CatalogSeedIngestionError,
): Promise<void> {
  const after = failure.retryAt ?? new Date(Date.now() + 60_000);
  const code = failure.code === "invalid_source" || failure.code === "aborted"
    ? failure.code : "source_unavailable";
  await transaction(pool, async (query) => {
    // A provider refusal remains authoritative even if its request lost the lease.
    await query(
      `UPDATE catalog.listenbrainz_seed_ingestions
       SET not_before = greatest(not_before, $2::timestamptz) WHERE seed_key = $1`,
      [LISTENBRAINZ_SEED_KEY, after],
    );
    await query(
      `UPDATE catalog.listenbrainz_seed_ingestions SET state = 'retry_wait',
        lease_token = NULL, lease_until = NULL, last_error = $3
       WHERE seed_key = $1 AND state = 'running' AND lease_token = $2
         AND lease_until > clock_timestamp()`,
      [LISTENBRAINZ_SEED_KEY, token, code],
    );
  });
}
