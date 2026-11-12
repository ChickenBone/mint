import { configuredCatalogBridge, CatalogBridgeError, catalogMbidSchema } from "@mint/core";
import { getDb } from "@mint/core/db";
import { PLAYABLE } from "@mint/core/playback";
import { sql } from "drizzle-orm";
import { getUser } from "./auth";
import { rateLimit } from "./rate-limit";
import { z } from "zod";
import type { ExternalCatalogPage } from "@mint/client";
import { catalogPageForListener, decodeCatalogLibraryAlbum } from "./catalog-connection-data";

const querySchema = z.object({
  after: catalogMbidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export async function catalogConnectionResponse(request: Request, path: string[]) {
  const user = await getUser();
  if (!user) return Response.json({ error: "Approved membership required." }, { status: 401 });
  const kind = path[1];
  if (path.length !== 4 || !(kind === "artists" && path[3] === "albums" || (kind === "albums" || kind === "library-albums") && path[3] === "recordings")) {
    return Response.json({ error: "Catalog route not found." }, { status: 404 });
  }
  const localAlbum = kind === "library-albums" ? decodeCatalogLibraryAlbum(path[2] ?? "") : null;
  const id = catalogMbidSchema.safeParse(path[2]);
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!(kind === "library-albums" ? localAlbum : id.success) || !query.success) return Response.json({ error: "Invalid catalog page." }, { status: 400 });
  try {
    const bridge = configuredCatalogBridge();
    if (!bridge) return Response.json({ configured: false, items: [], nextCursor: null } satisfies ExternalCatalogPage);
    if (!await rateLimit(`catalog-connection:${user.id}`, 30, 60)) return Response.json({ error: "Wait before loading another catalog page." }, { status: 429 });
    let parentId = id.success ? id.data : null;
    if (localAlbum) {
      const { rows } = await getDb().execute<{ id: string }>(sql`
        select distinct lower(mb_release_group_id) as id from tracks
        where artist = ${localAlbum[0]} and coalesce(album, '') = ${localAlbum[1]}
          and ${PLAYABLE} and mb_release_group_id is not null
        order by id limit 2`);
      if (rows.length !== 1 || !catalogMbidSchema.safeParse(rows[0]?.id).success) {
        return Response.json({ configured: true, identityVerified: false, items: [], nextCursor: null } satisfies ExternalCatalogPage);
      }
      parentId = rows[0]!.id;
    }
    if (!parentId) return Response.json({ error: "Invalid catalog identity." }, { status: 400 });
    const page = await bridge.page(kind === "artists" ? "artists" : "albums", parentId, query.data.after ?? null, query.data.limit, request.signal);
    let items = page.items;
    if (localAlbum && items.length) {
      request.signal.throwIfAborted();
      const { rows } = await getDb().execute<{ id: string }>(sql`
        select distinct lower(mb_recording_id) as id from tracks
        where artist = ${localAlbum[0]} and coalesce(album, '') = ${localAlbum[1]}
          and ${PLAYABLE} and lower(mb_recording_id) in (${sql.join(items.map((item) => sql`${item.id}`), sql`, `)})
        limit ${items.length}`);
      request.signal.throwIfAborted();
      const owned = new Set(rows.map((row) => row.id));
      items = items.filter((item) => !owned.has(item.id));
    }
    return Response.json(catalogPageForListener({ ...page, items }, user.id, kind === "artists" ? "artists" : "albums"));
  } catch (error) {
    if (request.signal.aborted) return Response.json({ error: "Catalog request cancelled." }, { status: 499 });
    console.error("[catalog-connection] metadata unavailable");
    const status = error instanceof CatalogBridgeError && error.kind === "not-found" ? 404 : 503;
    return Response.json({ error: error instanceof CatalogBridgeError ? error.message : "The catalog connection is unavailable. Try again." }, { status });
  }
}
