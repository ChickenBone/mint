import { foldCatalogText, searchCatalog, type CatalogEnv, type CatalogItem } from "@mint/core/catalog-client";
import { getDb, schema } from "@mint/core/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { log } from "../log";

export type SearchRequestResolution =
  | { status: "complete"; recordingId: string }
  | { status: "not_found" | "ambiguous"; recordingId: null };

export interface SearchRequestResolveOptions {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  env?: CatalogEnv;
  log?: (message: string, detail: Record<string, unknown>) => void;
}

/** The catalog requires every typed word and songs rarely contain "by", so also search without it. */
function searchTexts(query: string) {
  const parts = /^(.+?)\s+by\s+(.+)$/i.exec(query);
  return parts ? [query, `${parts[1]} ${parts[2]}`] : [query];
}

/**
 * Resolves a saved search to one MusicBrainz recording identity from Mint's metadata catalog, never a live
 * upstream search. An unconfigured or unavailable catalog throws, so an outage is never recorded as "not found".
 */
export async function resolveSearchRequestRecording(
  query: string,
  options: SearchRequestResolveOptions = {},
): Promise<SearchRequestResolution> {
  const cleanQuery = z.string().trim().min(2).max(100).parse(query);
  const candidates = new Map<string, CatalogItem>();
  for (const text of searchTexts(cleanQuery)) {
    const found = await searchCatalog(text, {
      kind: "song", limit: 30, timeoutMs: 5_000, ...options,
      log: options.log ?? ((message, detail) => log.warn(detail, message)),
    });
    if (found.status === "not_configured") throw new Error("The metadata catalog is not configured");
    if (found.status === "unavailable") throw new Error(`The metadata catalog is unavailable (${found.reason})`);
    for (const item of found.items) {
      if (item.matched && item.musicBrainzRecordingId) candidates.set(item.musicBrainzRecordingId, item);
    }
  }
  if (candidates.size === 0) return { status: "not_found", recordingId: null };

  // Only the full title and artist identify a recording; MusicBrainz twins (same title and artist) count once.
  const wanted = foldCatalogText(cleanQuery);
  const identities = new Map<string, string>();
  for (const [recordingId, item] of candidates) {
    const title = foldCatalogText(item.title), artist = foldCatalogText(item.artist);
    if (!artist || ![`${title}${artist}`, `${artist}${title}`, `${title}by${artist}`].includes(wanted)) continue;
    const identity = `${title}\0${artist}`;
    const known = identities.get(identity);
    if (known === undefined || recordingId < known) identities.set(identity, recordingId);
  }
  if (identities.size !== 1) return { status: "ambiguous", recordingId: null };
  return { status: "complete", recordingId: [...identities.values()][0]! };
}

export async function processSearchRequestEnrichment(searchRequestId: string) {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(searchRequestId)) {
    throw new Error("Invalid search-request enrichment job");
  }
  const db = getDb();
  const [request] = await db.update(schema.searchRequests).set({
    enrichmentStatus: "running",
    updatedAt: new Date(),
  }).where(and(
    eq(schema.searchRequests.id, searchRequestId),
    eq(schema.searchRequests.status, "active"),
    sql`${schema.searchRequests.enrichmentStatus} in ('queued', 'running')`,
  )).returning({ query: schema.searchRequests.query });
  if (!request) return;

  try {
    const result = await resolveSearchRequestRecording(request.query);
    await db.update(schema.searchRequests).set({
      enrichmentStatus: result.status,
      musicBrainzRecordingId: result.recordingId,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.searchRequests.id, searchRequestId),
      eq(schema.searchRequests.status, "active"),
      eq(schema.searchRequests.enrichmentStatus, "running"),
    ));
    log.info({ searchRequestId, status: result.status }, "search-request metadata enrichment finished");
  } catch (error) {
    await db.update(schema.searchRequests).set({
      enrichmentStatus: "failed",
      musicBrainzRecordingId: null,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.searchRequests.id, searchRequestId),
      eq(schema.searchRequests.status, "active"),
      eq(schema.searchRequests.enrichmentStatus, "running"),
    ));
    log.warn({ searchRequestId, errorType: error instanceof Error ? error.name : "Unknown" },
      "search-request metadata enrichment failed");
  }
}
