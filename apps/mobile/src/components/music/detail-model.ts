import type { MintApi, PlayerCollection } from "@mint/client";

export const detailPageSize = 100;

export async function loadCollectionTracks(api: Pick<MintApi, "catalog"> | null,
  selection: PlayerCollection, start: number, signal: AbortSignal) {
  if (!api) throw new Error("Sign in to load this music.");
  return api.catalog({ type: "track", kind: selection.kind, id: "id" in selection ? selection.id : undefined,
    size: detailPageSize, start }, signal);
}
