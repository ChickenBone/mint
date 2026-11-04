import { catalogPageSchema, collectionSchema, type PlayerCollection, type PlayerItem } from "./player-protocol";

export const metadataFilterKeys = ["artist", "album", "codec", "minYear", "maxYear"] as const;
export function collectionFromParams(params: Pick<URLSearchParams, "get">) {
  const filters = Object.fromEntries(metadataFilterKeys.flatMap((key) => {
    const value = params.get(key);
    return value ? [[key, key === "minYear" || key === "maxYear" ? Number(value) : value]] : [];
  }));
  return collectionSchema.safeParse({ kind: params.get("kind") ?? "library", id: params.get("id"),
    query: params.get("q") || undefined, filters });
}

export function collectionParams(collection: PlayerCollection) {
  const params = new URLSearchParams({ kind: collection.kind });
  if ("id" in collection) params.set("id", collection.id);
  if (collection.kind === "library" && collection.query) params.set("q", collection.query);
  if (collection.kind === "library" && collection.filters) {
    for (const key of metadataFilterKeys) {
      const value = collection.filters[key];
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
  }
  return params;
}

export async function fetchCatalog(params: URLSearchParams, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/player/catalog?${params}`, {
    cache: "no-store", credentials: "same-origin", signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The music catalog could not load.");
  return catalogPageSchema.parse(body);
}

export async function loadCollection(collection: PlayerCollection, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<PlayerItem[]> {
  const params = collectionParams(collection);
  params.set("size", "500");
  const tracks: PlayerItem[] = [], seen = new Set<string>();
  let total: number | undefined;
  do {
    signal.throwIfAborted();
    params.set("start", String(tracks.length));
    const page = await fetchCatalog(params, signal, fetcher);
    if (page.start !== tracks.length || (total !== undefined && page.total !== total) ||
        (!page.items.length && tracks.length < page.total) || page.items.some((track) => track.type !== "track" || seen.has(track.occurrenceId ?? track.id))) {
      throw new Error("The library changed while loading. Select the music again.");
    }
    total = page.total;
    for (const track of page.items) {
      const identity = track.occurrenceId ?? track.id;
      if (!/^[0-9a-f-]{36}$/i.test(track.id) || seen.has(identity)) throw new Error("The catalog returned an invalid or repeated track.");
      seen.add(identity); tracks.push(track);
    }
  } while (tracks.length < total);
  return tracks;
}

export function itemCollection(item: PlayerItem): PlayerCollection {
  if (item.type === "artist" || item.type === "album") return { kind: item.type, id: item.id };
  if (item.type === "playlist") return item.id === "liked" ? { kind: "liked" } : { kind: "playlist", id: item.id };
  if (item.albumId) return { kind: "album", id: item.albumId };
  throw new Error("This track has no album selection. Play it from its library collection.");
}

export function shuffled<T>(items: readonly T[], random = Math.random): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
