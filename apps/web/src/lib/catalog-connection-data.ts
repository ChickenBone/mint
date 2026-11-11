import type { CatalogBridgePage } from "@mint/core";
import { signToken } from "@mint/core/crypto";
import { albumPlayerId, externalCatalogPageSchema, type ExternalCatalogPage } from "@mint/client";

export function decodeCatalogLibraryAlbum(id: string): [string, string] | null {
  if (!id.startsWith("al_") || id.length > 12000) return null;
  try {
    const pair: unknown = JSON.parse(Buffer.from(id.slice(3), "base64url").toString("utf8"));
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((value) => typeof value === "string" && value.length <= 1000) ||
      albumPlayerId(pair[0], pair[1]) !== id) return null;
    return [pair[0], pair[1]];
  } catch { return null; }
}

export function catalogPageForListener(page: CatalogBridgePage, userId: string, kind: "artists" | "albums"): ExternalCatalogPage {
  return externalCatalogPageSchema.parse({
    configured: true, nextCursor: page.next_cursor,
    items: page.items.map((item) => ({
      ...item, source: "musicbrainz", playable: false,
      ...(kind === "albums" ? {
        requestToken: signToken("music-request", { userId,
          recording: { id: item.id, title: item.title, artist: item.artist, album: null, durationSec: null } }, 15 * 60_000),
      } : {}),
    })),
  });
}
