import { useEffect, useSyncExternalStore } from "react";
import type { MintApi } from "@mint/client";
import { songLikes, type LikeSnapshot } from "./song-likes";

const unavailable: LikeSnapshot = { liked: null, pending: false, error: null };
const noopSubscribe = () => () => {};
export function useSongLike(api: MintApi | null, id?: string, enabled = true) {
  const store = api ? songLikes(api) : null;
  const snapshot = useSyncExternalStore(store?.subscribe ?? noopSubscribe,
    () => id && store ? store.snapshot(id) : unavailable);
  useEffect(() => { if (enabled && id && store) void store.load(id); }, [store, id, enabled]);
  return { ...snapshot, available: !!store && !!id,
    retry: () => { if (id && store) void store.load(id); },
    set: (liked: boolean) => id && store ? store.set(id, liked) : Promise.reject(new Error("Song likes are unavailable without an account connection and song.")),
  };
}

export function useLikesRevision(api: MintApi | null) {
  const store = api ? songLikes(api) : null;
  return useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.revision ?? (() => 0));
}
