import type { ExternalCatalogItem, MintApi, PlayerCollection, RecordingSearchItem } from "@mint/client";
import { loadCollectionTracks } from "../../components/music/detail-model";

export function albumSelection(id: string): PlayerCollection {
  return { kind: "album", id };
}

export async function loadAlbumDetail(api: Pick<MintApi, "catalog"> | null, id: string, start: number, signal: AbortSignal) {
  return { page: await loadCollectionTracks(api, albumSelection(id), start, signal) };
}

/** The library-album endpoint filters playable tracks; other catalog rows still need exact-ID deduplication. */
export function visibleBridgeRecordings(
  bridge: readonly ExternalCatalogItem[], collection: readonly RecordingSearchItem[],
) {
  const excluded = new Set(collection.map((item) => item.id.toLowerCase()));
  const seen = new Set<string>();
  return bridge.filter((item) => {
    const id = item.id.toLowerCase();
    if (excluded.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
