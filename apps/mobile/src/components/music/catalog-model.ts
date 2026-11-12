import type { CatalogCollectionAlbum, PlayerItem, RecordingSearchItem } from "@mint/client";

export type CatalogRequest = { trackId: string; stage: string; liked: boolean };

export const finishedImportStages = new Set(["ready", "analyzing", "failed"]);

export function catalogRequestLabel(recording: Pick<RecordingSearchItem, "existing">, state?: CatalogRequest) {
  const stage = recording.existing?.stage ?? state?.stage;
  if (!stage) return "Not in your library";
  if (stage === "failed") return "Couldn't import · Try again";
  if (stage === "ready" || stage === "analyzing") return state?.liked ? "Liked · Ready to play" : "Ready to play";
  return state?.liked ? "Liked · Importing…" : "Importing…";
}

/** Albums the catalog correlated with the page's not-imported songs, in first-seen order, for filter chips. */
export function catalogSongAlbums(items: Pick<RecordingSearchItem, "album">[], limit = 20) {
  return [...new Set(items.map((item) => item.album).filter((album): album is string => !!album))].slice(0, limit);
}

export function filterCatalogSongs<T extends Pick<RecordingSearchItem, "album">>(items: T[], album: string | null) {
  return album ? items.filter((item) => item.album === album) : items;
}

/** Catalog albums rendered as album cards that open the album page, where their songs can be liked or imported. */
export function catalogAlbumItems(albums: CatalogCollectionAlbum[]): PlayerItem[] {
  return albums.map((album) => ({ type: "album", id: album.id, title: album.title, artist: "Not imported yet" }));
}
