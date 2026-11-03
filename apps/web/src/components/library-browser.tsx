"use client";

import type { TrackView } from "@mint/core/events";
import { Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { TrackList } from "./track-list";
import { CollectionActions } from "./app/collection-actions";

interface Page {
  tracks: TrackView[];
  nextCursor: string | null;
}

/** Search + infinite scroll over the public library via /api/library. */
export function LibraryBrowser({ initial, initialQuery = "" }: { initial: Page; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [page, setPage] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [loadedQuery, setLoadedQuery] = useState(initialQuery);
  const [retry, setRetry] = useState(0);
  const pending = q !== loadedQuery;
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);

  const fetchPage = useCallback(async (query: string, cursor: string | null, signal: AbortSignal) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`/api/library?${params}`, { signal });
    if (!res.ok) throw new Error(res.status === 429 ? "Searching too fast. Wait a moment." : "Couldn't load the library. Try again.");
    return (await res.json()) as Page;
  }, []);

  useEffect(() => {
    const generation = ++sequence.current;
    const controller = new AbortController();
    if (q === initialQuery && generation === 1 && !retry) return;
    const id = setTimeout(() => {
      void (async () => {
        try {
          setError(null);
          const result = await fetchPage(q, null, controller.signal);
          if (controller.signal.aborted || generation !== sequence.current) return;
          setLoadingMore(false);
          setPage(result);
          setLoadedQuery(q);
          const url = new URL(window.location.href);
          if (q) url.searchParams.set("q", q);
          else url.searchParams.delete("q");
          window.history.replaceState(null, "", url);
        } catch (e) {
          if (!controller.signal.aborted && generation === sequence.current) setError((e as Error).message);
        }
      })();
    }, 250);
    return () => { clearTimeout(id); controller.abort(); };
  }, [q, fetchPage, initialQuery, retry]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !page.nextCursor || pending || error) return;
    const controller = new AbortController(), generation = sequence.current;
    let loading = false;
    const io = new IntersectionObserver(async ([entry]) => {
      if (!entry?.isIntersecting || loading) return;
      loading = true;
      setLoadingMore(true);
      try {
        const more = await fetchPage(q, page.nextCursor, controller.signal);
        if (controller.signal.aborted || generation !== sequence.current) return;
        setPage((p) => ({ tracks: [...p.tracks, ...more.tracks], nextCursor: more.nextCursor }));
      } catch (e) {
        if (!controller.signal.aborted && generation === sequence.current) setError((e as Error).message);
      } finally {
        loading = false;
        if (!controller.signal.aborted) setLoadingMore(false);
      }
    }, { rootMargin: "400px" });
    io.observe(el);
    return () => { io.disconnect(); controller.abort(); };
  }, [page.nextCursor, q, fetchPage, pending, error]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
      <label className="relative block w-full max-w-md">
        <span className="sr-only">Search songs, artists or albums</span>
        <Search className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search songs, artists or albums"
          className="h-12 w-full rounded-full bg-elevated pr-12 pl-12 text-fg placeholder:text-faint outline-none ring-1 ring-transparent transition focus:ring-mint"
        />
        {pending && <Loader2 className="absolute top-1/2 right-4 size-4 -translate-y-1/2 animate-spin text-muted" aria-label="Searching" />}
      </label>
      <CollectionActions collection={{ kind: "library", query: q.trim() }} empty={!page.tracks.length || pending} label={q.trim() ? "results" : "library"} />
      </div>
      {error && <p className="mt-4 text-sm text-danger" role="alert">{error} <button className="underline" onClick={() => { setError(null); setRetry((n) => n + 1); }}>Retry</button></p>}
      <div className={`mt-8 ${pending ? "pointer-events-none opacity-50" : ""}`} inert={pending}>
        <TrackList
          tracks={page.tracks}
          collection={{ kind: "library", query: q.trim() }}
          empty={
            <p className="py-12 text-muted">
              {q ? <>Nothing on the shelf matches &ldquo;{q}&rdquo;. Try an artist name or fewer words.</> : "The library is empty so far. Songs appear here as soon as they finish importing."}
            </p>
          }
        />
        <div ref={sentinel} />
        {loadingMore && (
          <p className="flex items-center gap-2 py-6 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading more
          </p>
        )}
      </div>
    </div>
  );
}
