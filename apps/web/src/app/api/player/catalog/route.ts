import { z } from "zod";
import { getUser } from "@/lib/auth";
import { CatalogInputError, catalogItems, noteCollectionDemand } from "@/lib/player-catalog";
import { collectionFromParams } from "@/lib/browser-catalog";

export const dynamic = "force-dynamic";
const querySchema = z.object({
  type: z.enum(["track", "album", "artist", "playlist"]).default("track"),
  sort: z.enum(["title", "artist", "album", "newest"]).default("artist"),
  kind: z.enum(["library", "liked", "native-liked", "playlist", "album", "artist", "spotify"]).default("library"),
  id: z.string().optional(), q: z.string().max(100).optional(),
  start: z.coerce.number().int().min(0).max(1_000_000).default(0),
  size: z.coerce.number().int().min(1).max(500).default(100),
});
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });

export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return json({ error: "Approved membership required" }, 401);
  const params = new URL(request.url).searchParams;
  const query = querySchema.safeParse(Object.fromEntries(params));
  if (!query.success) return json({ error: "Invalid catalog request" }, 400);
  const { q, start, size, type, sort } = query.data;
  const collection = collectionFromParams(params);
  if (!collection.success) return json({ error: "Invalid music collection" }, 400);
  try {
    const result = await catalogItems({ start, size, type, sort, q, collection: collection.data, userId: user.id });
    if (start === 0) noteCollectionDemand(collection.data);
    return json(result);
  }
  catch (error) {
    console.error("Music catalog failed", error instanceof Error ? error.message : "Unknown failure");
    return json({ error: error instanceof CatalogInputError ? error.message : "Your music could not load. Check the connection and try again." }, error instanceof CatalogInputError ? 400 : 503);
  }
}
