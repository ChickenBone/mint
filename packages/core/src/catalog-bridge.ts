import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";

export const catalogMbidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const entrySchema = z.object({
  id: catalogMbidSchema,
  title: z.string().trim().min(1).max(1000),
  artist: z.string().trim().min(1).max(1000),
  url: z.string().max(200),
}).strict();
const pageSchema = z.object({
  items: z.array(entrySchema).max(100),
  next_cursor: catalogMbidSchema.nullable(),
}).strict();
export type CatalogBridgePage = z.infer<typeof pageSchema>;
export class CatalogBridgeError extends Error {
  constructor(readonly kind: "configuration" | "unavailable" | "not-found") {
    super(kind === "configuration" ? "The catalog connection configuration is invalid." :
      kind === "not-found" ? "This catalog entry has not been populated yet." : "The catalog connection is unavailable. Try again.");
    this.name = "CatalogBridgeError";
  }
}

export class CatalogBridge {
  readonly stateKey: string;
  private readonly base: URL;
  constructor(url: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    try {
      this.base = new URL(url);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(this.base.hostname);
      if (!(this.base.protocol === "https:" || this.base.protocol === "http:" && loopback) ||
        this.base.username || this.base.password || this.base.search || this.base.hash ||
        this.base.pathname !== "/" || !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error();
    } catch { throw new CatalogBridgeError("configuration"); }
    // Changing the target or credential must not delete another feed's acknowledged IDs.
    this.stateKey = `mint:catalog-priority:${createHash("sha256").update(this.base.href).update("\0").update(token).digest("hex")}`;
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(5000);
    const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await this.fetcher(new URL(path, this.base), {
        ...init, headers: { authorization: `Bearer ${this.token}`, accept: "application/json", "cache-control": "no-store",
          ...(init.body ? { "content-type": "application/json" } : {}) },
        redirect: "error", signal: boundedSignal,
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel();
        throw new CatalogBridgeError(response.status === 404 ? "not-found" : "unavailable");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new CatalogBridgeError("unavailable");
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      boundedSignal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          boundedSignal.throwIfAborted();
          const { done, value } = await reader.read();
          boundedSignal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > 1_000_000) {
            await reader.cancel();
            throw new CatalogBridgeError("unavailable");
          }
          chunks.push(value);
        }
      } finally {
        boundedSignal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof CatalogBridgeError) throw error;
      throw new CatalogBridgeError("unavailable");
    }
  }

  async page(kind: "artists" | "albums", id: string, after: string | null = null, limit = 50, signal?: AbortSignal): Promise<CatalogBridgePage> {
    catalogMbidSchema.parse(id);
    if (after) catalogMbidSchema.parse(after);
    z.number().int().min(1).max(100).parse(limit);
    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set("after", after);
    const entity = kind === "artists" ? "release-group" : "recording";
    const raw = await this.request(`/v1/${kind}/${id}/${kind === "artists" ? "albums" : "recordings"}?${params}`, {}, signal);
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new CatalogBridgeError("unavailable");
    const page = parsed.data;
    if (page.items.length > limit || page.items.some((item, index) =>
      item.url !== `https://musicbrainz.org/${entity}/${item.id}` ||
      item.id <= (index ? page.items[index - 1]!.id : after ?? "")) ||
      page.next_cursor !== null && page.next_cursor !== page.items.at(-1)?.id) throw new CatalogBridgeError("unavailable");
    return page;
  }

  async priority(add: string[], remove: string[]) {
    const ids = [...add, ...remove];
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error("Invalid catalog priority batch.");
    ids.forEach((id) => catalogMbidSchema.parse(id));
    const raw = await this.request("/v1/priority/artists", { method: "POST", body: JSON.stringify({ add, remove }) });
    const result = z.object({ added: z.number().int().min(0).max(add.length), removed: z.number().int().min(0).max(remove.length) }).strict().safeParse(raw);
    if (!result.success) throw new CatalogBridgeError("unavailable");
  }
}

export function configuredCatalogBridge(env: {
  [key: string]: string | undefined;
} = process.env, fetcher: typeof fetch = fetch): CatalogBridge | null {
  const url = env.CATALOG_BRIDGE_URL?.trim() ?? "";
  let token = env.CATALOG_BRIDGE_TOKEN ?? "";
  if (env.CATALOG_BRIDGE_TOKEN_FILE) {
    if (token) throw new CatalogBridgeError("configuration");
    try {
      if (statSync(env.CATALOG_BRIDGE_TOKEN_FILE).size > 1024) throw new Error();
      token = readFileSync(env.CATALOG_BRIDGE_TOKEN_FILE, "utf8").trim();
      if (!token) throw new Error();
    }
    catch { throw new CatalogBridgeError("configuration"); }
  }
  if (!url && !token) return null;
  return new CatalogBridge(url, token, fetcher);
}
