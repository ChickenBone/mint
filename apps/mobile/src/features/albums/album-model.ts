import type { MintApi, PlayerCollection } from "@mint/client";
import { loadCollectionTracks } from "../../components/music/detail-model";

export function albumSelection(id: string): PlayerCollection {
  return { kind: "album", id };
}

export async function loadAlbumDetail(api: Pick<MintApi, "catalog"> | null, id: string, start: number, signal: AbortSignal) {
  return { page: await loadCollectionTracks(api, albumSelection(id), start, signal) };
}
