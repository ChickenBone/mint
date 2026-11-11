import { z } from "zod";

const mbid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const item = z.object({
  id: mbid, title: z.string().min(1).max(1000), artist: z.string().min(1).max(1000),
  source: z.literal("musicbrainz"), playable: z.literal(false),
  url: z.string().max(200), requestToken: z.string().min(1).max(10000).optional(),
}).refine((value) => ["release-group", "recording"].some((kind) => value.url === `https://musicbrainz.org/${kind}/${value.id}`));
export const externalCatalogPageSchema = z.object({
  configured: z.boolean(), items: z.array(item).max(100), nextCursor: mbid.nullable(),
  identityVerified: z.literal(false).optional(),
}).refine((page) => page.configured && page.identityVerified !== false || !page.items.length && page.nextCursor === null);
export type ExternalCatalogItem = z.infer<typeof item>;
export type ExternalCatalogPage = z.infer<typeof externalCatalogPageSchema>;
