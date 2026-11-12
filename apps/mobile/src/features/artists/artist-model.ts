import { normalizeSearchText } from "@mint/client";
import type { CatalogCollectionAlbum, ExternalCatalogItem, MintApi, PlayerCollection, PlayerItem } from "@mint/client";
import { loadCollectionTracks } from "../../components/music/detail-model";

export function artistSelection(id: string): PlayerCollection {
  return { kind: "artist", id };
}

export async function loadArtistDetail(api: Pick<MintApi, "catalog"> | null, id: string, start: number, signal: AbortSignal) {
  if (!api) throw new Error("Sign in to load this music.");
  const [page, albums] = await Promise.all([
    loadCollectionTracks(api, artistSelection(id), start, signal),
    api.catalog({ type: "album", kind: "artist", id, size: 20 }, signal),
  ]);
  return { page, albums };
}

export type ArtistAlbum =
  | { source: "library"; item: PlayerItem }
  | { source: "catalog"; album: CatalogCollectionAlbum };
export type ArtistAlbumEntry = ArtistAlbum | { source: "bridge"; album: ExternalCatalogItem };

function releaseGroupId(id: string) {
  const match = /^mbal_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(id);
  return match?.[1]?.toLowerCase() ?? null;
}

function catalogReleaseGroupId(album: CatalogCollectionAlbum) {
  const routeId = releaseGroupId(album.id);
  const verifiedId = album.verifiedReleaseGroupId?.toLowerCase() ?? null;
  return routeId && verifiedId && routeId !== verifiedId ? null : verifiedId ?? routeId;
}

/** Legacy routes resolve normalized titles, so ambiguous rows cannot identify a distinct release. */
export function mergeArtistAlbums(library: PlayerItem[], catalog: CatalogCollectionAlbum[]): ArtistAlbum[] {
  const albums: ArtistAlbum[] = library.map((item) => ({ source: "library", item }));
  const seen = new Set(library.flatMap((item) => releaseGroupId(item.id) ?? []));
  const libraryRoutes = new Set(library.map((item) => item.id));
  const libraryTitles = new Set(library.map((item) => normalizeSearchText(item.title)).filter(Boolean));
  const routeCounts = new Map<string, number>();
  const legacyTitles = new Map<string, number>();
  for (const album of catalog) {
    routeCounts.set(album.id, (routeCounts.get(album.id) ?? 0) + 1);
    if (album.id.startsWith("al_")) {
      const title = normalizeSearchText(album.title);
      if (title) legacyTitles.set(title, (legacyTitles.get(title) ?? 0) + 1);
    }
  }
  for (const album of catalog) {
    const id = releaseGroupId(album.id);
    if (id && seen.has(id)) continue;
    if (!id && (libraryRoutes.has(album.id) || (routeCounts.get(album.id) ?? 0) > 1)) continue;
    if (album.id.startsWith("al_")) {
      const title = normalizeSearchText(album.title);
      if (!title || libraryTitles.has(title) || (legacyTitles.get(title) ?? 0) > 1) continue;
    }
    if (id) seen.add(id);
    albums.push({ source: "catalog", album });
  }
  return albums;
}

/** Suppress only exact release-group IDs, never matching names or name-derived player IDs. */
export function groupArtistAlbums(albums: ArtistAlbum[], catalog: readonly ExternalCatalogItem[]): ArtistAlbumEntry[] {
  const entries: ArtistAlbumEntry[] = [...albums];
  const seen = new Set(albums.flatMap((entry) =>
    (entry.source === "library" ? releaseGroupId(entry.item.id) : catalogReleaseGroupId(entry.album)) ?? []));
  for (const album of catalog) {
    const id = album.id.toLowerCase();
    if (album.url === `https://musicbrainz.org/release-group/${album.id}`) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    entries.push({ source: "bridge", album });
  }
  return entries;
}
