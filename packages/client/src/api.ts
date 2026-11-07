import { z } from "zod";
import { trackAnalysisResponseSchema } from "./analysis";
import { connectionErrorMessage, nativeTokenSchema, normalizeServerUrl } from "./auth";
import { catalogPageSchema, queuePageSchema, type QueueEdit, type PlayerCollection } from "./playback";
import {
  browseCategoryPageSchema, chartListSchema, chartPageSchema, collectionDetailSchema, collectionListSchema,
  collectionRecordSchema, discoverySchema, historySchema, type BrowseFacet,
  lyricsResponseSchema, offlineEntitlementSchema, preferencesSchema, recordingSearchItemSchema,
  trackInfoSchema, trackViewSchema, type CollectionMutation, type DiscoveryMode, type HistoryEvent, type IssueReportInput,
} from "./music";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "ApiError"; }
}
export type CatalogFilters = { genre?: string; mood?: string; minYear?: number; maxYear?: number };
export type CatalogQuery = {
  type?: "track" | "album" | "artist" | "playlist"; kind?: PlayerCollection["kind"]; id?: string; q?: string;
  start?: number; size?: number; sort?: "title" | "artist" | "album" | "newest"; filters?: CatalogFilters;
};
export type MediaSource = { uri: string; headers: Record<string, string> };
type ApiOptions = {
  serverUrl: string; token: string; fetch?: typeof fetch; allowDevelopmentHttp?: boolean;
  onUnauthorized?: () => void | Promise<void>;
};
const okSchema = z.object({ ok: z.literal(true) });
export class MintApi {
  readonly serverUrl: string;
  private readonly transport: typeof fetch;
  constructor(private readonly options: ApiOptions) {
    this.serverUrl = normalizeServerUrl(options.serverUrl, options.allowDevelopmentHttp);
    nativeTokenSchema.parse(options.token);
    const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.transport = (input, init) => transport(input, init);
  }
  setUnauthorizedHandler(handler?: () => void | Promise<void>) { this.options.onUnauthorized = handler; }
  async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    if (!/^[a-zA-Z0-9/_-]+(?:\?[^#]*)?$/.test(path)) throw new Error("Invalid consumer API path.");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.options.token}`);
    headers.set("accept", "application/json");
    let response: Response;
    try {
      response = await this.transport(`${this.serverUrl}/api/native/${path}`, {
        ...init, headers, credentials: "omit", cache: "no-store", redirect: "error",
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError(connectionErrorMessage(), 0);
    }
    if (response.status === 401) await this.options.onUnauthorized?.();
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new ApiError("The server returned an unexpected response. Check its address and connection.", response.status);
    }
    const text = await response.text();
    if (text.length > 8_000_000) throw new ApiError("The server response was too large.", response.status);
    let result: unknown;
    try { result = JSON.parse(text); }
    catch { throw new ApiError("The server returned invalid JSON.", response.status); }
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(result);
      throw new ApiError(error.success ? error.data.error : `The request failed (${response.status}).`, response.status);
    }
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new ApiError("The server response is incompatible with this app. Update the app or server.", response.status);
    return parsed.data;
  }
  private json<T>(path: string, schema: z.ZodType<T>, method: string, data: unknown, signal?: AbortSignal) {
    return this.request(path, schema, { method, signal, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  }
  catalog(query: CatalogQuery = {}, signal?: AbortSignal) {
    const { filters, ...rest } = query;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...rest, ...filters })) if (value !== undefined && value !== "") params.set(key, String(value));
    return this.request(`player/catalog?${params}`, catalogPageSchema, { signal });
  }
  browseCategories(facet: BrowseFacet, offset = 0, limit = 24, signal?: AbortSignal) {
    const params = new URLSearchParams({ facet, offset: String(offset), limit: String(limit) });
    return this.request(`browse?${params}`, browseCategoryPageSchema, { signal });
  }
  charts(signal?: AbortSignal) { return this.request("charts", chartListSchema, { signal }); }
  chart(id: string, offset = 0, revision?: string | null, signal?: AbortSignal) {
    const params = new URLSearchParams({ chart: id, offset: String(offset), limit: "25" });
    if (revision) params.set("revision", revision);
    return this.request(`charts?${params}`, chartPageSchema, { signal });
  }
  discover(mode: DiscoveryMode = "for-you", signal?: AbortSignal) {
    return this.request(`music/discover?mode=${mode}`, discoverySchema, { signal });
  }
  collections(signal?: AbortSignal) { return this.request("music/collections", collectionListSchema, { signal }); }
  collection(id: string, signal?: AbortSignal) { return this.request(`music/collections/${id}`, collectionDetailSchema, { signal }); }
  createCollection(input: { title: string; description?: string; trackIds?: string[]; sourcePlaylistId?: string; sourceCollectionId?: string }) {
    return this.json("music/collections", collectionRecordSchema, "POST", input);
  }
  mutateCollection(id: string, input: CollectionMutation) {
    return this.json(`music/collections/${id}`, z.object({ id: z.uuid(), revision: z.number().int().positive() }), "PATCH", input);
  }
  respondInvitation(id: string, accept: boolean) {
    return this.json(`music/collections/${id}/invitation`, okSchema, "POST", { accept });
  }
  organizeCollection(id: string, input: { pinned: boolean; folderId: string | null }) {
    return this.json(`music/collections/${id}/organization`, okSchema, "PATCH", input);
  }
  likes(signal?: AbortSignal) {
    return this.request("music/likes", z.object({ tracks: z.array(z.object({ track: trackViewSchema })) }), { signal });
  }
  setLike(id: string, liked: boolean) { return this.request(`music/likes/${id}`, okSchema, { method: liked ? "PUT" : "DELETE" }); }
  preferences(signal?: AbortSignal) { return this.request("music/preferences", preferencesSchema, { signal }); }
  setPrivateSession(privateSession: boolean) { return this.json("music/preferences", preferencesSchema, "PATCH", { privateSession }); }
  history(signal?: AbortSignal) { return this.request("music/history", historySchema, { signal }); }
  deleteHistory() { return this.request("music/history", okSchema, { method: "DELETE" }); }
  recordHistory(input: HistoryEvent) {
    return this.json("music/history", z.object({ recorded: z.boolean() }), "POST", input);
  }
  reportIssue(input: IssueReportInput) {
    return this.json("issue-reports", z.object({ id: z.uuid(), createdAt: z.string() }), "POST", input);
  }
  searchRecordings(q: string, signal?: AbortSignal) {
    return this.request(`music/search?q=${encodeURIComponent(q)}`, z.object({ items: z.array(recordingSearchItemSchema) }), { signal });
  }
  requestRecording(input: { token: string; youtubeUrl?: string }) {
    return this.json("music/search", z.object({ trackId: z.uuid(), needsQueue: z.boolean(), stage: z.string() }).passthrough(), "POST", input);
  }
  openQueue(input: { collection: PlayerCollection; shuffle: boolean; trackId?: string; occurrenceId?: string }, signal?: AbortSignal) {
    return this.json("player/queue", queuePageSchema, "POST", input, signal);
  }
  queuePage(id: string, position: number, signal?: AbortSignal) {
    return this.request(`player/queue/${id}?position=${position}`, queuePageSchema, { signal });
  }
  editQueue(id: string, input: { revision: number; currentId: string; edit: QueueEdit }, signal?: AbortSignal) {
    return this.json(`player/queue/${id}`, queuePageSchema, "POST", input, signal);
  }
  lyrics(id: string, signal?: AbortSignal) { return this.request(`player/lyrics/${id}`, lyricsResponseSchema, { signal }); }
  trackInfo(id: string, signal?: AbortSignal) { return this.request(`player/info/${id}`, trackInfoSchema, { signal }); }
  trackAnalysis(id: string, signal?: AbortSignal) {
    z.uuid().parse(id);
    return this.request(`player/analysis/${id}`, trackAnalysisResponseSchema, { signal });
  }
  offlineEntitlement(signal?: AbortSignal) { return this.request("player/offline", offlineEntitlementSchema, { signal }); }
  mediaSource(id: string, format: "original" | "mp3" = "original"): MediaSource {
    z.uuid().parse(id);
    return { uri: `${this.serverUrl}/api/native/player/audio/${id}${format === "mp3" ? "?format=mp3" : ""}`,
      headers: { Authorization: `Bearer ${this.options.token}` } };
  }
  artworkUrl(path?: string | null): string | undefined {
    if (!path) return undefined;
    const url = new URL(path, this.serverUrl);
    if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid artwork address.");
    if (url.origin === this.serverUrl && url.pathname.startsWith("/api/artwork/")) return url.href;
    if (url.protocol !== "https:") throw new Error("External artwork must use HTTPS.");
    return url.href;
  }
}
