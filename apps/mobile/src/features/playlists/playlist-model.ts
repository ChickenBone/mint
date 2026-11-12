import type { CollectionDetail, MintApi, PlayerCollection, TrackView } from "@mint/client";
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

/** Mirrors the web Liked Songs import status; progress is 0–1. */
export function likedImportStatus(track: Pick<TrackView, "stage" | "progress"> & Partial<Pick<TrackView, "detail">>) {
  if (track.stage === "failed") return track.detail === "Needs a source" ? "Needs a source" : "Couldn't import";
  if (track.stage === "downloading" && track.progress > 0) return `Importing · ${Math.round(track.progress * 100)}%`;
  if (track.stage === "queued") return "Waiting to import";
  if (track.stage === "matching" || track.stage === "searching") return "Finding a source…";
  return "Importing…";
}

/** Channel, length and views for a reviewable audio source. */
export function sourceChoiceSummary(choice: { channel: string; durationSec: number | null; viewCount: number | null }) {
  const length = choice.durationSec === null ? null : `${Math.floor(choice.durationSec / 60)}:${String(Math.round(choice.durationSec % 60)).padStart(2, "0")}`;
  const views = choice.viewCount === null ? null : `${new Intl.NumberFormat(undefined, { notation: "compact" }).format(choice.viewCount)} views`;
  return [choice.channel, length, views].filter(Boolean).join(" · ");
}
