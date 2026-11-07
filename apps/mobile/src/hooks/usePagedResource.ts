import { useCallback, useEffect, useRef, useState } from "react";
import { appendPage } from "./paged-model";

export type ResourcePage<T> = { items: T[]; total: number; next: number | null };
type View<T> = {
  keys: readonly unknown[]; items: T[]; next: number | null; total: number | null;
  loading: boolean; error: string | null; status: number | null; failedStart: number | null;
};
type Inflight = { start: number; controller: AbortController; keys: readonly unknown[] };

const sameKeys = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((key, index) => Object.is(key, right[index]));
const errorStatus = (reason: unknown) =>
  typeof reason === "object" && reason && "status" in reason && typeof reason.status === "number" ? reason.status : null;

/**
 * Loads one bounded window at a time. The server's `next` value is the only cursor, so de-duplicated
 * items never shift it. Only one page is in flight per key set: repeated `loadMore` calls are ignored
 * rather than aborting and restarting the same page, and responses for previous keys are discarded.
 */
export function usePagedResource<T>(load: (start: number, signal: AbortSignal) => Promise<ResourcePage<T>>,
  identity: (item: T) => string, keys: readonly unknown[]) {
  const [generation, setGeneration] = useState(0);
  const requestKeys = [...keys, generation];
  const [view, setView] = useState<View<T> | null>(null);
  const inflight = useRef<Inflight | null>(null);
  const latest = useRef({ load, identity });
  useEffect(() => { latest.current = { load, identity }; });

  const fetchFrom = useCallback((start: number, owner: readonly unknown[]) => {
    const controller = new AbortController();
    inflight.current = { start, controller, keys: owner };
    void Promise.resolve().then(() => latest.current.load(start, controller.signal)).then((page) => {
      if (controller.signal.aborted || inflight.current?.controller !== controller) return;
      inflight.current = null;
      setView((previous) => {
        const continuing = previous && sameKeys(previous.keys, owner);
        if (start !== 0 && (!continuing || previous.next !== start)) return previous;
        const items = start === 0 ? appendPage([], 0, page.items, latest.current.identity)
          : appendPage(previous!.items, previous!.items.length, page.items, latest.current.identity);
        const next = page.next !== null && page.next > start ? page.next : null;
        return { keys: owner, items, next, total: page.total, loading: false, error: null, status: null, failedStart: null };
      });
    }).catch((reason: unknown) => {
      if (controller.signal.aborted || inflight.current?.controller !== controller) return;
      inflight.current = null;
      setView((previous) => {
        const base = previous && sameKeys(previous.keys, owner) ? previous
          : { keys: owner, items: [], next: null, total: null, status: null, failedStart: null };
        return { ...base, loading: false, failedStart: start, status: errorStatus(reason),
          error: reason instanceof Error ? reason.message : "Music could not load. Try again." };
      });
    });
  }, []);

  useEffect(() => {
    const owner = requestKeys;
    fetchFrom(0, owner);
    return () => {
      if (inflight.current?.keys === owner) { inflight.current.controller.abort(); inflight.current = null; }
    };
    // Callers provide the stable values that determine their request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...keys, generation, fetchFrom]);

  const current = view && sameKeys(view.keys, requestKeys) ? view : null;
  const loadMore = useCallback(() => {
    if (inflight.current || !current || current.error || current.next === null) return;
    const start = current.next;
    setView((previous) => previous && { ...previous, loading: true });
    fetchFrom(start, current.keys);
  }, [current, fetchFrom]);
  const retry = useCallback(() => {
    if (inflight.current) return;
    if (current?.items.length && current.failedStart !== null) {
      const start = current.failedStart;
      setView((previous) => previous && { ...previous, loading: true, error: null, status: null });
      fetchFrom(start, current.keys);
    } else setGeneration((value) => value + 1);
  }, [current, fetchFrom]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return {
    items: current?.items ?? [], total: current?.total ?? null, next: current?.next ?? null,
    loading: current ? current.loading : true, error: current?.error ?? null, status: current?.status ?? null,
    loadMore, retry, reload,
  };
}
