import type { MintApi } from "@mint/client";

type LikeApi = Pick<MintApi, "catalog" | "setLike">;
export type LikeSnapshot = { liked: boolean | null; pending: boolean; error: string | null };
const empty: LikeSnapshot = { liked: null, pending: false, error: null };

export function createSongLikes(api: LikeApi) {
  const entries = new Map<string, LikeSnapshot>();
  const requests = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const emit = () => listeners.forEach((listener) => listener());
  const update = (id: string, snapshot: LikeSnapshot) => {
    entries.delete(id); entries.set(id, snapshot);
    if (entries.size > 256) {
      for (const [key, entry] of entries) {
        if (key !== id && !entry.pending) { entries.delete(key); break; }
      }
    }
    emit();
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    revision: () => revision,
    snapshot: (id: string) => entries.get(id) ?? empty,
    load(id: string) {
      if (requests.has(id)) return requests.get(id)!.catch(() => {});
      if (entries.get(id)?.liked !== null && entries.has(id)) return Promise.resolve();
      update(id, { ...empty, pending: true });
      const request = api.catalog({ kind: "native-liked", id, size: 1 }).then((page) => {
        update(id, { liked: page.items.some((item) => item.id === id), pending: false, error: null });
      }).catch((error: unknown) => {
        update(id, { ...empty, error: error instanceof Error ? error.message : "Couldn't load this song's like. Try again." });
      }).finally(() => { requests.delete(id); });
      requests.set(id, request);
      return request;
    },
    set(id: string, liked: boolean) {
      if (requests.has(id)) return Promise.reject(new Error("A song like action is already pending."));
      const before = entries.get(id) ?? empty;
      update(id, { ...before, pending: true, error: null });
      const request = api.setLike(id, liked).then(() => {
        revision++;
        update(id, { liked, pending: false, error: null });
      }).catch((error: unknown) => {
        update(id, { ...before, pending: false, error: error instanceof Error ? error.message : "Couldn't update this song's like. Try again." });
        throw error;
      }).finally(() => { requests.delete(id); });
      requests.set(id, request);
      return request;
    },
  };
}

const stores = new WeakMap<LikeApi, ReturnType<typeof createSongLikes>>();
export function songLikes(api: LikeApi) {
  let store = stores.get(api);
  if (!store) { store = createSongLikes(api); stores.set(api, store); }
  return store;
}
