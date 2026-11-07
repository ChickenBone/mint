import { canonicalPublicUrl, getPublicReadCache, PublicProviderBusyError, publicCacheKey, publicRetryAfter,
  type PublicReadCache } from "@mint/core/public-cache";
import { log } from "../log";

export async function boundedMetadataJson(response: Response, maxBytes = 512_000): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Metadata provider returned HTTP ${response.status}`);
  }
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body.cancel();
    throw new Error("Metadata provider response exceeded its size limit");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error("Metadata provider response exceeded its size limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
interface MetadataOptions<T> {
  provider: string;
  validate: (value: unknown) => T;
  cache?: PublicReadCache | null;
  init?: RequestInit;
  negative?: (value: T) => boolean;
  maxBytes?: number;
  freshSeconds?: number;
  request?: typeof fetch;
  notFound?: () => T;
}
const sources: Record<string, { host: string; path: RegExp }> = {
  Wikidata: { host: "www.wikidata.org", path: /^\/w\/api\.php$/ },
  Wikipedia: { host: "en.wikipedia.org", path: /^\/api\/rest_v1\/page\/summary\/[^/]+$/ },
  "ListenBrainz-popularity": { host: "api.listenbrainz.org", path: /^\/1\/popularity\/artist$/ },
  "ListenBrainz-related": { host: "labs.api.listenbrainz.org", path: /^\/similar-artists$/ },
  "CoverArtArchive": { host: "coverartarchive.org", path: /^\/release-group\/[\da-f-]+$/i },
};
/** Allowlisted public metadata reads; the popularity POST is read-only and keyed by its body. */
export async function readPublicMetadata<T>(url: string, options: MetadataOptions<T>): Promise<T> {
  const parsed = new URL(url), source = sources[options.provider];
  if (!source || parsed.protocol !== "https:" || parsed.hostname !== source.host || parsed.port ||
    parsed.username || parsed.password || parsed.hash || !source.path.test(parsed.pathname))
    throw new Error("Unsupported public metadata source");
  const init = options.init ?? {}, headers = new Headers(init.headers);
  if ([...headers.keys()].some((name) => !["accept", "content-type", "user-agent"].includes(name)) ||
    (init.method && init.method !== "GET" && !(options.provider === "ListenBrainz-popularity" && init.method === "POST")))
    throw new Error("Private credentials or mutations cannot use the public metadata cache");
  if (options.provider === "ListenBrainz-popularity") {
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (init.method !== "POST" || !body || typeof body !== "object" || !("artist_mbids" in body) ||
      Object.keys(body).length !== 1 || !Array.isArray(body.artist_mbids) || !body.artist_mbids.length || body.artist_mbids.length > 100 ||
      !body.artist_mbids.every((id) => typeof id === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)))
      throw new Error("Public popularity reads require only validated MusicBrainz artist IDs");
    headers.set("content-type", "application/json");
  } else if (init.body != null) throw new Error("Public metadata GET reads cannot contain a body");
  headers.set("accept", "application/json");
  headers.set("user-agent", "Mint/3.5 (https://github.com/ChickenBone/mint)");
  const request = options.request ?? fetch;
  const load = async (signal: AbortSignal) => {
    const response = await request(url, { ...init, headers, redirect: "error", signal });
    if (response.status === 404 && options.notFound) { await response.body?.cancel(); return options.notFound(); }
    if (response.status === 429 || response.status === 503 || (!response.ok && response.headers.has("retry-after"))) {
      await response.body?.cancel();
      const error = new PublicProviderBusyError(options.provider, publicRetryAfter(response.headers.get("retry-after")));
      error.message = `Metadata provider returned HTTP ${response.status}`;
      throw error;
    }
    const body = await boundedMetadataJson(response, options.maxBytes);
    if (body === null) throw new Error("Invalid public metadata response");
    return options.validate(body);
  };
  if (options.cache === null) return load(AbortSignal.timeout(10_000));
  const result = await (options.cache ?? getPublicReadCache()).read({
    provider: options.provider, key: publicCacheKey(options.provider, "metadata-v1",
      [canonicalPublicUrl(url), init.method ?? "GET", init.body ?? null]),
    freshSeconds: options.freshSeconds ?? 86400, keepSeconds: 7 * 86400, negativeSeconds: 300,
    maxBytes: options.maxBytes ?? 512_000, validate: options.validate, negative: options.negative,
    timeoutMs: 10_000, load,
  });
  if (result.stale) log.warn({ provider: options.provider, ageSeconds: result.ageSeconds }, "Using cached public metadata while refresh is unavailable");
  return result.value;
}
