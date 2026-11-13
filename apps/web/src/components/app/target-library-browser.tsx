"use client";

import { libraryFilePageSchema, type LibraryFileListItem } from "@mint/contracts";
import { useEffect, useRef, useState } from "react";

export async function fetchTargetLibraryPage(search: string, cursor: string | null, signal: AbortSignal) {
  const query = new URLSearchParams({ limit: "50" });
  if (search) query.set("search", search);
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`/api/library/files?${query}`, {
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Sign in again to browse your library.");
    if (response.status === 503) throw new Error("Your library is temporarily unavailable. Try again.");
    throw new Error("Your library could not load. Try again.");
  }
  const page = libraryFilePageSchema.safeParse(await response.json());
  if (!page.success) throw new Error("Your library returned an invalid response.");
  return page.data;
}

export function TargetLibraryBrowser({ initialQuery = "" }: { initialQuery?: string }) {
  const [files, setFiles] = useState<LibraryFileListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const requestId = ++generation.current;
    const controller = new AbortController();
    active.current = controller;
    void fetchTargetLibraryPage(initialQuery.trim(), null, controller.signal).then((page) => {
      if (generation.current !== requestId) return;
      setFiles(page.items);
      setCursor(page.nextCursor);
    }).catch((cause: unknown) => {
      if (generation.current !== requestId || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "Your library could not load. Try again.");
    }).finally(() => {
      if (generation.current === requestId) {
        setLoading(false);
        if (active.current === controller) active.current = null;
      }
    });
    return () => {
      controller.abort();
      if (active.current === controller) active.current = null;
    };
  }, [initialQuery]);

  async function loadMore() {
    if (!cursor || loadingMore || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const page = await fetchTargetLibraryPage(initialQuery.trim(), cursor, controller.signal);
      if (active.current !== controller) return;
      setFiles((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "More songs could not load. Try again.");
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoadingMore(false);
      }
    }
  }

  return (
    <section className="mx-auto max-w-6xl">
      <header className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">Your Library</h1>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">
          Search verified songs in your self-hosted library.
        </p>
        <form action="/app/library" method="get" className="mt-6 flex max-w-xl gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Search songs, artists, or albums</span>
            <input name="q" type="search" maxLength={200} defaultValue={initialQuery}
              placeholder="Search songs, artists, or albums"
              className="h-11 w-full rounded-full bg-elevated px-4 text-sm outline-none focus:ring-2 focus:ring-mint" />
          </label>
          <button type="submit" className="min-h-11 rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong">
            Search
          </button>
        </form>
      </header>

      <p role="status" aria-live="polite" className="mb-3 text-sm text-muted">
        {loading ? "Loading your library…" : files.length
          ? `${files.length.toLocaleString()} ${files.length === 1 ? "song" : "songs"} shown`
          : ""}
      </p>
      {error && <div role="alert" className="py-6 text-warn">
        <p>{error}</p>
        {!files.length && <a href={`/app/library${initialQuery ? `?q=${encodeURIComponent(initialQuery)}` : ""}`}
          className="mt-3 inline-flex min-h-11 items-center font-semibold text-fg underline underline-offset-4">Try again</a>}
      </div>}
      {!loading && !error && !files.length && (
        <div className="py-12">
          <h2 className="text-xl font-semibold">{initialQuery ? `No results for “${initialQuery}”` : "Nothing here yet"}</h2>
          <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">
            {initialQuery ? "Try a different title, artist, or album." : "Verified songs will appear here after your library is scanned."}
          </p>
        </div>
      )}
      {!!files.length && (
        <>
          <p className="mb-4 text-sm text-muted">Playback from this target Library is not available yet.</p>
          <ol className="divide-y divide-line/70">
            {files.map((file) => (
              <li key={file.id} className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-3">
                <div className="min-w-0">
                  <h2 className="truncate font-semibold">{file.title}</h2>
                  <p className="truncate text-sm text-muted">{file.artist} · {file.album}</p>
                </div>
                <span className="text-sm tabular-nums text-muted">
                  {file.durationMs === null ? "" : `${Math.floor(file.durationMs / 60_000)}:${String(Math.floor(file.durationMs / 1000) % 60).padStart(2, "0")}`}
                </span>
              </li>
            ))}
          </ol>
          {cursor && <button type="button" onClick={() => void loadMore()} disabled={loadingMore}
            className="mt-6 min-h-11 rounded-full bg-elevated px-5 text-sm font-semibold hover:bg-hover disabled:opacity-50">
            {loadingMore ? "Loading…" : "Load more songs"}
          </button>}
        </>
      )}
    </section>
  );
}
