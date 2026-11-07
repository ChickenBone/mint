import type { TrackView } from "@mint/core/events";
import type { collectionDetail, listCollections } from "./music-store";
export type CollectionList = Awaited<ReturnType<typeof listCollections>>;
export type CollectionDetail = Omit<Awaited<ReturnType<typeof collectionDetail>>, "entries"> & {
  entries: { entryId: string; position: number; track: TrackView }[];
};
export async function musicRequest<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(`/api/music/${path}`, { method, credentials: "same-origin", cache: "no-store",
    headers: data === undefined ? undefined : { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Your music could not load. Try again.");
  return result as T;
}

export async function importLikedSongs(trackIds: string[], request = musicRequest) {
  const unique = [...new Set(trackIds)];
  if (unique.length > 100) throw new Error("Import at most 100 liked songs at a time.");
  for (const id of unique) await request(`likes/${id}`, "PUT");
}
