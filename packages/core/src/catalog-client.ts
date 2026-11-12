import { z } from "zod";

/**
 * Server-side client for Mint's separate metadata catalog (`services/catalog`).
 * Browsers and the native app never call the catalog; Mint's own API does, so catalog rows never
 * create tracks, ownership or acquisition work and an outage never blocks the local library.
 * Reads are allowlisted, including read-only recording reconciliation (a POST that never writes); the only write is
 * anonymous, best-effort crawl demand (`noteCatalogDemand`).
 */
export const CATALOG_URL_ENV = "MINT_CATALOG_URL";
export const CATALOG_DEMAND_TOKEN_ENV = "CATALOG_DEMAND_TOKEN";
export const catalogKinds = ["artist", "album", "song"] as const;
export type CatalogKind = (typeof catalogKinds)[number];
export type CatalogFailure = "misconfigured" | "timeout" | "unreachable" | "busy" | "invalid-response";
export type CatalogEnv = Readonly<Record<string, string | undefined>>;

const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 2_500;
const MAX_DURATION_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CatalogRequestOptions {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  env?: CatalogEnv;
  timeoutMs?: number;
  log?: (message: string, detail: Record<string, unknown>) => void;
}
export interface CatalogSearchOptions extends CatalogRequestOptions {
  limit?: number;
  kind?: CatalogKind;
}

export interface CatalogEntity {
  key: string;
  source: string;
  origin: string;
  country: string;
  kind: CatalogKind;
  providerId: string;
  title: string;
  /** Empty when the source has no artist credit. */
  artist: string;
  album: string | null;
  genres: string[];
  url: string | null;
  /** Catalog graph score. Null means unknown, never zero plays. */
  popularity: number | null;
  observedAt: string | null;
  updatedAt: string | null;
  /** Set only for a MusicBrainz recording, the one identity Mint can request audio for. */
  musicBrainzRecordingId: string | null;
}
export interface CatalogItem extends CatalogEntity {
  /** Every query word starts a word of the title or artist; false rows are semantic neighbours. */
  matched: boolean;
}
export type CatalogRelevance = "matched" | "related-only" | "empty";
export type CatalogUnavailable = { status: "unavailable"; reason: CatalogFailure; retryAfterSeconds: number | null };
export type CatalogNotConfigured = { status: "not_configured" };
export type CatalogSearch =
  | CatalogNotConfigured
  | CatalogUnavailable
  | {
    /** `lexical-only` means the semantic index was down, so spelling and alias tolerance is reduced. */
    status: "ok" | "lexical-only";
    mode: "hybrid" | "lexical";
    query: string;
    hasMore: boolean;
    relevance: CatalogRelevance;
    items: CatalogItem[];
  };
export type CatalogLookup =
  | CatalogNotConfigured
  | CatalogUnavailable
  | { status: "not_found" }
  | { status: "ok"; entity: CatalogEntity; durationSec: number | null; artistKeys: string[]; albumKeys: string[];
    /** Songs that list this album; empty for other kinds. Bounded by the service's edge cap. */
    songKeys: string[] };

export function catalogOrigin(value: string): URL {
  const invalid = new Error(`${CATALOG_URL_ENV} must be an HTTP(S) origin without credentials, paths or query parameters.`);
  let url: URL;
  try { url = new URL(value); } catch { throw invalid; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash) throw invalid;
  return url;
}
/** Null means no catalog is configured; an invalid value throws so deployments fail loudly. */
export function configuredCatalogOrigin(env: CatalogEnv = process.env): URL | null {
  const value = env[CATALOG_URL_ENV]?.trim();
  return value ? catalogOrigin(value) : null;
}

export function catalogTokens(value: string): string[] {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
}
/** Accent, case and punctuation-insensitive identity text, for exact title and artist comparison. */
export const foldCatalogText = (value: string) => catalogTokens(value).join("");
/** Accent-tolerant, order-independent word-prefix containment across the given fields. */
export function catalogTextMatches(query: string, ...fields: string[]): boolean {
  const wanted = catalogTokens(query);
  if (!wanted.length) return false;
  const words = catalogTokens(fields.join(" "));
  return wanted.every((token) => words.some((word) => word === token || (token.length > 1 && word.startsWith(token))));
}

const timestamp = z.string().max(64).nullish();
const entitySchema = z.object({
  key: z.string().min(1).max(150),
  source: z.string().min(1).max(50),
  origin: z.string().max(100).nullish(),
  country: z.string().max(10).nullish(),
  kind: z.enum(catalogKinds),
  provider_id: z.string().min(1).max(300),
  title: z.string().max(1000),
  artist: z.string().max(1000).nullish(),
  album: z.string().max(1000).nullish(),
  genres: z.array(z.string().max(100)).max(50).nullish(),
  url: z.string().max(2048).nullish(),
  popularity: z.number().finite().nullish(),
  observed_at: timestamp,
  updated_at: timestamp,
});
const searchSchema = z.object({
  mode: z.enum(["hybrid", "lexical"]),
  has_more: z.boolean().optional(),
  results: z.array(z.unknown()).max(50),
});
const lookupSchema = z.object({
  entity: z.unknown(),
  annotations: z.record(z.string(), z.unknown()).nullish(),
  edges: z.array(z.unknown()).max(101).nullish(),
});
const edgeSchema = z.object({ source: z.string().max(150), target: z.string().min(1).max(150), relation: z.string().max(50) });

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
function isoOrNull(value: string | null | undefined) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function httpUrlOrNull(value: string | null | undefined) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
}
function toEntity(raw: z.infer<typeof entitySchema>): CatalogEntity | null {
  const title = clean(raw.title);
  if (!title) return null;
  const musicBrainz = raw.source === "musicbrainz" && raw.kind === "song" && UUID.test(raw.provider_id);
  return {
    key: raw.key, source: raw.source, origin: raw.origin ?? raw.source, country: raw.country ?? "global", kind: raw.kind,
    providerId: raw.provider_id, title, artist: clean(raw.artist), album: clean(raw.album) || null,
    genres: (raw.genres ?? []).map(clean).filter(Boolean), url: httpUrlOrNull(raw.url),
    popularity: raw.popularity && raw.popularity > 0 ? raw.popularity : null,
    observedAt: isoOrNull(raw.observed_at), updatedAt: isoOrNull(raw.updated_at),
    musicBrainzRecordingId: musicBrainz ? raw.provider_id.toLowerCase() : null,
  };
}

class CatalogFailureError extends Error {
  constructor(readonly reason: CatalogFailure, readonly retryAfterSeconds: number | null = null,
    readonly lexicalMayWork = false) { super(reason); }
}

const lastLogged = new Map<string, number>();
function report(options: CatalogRequestOptions, message: string, detail: Record<string, unknown>) {
  if (options.log) return options.log(message, detail);
  const key = `${message}:${String(detail.reason ?? "")}`, now = Date.now();
  if (now - (lastLogged.get(key) ?? 0) < 30_000) return;
  lastLogged.set(key, now);
  console.error(message, detail);
}
function retryAfter(headers: Headers) {
  const seconds = Number(headers.get("retry-after"));
  return Number.isInteger(seconds) && seconds >= 1 ? Math.min(seconds, 60) : null;
}

async function readBounded(response: Response, signal: AbortSignal, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new CatalogFailureError("invalid-response");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        throw new CatalogFailureError("invalid-response");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Core compiles without the DOM lib, where RequestInit has no `cache`; Next.js still honours it.
type CatalogFetchInit = RequestInit & { cache: "no-store" };

/** Allowlisted catalog read. Returns undefined only for a 404 the caller said it expects. `query` is a read-only POST body. */
async function getJson(url: URL, options: CatalogRequestOptions, expectNotFound = false, query?: unknown): Promise<unknown> {
  const caller = options.signal;
  const signal = AbortSignal.any([...(caller ? [caller] : []), AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)]);
  try {
    const init: CatalogFetchInit = query === undefined
      ? { headers: { accept: "application/json" }, redirect: "error", cache: "no-store", signal }
      : { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(query),
        redirect: "error", cache: "no-store", signal };
    const response = await (options.fetcher ?? fetch)(url, init);
    if (response.status === 404 && expectNotFound) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    if (!response.ok) {
      const detail = await readBounded(response, signal, 4_096).catch(() => "");
      if (response.status === 503) {
        // Capacity limits apply to lexical searches too, so only a dependency outage may degrade to lexical.
        throw new CatalogFailureError("busy", retryAfter(response.headers), !/capacity/i.test(detail));
      }
      throw new CatalogFailureError([400, 403, 404, 422].includes(response.status) ? "misconfigured" : "unreachable");
    }
    try { return JSON.parse(await readBounded(response, signal, MAX_RESPONSE_BYTES)); }
    catch (error) {
      if (error instanceof SyntaxError) throw new CatalogFailureError("invalid-response");
      throw error;
    }
  } catch (error) {
    caller?.throwIfAborted();
    if (error instanceof CatalogFailureError) throw error;
    throw new CatalogFailureError(signal.aborted ? "timeout" : "unreachable");
  }
}

function endpoint(options: CatalogRequestOptions): URL | CatalogNotConfigured | CatalogUnavailable {
  try {
    return configuredCatalogOrigin(options.env ?? process.env) ?? { status: "not_configured" };
  } catch (error) {
    report(options, "Metadata catalog is misconfigured", { reason: "misconfigured", error: (error as Error).message });
    return { status: "unavailable", reason: "misconfigured", retryAfterSeconds: null };
  }
}
function unavailable(error: unknown, options: CatalogRequestOptions): CatalogUnavailable {
  if (error instanceof CatalogFailureError) {
    report(options, "Metadata catalog unavailable", { reason: error.reason });
    return { status: "unavailable", reason: error.reason, retryAfterSeconds: error.retryAfterSeconds };
  }
  if (error instanceof z.ZodError) {
    report(options, "Metadata catalog returned an unexpected response", { reason: "invalid-response" });
    return { status: "unavailable", reason: "invalid-response", retryAfterSeconds: null };
  }
  throw error;
}

/**
 * Hybrid search never returns an empty list because semantic neighbours always exist, so relevance is
 * decided here: `matched` rows contain every query word, the rest are labelled neighbours.
 */
export async function searchCatalog(query: string, options: CatalogSearchOptions = {}): Promise<CatalogSearch> {
  const text = query.replace(/\s+/g, " ").trim();
  if (!text || text.length > 256) throw new RangeError("Catalog queries must contain 1 to 256 characters.");
  options.signal?.throwIfAborted();
  const base = endpoint(options);
  if (!(base instanceof URL)) return base;
  const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)));
  const attempt = async (mode: "hybrid" | "lexical") => {
    const url = new URL("/v1/search", base);
    url.searchParams.set("q", text);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("mode", mode);
    if (options.kind) {
      url.searchParams.set("kind", options.kind);
      // Songs and albums are not artist identities, so never collapse them into one result.
      if (options.kind !== "artist") url.searchParams.set("group_artists", "false");
    }
    return searchSchema.parse(await getJson(url, options));
  };
  try {
    let body: z.infer<typeof searchSchema>;
    try { body = await attempt("hybrid"); }
    catch (error) {
      if (!(error instanceof CatalogFailureError) || !error.lexicalMayWork) throw error;
      body = await attempt("lexical");
    }
    const parsed = body.results.map((row) => entitySchema.safeParse(row));
    const entities = parsed.flatMap((row) => row.success ? toEntity(row.data) ?? [] : []);
    if (body.results.length && !entities.length) throw new CatalogFailureError("invalid-response");
    if (entities.length < body.results.length) {
      report(options, "Metadata catalog rows were skipped", { reason: "invalid-row", skipped: body.results.length - entities.length });
    }
    const rows = entities.map((entity) => ({ ...entity, matched: catalogTextMatches(text, entity.title, entity.artist) }));
    const items = [...rows.filter((row) => row.matched), ...rows.filter((row) => !row.matched)];
    return {
      status: body.mode === "hybrid" ? "ok" : "lexical-only", mode: body.mode, query: text,
      hasMore: body.has_more ?? false, items,
      relevance: !items.length ? "empty" : items[0]!.matched ? "matched" : "related-only",
    };
  } catch (error) {
    return unavailable(error, options);
  }
}

/** One entity by catalog key, for optional detail such as duration. Duration is absent for crawled rows. */
export async function lookupCatalogEntity(key: string, options: CatalogRequestOptions = {}): Promise<CatalogLookup> {
  if (!key || key.length > 150 || /[\s/?#]/.test(key)) throw new RangeError("Invalid catalog key.");
  options.signal?.throwIfAborted();
  const base = endpoint(options);
  if (!(base instanceof URL)) return base;
  try {
    const raw = await getJson(new URL(`/v1/entities/${encodeURIComponent(key)}`, base), options, true);
    if (raw === undefined) return { status: "not_found" };
    const body = lookupSchema.parse(raw);
    const entity = toEntity(entitySchema.parse(body.entity));
    if (!entity) throw new CatalogFailureError("invalid-response");
    const duration = body.annotations?.duration_ms;
    const outgoing = (relation: string) => [...new Set((body.edges ?? []).flatMap((raw) => {
      const edge = edgeSchema.safeParse(raw);
      return edge.success && edge.data.source === entity.key && edge.data.relation === relation ? [edge.data.target] : [];
    }))].sort();
    const incoming = (relation: string) => [...new Set((body.edges ?? []).flatMap((raw) => {
      const edge = edgeSchema.safeParse(raw);
      return edge.success && edge.data.target === entity.key && edge.data.relation === relation ? [edge.data.source] : [];
    }))].sort();
    return {
      status: "ok", entity,
      durationSec: typeof duration === "number" && Number.isInteger(duration) && duration > 0 && duration <= MAX_DURATION_MS
        ? Math.round(duration / 1000) || null : null,
      artistKeys: outgoing("artist"), albumKeys: outgoing("album"),
      songKeys: entity.kind === "album" ? incoming("album") : [],
    };
  } catch (error) {
    return unavailable(error, options);
  }
}

export interface CatalogRecordingCandidate {
  key: string; source: string; providerId: string; title: string; artist: string; album: string | null;
  durationSec: number | null; conflicts: string[]; explicit: boolean;
}
export type CatalogReconcile = { status: "ok"; candidates: CatalogRecordingCandidate[] } | CatalogNotConfigured | CatalogUnavailable;

const reconcileSchema = z.object({
  candidates: z.array(z.unknown()).max(50).default([]),
});
const reconcileCandidateSchema = z.object({
  key: z.string().min(1).max(200), source: z.string().min(1).max(40), provider_id: z.string().min(1).max(200),
  title: z.string().max(500), artist: z.string().max(500), album: z.string().max(500).nullable().optional(),
  duration_ms: z.number().nullable().optional(), conflicts: z.array(z.string().max(60)).max(20).default([]),
  match_type: z.string().max(40),
});

/** Read-only `POST /v1/reconcile/recordings`: provider rows (including YouTube Music video IDs) for one recording. */
export async function reconcileCatalogRecording(query: { title: string; artist: string; album?: string | null;
  durationSec?: number | null; musicbrainzRecordingId?: string | null }, options: CatalogRequestOptions = {}): Promise<CatalogReconcile> {
  options.signal?.throwIfAborted();
  const base = endpoint(options);
  if (!(base instanceof URL)) return base;
  const durationMs = query.durationSec && Number.isFinite(query.durationSec) && query.durationSec > 0
    ? Math.min(MAX_DURATION_MS, Math.round(query.durationSec * 1000)) : null;
  const references = query.musicbrainzRecordingId && UUID.test(query.musicbrainzRecordingId)
    ? [{ source: "musicbrainz", identifier: query.musicbrainzRecordingId }] : [];
  try {
    const body = reconcileSchema.parse(await getJson(new URL("/v1/reconcile/recordings", base), options, false, {
      title: query.title.slice(0, 500), artist: query.artist.slice(0, 500), album: (query.album ?? "").slice(0, 500),
      duration_ms: durationMs, references,
    }));
    const candidates = body.candidates.flatMap((raw) => {
      const row = reconcileCandidateSchema.safeParse(raw);
      if (!row.success) return [];
      const duration = row.data.duration_ms;
      return [{
        key: row.data.key, source: row.data.source, providerId: row.data.provider_id, title: row.data.title,
        artist: row.data.artist, album: row.data.album ?? null, conflicts: row.data.conflicts,
        durationSec: typeof duration === "number" && Number.isInteger(duration) && duration > 0 && duration <= MAX_DURATION_MS
          ? Math.round(duration / 1000) || null : null,
        explicit: row.data.match_type === "explicit_identifier",
      }];
    });
    return { status: "ok", candidates };
  } catch (error) {
    return unavailable(error, options);
  }
}

export type CatalogDemand =
  | { type: "search"; query: string }
  | { type: "artist"; artist: string }
  | { type: "album"; title: string; artist?: string | null }
  | { type: "play"; title: string; artist?: string | null; count?: number };
export interface CatalogDemandOptions extends Omit<CatalogRequestOptions, "signal"> {
  delayMs?: number;
  now?: () => number;
}

const DEMAND_BATCH = 50;
const DEMAND_PENDING = 500;
const DEMAND_REPEAT_MS = 10 * 60_000;
const demandText = (value: string | null | undefined) => clean(value).slice(0, 200);

function normalizeDemand(signal: CatalogDemand): CatalogDemand | null {
  if (signal.type === "search") {
    const query = demandText(signal.query);
    return query.length >= 2 ? { type: "search", query } : null;
  }
  if (signal.type === "artist") {
    const artist = demandText(signal.artist);
    return artist ? { type: "artist", artist } : null;
  }
  const title = demandText(signal.title), artist = demandText(signal.artist) || null;
  if (!title) return null;
  if (signal.type === "album") return { type: "album", title, artist };
  const count = Math.min(1_000_000, Math.max(1, Math.trunc(signal.count ?? 1)));
  return { type: "play", title, artist, count };
}
function demandKey(signal: CatalogDemand) {
  if (signal.type === "search") return `search:${foldCatalogText(signal.query)}`;
  if (signal.type === "artist") return `artist:${foldCatalogText(signal.artist)}`;
  return `${signal.type}:${foldCatalogText(signal.title)}:${foldCatalogText(signal.artist ?? "")}`;
}
function wireDemand(signal: CatalogDemand) {
  if (signal.type === "artist") return { type: "artist", artist: signal.artist };
  if (signal.type === "search") return signal;
  return { ...signal, artist: signal.artist || undefined };
}

/**
 * Batches anonymous listener demand (searches, artist/album views and play counts) into bounded
 * `POST /v1/demand` hints that only reprioritise catalog crawling. Never throws, never blocks a
 * request and sends no user, device or session identity. Disabled unless the URL and token are set.
 */
export function createCatalogDemandQueue(options: CatalogDemandOptions = {}) {
  const pending = new Map<string, CatalogDemand>();
  const recent = new Map<string, number>();
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<number> | null = null;

  const configured = () => {
    const env = options.env ?? process.env;
    const token = env[CATALOG_DEMAND_TOKEN_ENV]?.trim();
    if (!token) return null;
    const base = endpoint(options);
    if (!(base instanceof URL)) return null;
    if (!/^[\x21-\x7e]{32,256}$/.test(token)) {
      report(options, "Metadata catalog demand token is misconfigured", { reason: "misconfigured" });
      return null;
    }
    return { base, token };
  };

  const take = () => {
    // Typeahead sends every prefix; a pending longer query supersedes its prefixes.
    const searches = [...pending.values()].flatMap((signal) => signal.type === "search" ? [foldCatalogText(signal.query)] : []);
    for (const [key, signal] of pending) {
      const folded = signal.type === "search" ? foldCatalogText(signal.query) : null;
      if (folded !== null && searches.some((other) => other.length > folded.length && other.startsWith(folded))) pending.delete(key);
    }
    const batch = [...pending.entries()].slice(0, DEMAND_BATCH);
    for (const [key] of batch) pending.delete(key);
    return batch.map(([, signal]) => signal);
  };

  async function send(target: { base: URL; token: string }, batch: CatalogDemand[]) {
    const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const init: CatalogFetchInit = {
        method: "POST", redirect: "error", cache: "no-store", signal,
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${target.token}` },
        body: JSON.stringify({ signals: batch.map(wireDemand) }),
      };
      const response = await (options.fetcher ?? fetch)(new URL("/v1/demand", target.base), init);
      await response.body?.cancel().catch(() => {});
      if (!response.ok) report(options, "Metadata catalog rejected demand hints", { reason: response.status });
      return response.ok ? batch.length : 0;
    } catch {
      report(options, "Metadata catalog demand hints failed", { reason: signal.aborted ? "timeout" : "unreachable" });
      return 0;
    }
  }

  async function flush(): Promise<number> {
    if (timer) { clearTimeout(timer); timer = null; }
    if (flushing) await flushing.catch(() => 0);
    const target = configured();
    if (!target) { pending.clear(); return 0; }
    const run = (async () => {
      let sent = 0;
      while (pending.size) sent += await send(target, take());
      return sent;
    })();
    flushing = run;
    try { return await run; } finally { if (flushing === run) flushing = null; }
  }

  function note(input: CatalogDemand) {
    try {
      const signal = normalizeDemand(input);
      if (!signal || !configured()) return;
      const key = demandKey(signal), at = now();
      const existing = pending.get(key);
      if (existing?.type === "play" && signal.type === "play") {
        existing.count = Math.min(1_000_000, (existing.count ?? 1) + (signal.count ?? 1));
        return;
      }
      if (signal.type !== "play" && at - (recent.get(key) ?? -Infinity) < DEMAND_REPEAT_MS) return;
      if (existing || pending.size >= DEMAND_PENDING) return;
      pending.set(key, signal);
      if (signal.type !== "play") recent.set(key, at);
      if (recent.size > 5_000) {
        for (const [old, seen] of recent) if (at - seen >= DEMAND_REPEAT_MS || recent.size > 5_000) recent.delete(old);
      }
      if (!timer) {
        timer = setTimeout(() => { timer = null; void flush(); }, options.delayMs ?? 2_000);
        (timer as { unref?: () => void }).unref?.();
      }
    } catch (error) {
      report(options, "Metadata catalog demand hint was dropped", { reason: (error as Error).message });
    }
  }

  return { note, flush, get size() { return pending.size; } };
}

let defaultDemand: ReturnType<typeof createCatalogDemandQueue> | null = null;
export function noteCatalogDemand(signal: CatalogDemand) {
  (defaultDemand ??= createCatalogDemandQueue()).note(signal);
}
