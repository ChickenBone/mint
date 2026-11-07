import type { CollectionDetail, MintApi, PlayerCollection } from "@mint/client";
import { loadCollectionTracks } from "../../components/music/detail-model";
import { reorderedEntries } from "./collection-model";

export function playlistSelection(id: string, source?: string): PlayerCollection {
  return id === "liked" ? { kind: "native-liked", id: "" } : { kind: source === "spotify" ? "spotify" : "playlist", id };
}

export async function loadPlaylistDetail(api: Pick<MintApi, "catalog" | "collection"> | null,
  id: string, source: string | undefined, start: number, signal: AbortSignal) {
  if (!api) throw new Error("Sign in to load this music.");
  const [page, metadata] = await Promise.all([
    loadCollectionTracks(api, playlistSelection(id, source), start, signal),
    id !== "liked" && source !== "spotify" ? api.collection(id, signal) : Promise.resolve(null),
  ]);
  return { page, metadata };
}

export function playlistControls(id: string, metadata: CollectionDetail | null | undefined) {
  return { editable: !!metadata && !metadata.rules, copyable: id !== "liked", deletable: metadata?.role === "owner" };
}

export function renamePlaylist(api: Pick<MintApi, "mutateCollection">, id: string, metadata: CollectionDetail, name: string) {
  return api.mutateCollection(id, { action: "update", revision: metadata.revision, title: name.trim() });
}

export function copyPlaylist(api: Pick<MintApi, "createCollection">, id: string, source: string | undefined, title: string) {
  return api.createCollection({ title: `${title.slice(0, 190)} (copy)`,
    ...(source === "spotify" ? { sourcePlaylistId: id } : { sourceCollectionId: id }) });
}

export function deletePlaylist(api: Pick<MintApi, "mutateCollection">, id: string, metadata: CollectionDetail) {
  return api.mutateCollection(id, { action: "delete", revision: metadata.revision });
}

export function movePlaylistEntry(api: Pick<MintApi, "mutateCollection">, id: string,
  metadata: CollectionDetail, entryId: string, direction: -1 | 1) {
  return api.mutateCollection(id, { action: "reorder", revision: metadata.revision,
    entryIds: reorderedEntries(metadata.entries.map((entry) => entry.entryId), entryId, direction) });
}

export function removePlaylistEntry(api: Pick<MintApi, "mutateCollection">, id: string, metadata: CollectionDetail, entryId: string) {
  return api.mutateCollection(id, { action: "remove", revision: metadata.revision, entryId });
}
