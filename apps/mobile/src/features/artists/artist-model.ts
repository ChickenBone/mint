import type { MintApi, PlayerCollection } from "@mint/client";
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
