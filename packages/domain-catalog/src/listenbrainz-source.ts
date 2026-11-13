export const CATALOG_SEED_INGESTION_LIMITS = Object.freeze({
  maxRows: 100,
  maxBytes: 2_000_000,
  maxText: 500,
  maxArtistIds: 100,
  requestTimeoutMs: 8_000,
  commandTimeoutMs: 20_000,
  transactionTimeoutMs: 5_000,
  leaseSeconds: 30,
  minimumIntervalSeconds: 2,
  cleanupTimeoutMs: 1_000,
});

export type CatalogSeedIngestionErrorCode =
  | "invalid_payload" | "unsupported_source" | "disabled_source" | "paused"
  | "busy" | "cooldown" | "source_unavailable" | "invalid_source"
  | "lease_lost" | "aborted";

export class CatalogSeedIngestionError extends Error {
  constructor(
    readonly code: CatalogSeedIngestionErrorCode,
    readonly retryable: boolean,
    readonly retryAt?: Date,
  ) {
    super(`Catalog seed ingestion: ${code}.`);
    this.name = "CatalogSeedIngestionError";
  }
}

export const LISTENBRAINZ_SEED_KEY = "catalog:startup:lb-chart:global";
export const LISTENBRAINZ_SEED_URL =
  "https://api.listenbrainz.org/1/stats/sitewide/recordings?range=week&count=100&offset=0";

export interface ListenBrainzObservation {
  readonly position: number;
  readonly recordingMbid: string;
  readonly title: string;
  readonly artist: string;
  readonly release: string | null;
  readonly artistMbids: readonly string[];
  readonly listenCount: number;
}

export interface ListenBrainzSnapshot {
  readonly from: Date;
  readonly to: Date;
  readonly updated: Date;
  readonly fetched: Date;
  readonly received: number;
  readonly missingIdentifiers: number;
  readonly observations: readonly ListenBrainzObservation[];
}

function invalid(): never {
  throw new CatalogSeedIngestionError("invalid_source", true);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")
    || value.length > CATALOG_SEED_INGESTION_LIMITS.maxText) invalid();
  const result = value.trim().replace(/\s+/g, " ");
  if (!result) invalid();
  return result;
}

function mbid(value: unknown): string {
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) invalid();
  return value.toLowerCase();
}

function timestamp(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) invalid();
  return date;
}

export function parseListenBrainzSnapshot(body: unknown, fetched = new Date()): ListenBrainzSnapshot {
  const payload = object(object(body).payload);
  if (payload.range !== "week" || !Array.isArray(payload.recordings)
    || payload.recordings.length > CATALOG_SEED_INGESTION_LIMITS.maxRows) invalid();
  const from = timestamp(payload.from_ts);
  const to = timestamp(payload.to_ts);
  const updated = timestamp(payload.last_updated);
  if (from >= to || updated < from || !Number.isFinite(fetched.getTime())) invalid();
  const observations: ListenBrainzObservation[] = [];
  let missingIdentifiers = 0;
  for (const [index, raw] of payload.recordings.entries()) {
    const row = object(raw);
    if (row.recording_mbid == null || row.recording_mbid === "") {
      missingIdentifiers += 1;
      continue;
    }
    const artistIds = row.artist_mbids ?? [];
    if (!Array.isArray(artistIds) || artistIds.length > CATALOG_SEED_INGESTION_LIMITS.maxArtistIds
      || typeof row.listen_count !== "number" || !Number.isSafeInteger(row.listen_count)
      || row.listen_count < 0) invalid();
    observations.push({
      position: index + 1,
      recordingMbid: mbid(row.recording_mbid),
      title: text(row.track_name),
      artist: text(row.artist_name),
      release: row.release_name == null || row.release_name === "" ? null : text(row.release_name),
      artistMbids: artistIds.map(mbid),
      listenCount: row.listen_count,
    });
  }
  return { from, to, updated, fetched, received: payload.recordings.length, missingIdentifiers, observations };
}

function retryAt(value: string | null): Date {
  const now = Date.now();
  const milliseconds = value && /^\d+$/.test(value) ? Number(value) * 1000
    : value ? Date.parse(value) - now : NaN;
  // An unrepresentable refusal must not become an earlier retry.
  return new Date(milliseconds > 0
    ? Math.min(8_640_000_000_000_000, now + milliseconds) : now + 60_000);
}

async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        abort = () => reject(new CatalogSeedIngestionError("aborted", true));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export async function fetchListenBrainzSnapshot(
  request: typeof fetch,
  callerSignal: AbortSignal,
): Promise<ListenBrainzSnapshot> {
  const signal = AbortSignal.any([
    callerSignal, AbortSignal.timeout(CATALOG_SEED_INGESTION_LIMITS.requestTimeoutMs),
  ]);
  try {
    const response = await abortable(() => request(LISTENBRAINZ_SEED_URL, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "Mint (https://github.com/chickenbone/mint)" },
      redirect: "error", credentials: "omit", signal,
    }), signal);
    if (response.status !== 200) {
      const after = response.status === 204 ? new Date(Date.now() + 3_600_000)
        : retryAt(response.headers.get("retry-after"));
      const failure = new CatalogSeedIngestionError("source_unavailable", true, after);
      try {
        await abortable(async () => { await response.body?.cancel(); },
          AbortSignal.timeout(CATALOG_SEED_INGESTION_LIMITS.cleanupTimeoutMs));
      } catch (cleanupError) {
        throw new AggregateError([failure, cleanupError], "Catalog refusal and cleanup failed.");
      }
      throw failure;
    }
    if (!response.body) invalid();
    if (Number(response.headers.get("content-length")) > CATALOG_SEED_INGESTION_LIMITS.maxBytes) {
      await abortable(() => response.body!.cancel(),
        AbortSignal.timeout(CATALOG_SEED_INGESTION_LIMITS.cleanupTimeoutMs));
      invalid();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await abortable(() => reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > CATALOG_SEED_INGESTION_LIMITS.maxBytes) invalid();
        chunks.push(value);
      }
    } catch (error) {
      try {
        await abortable(() => reader.cancel(),
          AbortSignal.timeout(CATALOG_SEED_INGESTION_LIMITS.cleanupTimeoutMs));
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Catalog source read and cleanup failed.");
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
    signal.throwIfAborted();
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      invalid();
    }
    return parseListenBrainzSnapshot(body);
  } catch (error) {
    if (error instanceof CatalogSeedIngestionError || error instanceof AggregateError) throw error;
    throw new CatalogSeedIngestionError(signal.aborted ? "aborted" : "source_unavailable", true);
  }
}
