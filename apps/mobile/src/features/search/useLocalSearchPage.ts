import type { CatalogPage, PlayerItem } from "@mint/client";
import { useCallback, useEffect, useRef, useState } from "react";

type View = {
  keys: readonly unknown[];
  items: PlayerItem[];
  start: number;
  end: number;
  total: number | null;
  next: number | null;
  loading: boolean;
  error: string | null;
  failedStart: number | null;
};
type Inflight = { controller: AbortController; keys: readonly unknown[] };
type LoadPage = (start: number, size: number, signal: AbortSignal) => Promise<CatalogPage>;

const sameKeys = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((key, index) => Object.is(key, right[index]));
const identity = (item: PlayerItem) => `${item.type}:${item.id}`;

function uniquePage(items: PlayerItem[], size: number) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = identity(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, size);
}

/**
 * Keeps one bounded catalog page per result kind. Moving between pages replaces the
 * retained items, while a failed move leaves the current page visible for recovery.
 */
export function useLocalSearchPage(load: LoadPage, size: number, keys: readonly unknown[], enabled: boolean) {
  const [generation, setGeneration] = useState(0);
  const requestKeys = [...keys, size, enabled, generation];
  const [view, setView] = useState<View | null>(null);
  const inflight = useRef<Inflight | null>(null);
  const latest = useRef({ load });
  useEffect(() => { latest.current = { load }; });

  const fetchFrom = useCallback((start: number, owner: readonly unknown[]) => {
    if (inflight.current) return;
    const controller = new AbortController();
    inflight.current = { controller, keys: owner };
    setView((previous) => {
      const current = previous && sameKeys(previous.keys, owner) ? previous : null;
      return {
        keys: owner, items: current?.items ?? [], start: current?.start ?? 0, end: current?.end ?? 0,
        total: current?.total ?? null, next: current?.next ?? null, loading: true, error: null, failedStart: null,
      };
    });
    void Promise.resolve().then(() => latest.current.load(start, size, controller.signal)).then((page) => {
      if (controller.signal.aborted || inflight.current?.controller !== controller) return;
      inflight.current = null;
      const end = page.start + Math.min(page.items.length, size);
      setView({
        keys: owner, items: uniquePage(page.items, size), start: page.start, end, total: page.total,
        next: page.items.length > 0 && end < page.total && end > start ? end : null,
        loading: false, error: null, failedStart: null,
      });
    }).catch((reason: unknown) => {
      if (controller.signal.aborted || inflight.current?.controller !== controller) return;
      inflight.current = null;
      setView((previous) => {
        const current = previous && sameKeys(previous.keys, owner) ? previous : null;
        return {
          keys: owner, items: current?.items ?? [], start: current?.start ?? 0, end: current?.end ?? 0,
          total: current?.total ?? null, next: current?.next ?? null, loading: false,
          error: reason instanceof Error ? reason.message : "Library results could not load. Try again.",
          failedStart: start,
        };
      });
    });
  }, [size]);

  useEffect(() => {
    const owner = requestKeys;
    if (enabled) fetchFrom(0, owner);
    return () => {
      if (inflight.current && sameKeys(inflight.current.keys, owner)) {
        inflight.current.controller.abort();
        inflight.current = null;
      }
    };
    // The keys describe the current API, query and result kind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...keys, size, enabled, generation, fetchFrom]);

  const current = enabled && view && sameKeys(view.keys, requestKeys) ? view : null;
  const loadMore = useCallback(() => {
    if (!current || current.loading || current.error || current.next === null) return;
    fetchFrom(current.next, current.keys);
  }, [current, fetchFrom]);
  const loadPrevious = useCallback(() => {
    if (!current || current.loading || current.error || current.start <= 0) return;
    fetchFrom(Math.max(0, current.start - size), current.keys);
  }, [current, fetchFrom, size]);
  const retry = useCallback(() => {
    if (inflight.current) return;
    if (current?.failedStart !== null && current?.failedStart !== undefined) fetchFrom(current.failedStart, current.keys);
    else setGeneration((value) => value + 1);
  }, [current, fetchFrom]);
  const page = current;
  return {
    items: page?.items ?? [],
    start: page?.start ?? 0,
    end: page?.end ?? 0,
    total: page?.total ?? null,
    next: page?.next ?? null,
    loading: page?.loading ?? enabled,
    error: page?.error ?? null,
    loadMore,
    loadPrevious,
    retry,
  };
}
