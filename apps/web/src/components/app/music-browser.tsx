"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Clock3, Play, Search } from "lucide-react";
import { Artwork } from "@/components/artwork";
import { collectionSchema, type CatalogPage, type PlayerCollection, type PlayerItem } from "@/lib/player-protocol";
import { collectionParams, fetchCatalog } from "@/lib/browser-catalog";
import { formatDuration } from "@/lib/format";
import { CollectionActions } from "./collection-actions";
import { TrackMenuButton, usePlayer } from "./player";

const kinds = ["track", "album", "artist", "playlist"] as const;
type Kind = typeof kinds[number];
const labels: Record<Kind, string> = { track: "Songs", album: "Albums", artist: "Artists", playlist: "Playlists" };

function itemHref(item: PlayerItem) {
  const query = new URLSearchParams({ view: "library", kind: item.type, id: item.id, type: item.type === "artist" ? "album" : "track" });
  return `/app/music?${query}`;
}

export function MusicBrowser() {
  const router = useRouter(), params = useSearchParams();
  const rawType = params.get("type");
  const type: Kind = kinds.find((kind) => kind === rawType) ?? (params.get("view") === "home" || !params.get("view") ? "album" : "track");
  const parsed = collectionSchema.safeParse({ kind: params.get("kind") ?? "library", id: params.get("id"), query: params.get("q") || undefined });
  const collection: PlayerCollection | null = parsed.success ? parsed.data : null;
  const q = params.get("q") ?? "";
  const start = Math.max(0, Number(params.get("start")) || 0);
  const request = collectionParams(collection ?? { kind: "library" });
  request.set("type", type); request.set("size", "100"); request.set("start", String(start));
  if (q) request.set("q", q);
  const key = request.toString();
  const [result, setResult] = useState<{ key: string; page?: CatalogPage; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const page = result?.key === key ? result.page : undefined;
  const error = result?.key === key ? result.error : undefined;
  const valid = collection !== null;

  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchCatalog(new URLSearchParams(key), controller.signal).then((page) => {
        if (!controller.signal.aborted) setResult({ key, page });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "Your music could not load." });
      });
    }, 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, valid, retry, q]);

  const change = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    next.delete("start");
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
    router.replace(`/app/music?${next}`, { scroll: false });
  };
  if (!collection) return <div role="alert" className="py-12"><h1 className="text-3xl font-bold">This collection link isn&apos;t valid.</h1><Link href="/app/music?view=library" className="mt-4 inline-block text-mint underline">Open your library</Link></div>;
  const first = page?.items[0];
  const title = collection.kind === "album" ? first?.album ?? "Album"
    : collection.kind === "artist" ? first?.artist ?? "Artist"
    : collection.kind === "liked" ? "Liked songs"
    : collection.kind === "playlist" ? page?.title ?? "Playlist"
    : params.get("view") === "search" ? "Find your next song"
    : params.get("view") === "library" ? "Your library" : "Your music";
  return <div className="mx-auto max-w-[100rem]">
    {collection.kind !== "library" && <Link href="/app/music?view=library" className="mb-5 inline-flex min-h-11 items-center gap-1 text-sm text-muted hover:text-fg"><ChevronLeft className="size-4" />Your library</Link>}
    <header className="mb-7 flex items-end gap-5">
      {collection.kind === "album" && first && <Artwork track={{ artworkUrl: first.thumb ?? "" }} className="hidden size-32 shrink-0 rounded-md sm:block" />}
      <div className="min-w-0">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">{title}</h1>
        <p className="mt-3 text-sm text-muted">{collection.kind === "library" ? "Made for your music. Nothing between you and the next song." : collection.kind === "artist" ? "Albums and songs in your library." : first?.artist ?? "Downloaded music from your collection."}</p>
      </div>
    </header>
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <nav aria-label="Library categories" className="flex flex-wrap gap-1">
        {kinds.filter((kind) => collection.kind === "library" || (collection.kind === "artist" ? kind === "album" || kind === "track" : kind === "track")).map((kind) =>
          <button key={kind} aria-pressed={type === kind} onClick={() => change({ type: kind })}
            className={`min-h-11 rounded-full px-4 text-sm font-semibold ${type === kind ? "bg-fg text-bg" : "bg-elevated text-muted hover:bg-hover hover:text-fg"}`}>{labels[kind]}</button>)}
      </nav>
      {type !== "playlist" && <CollectionActions collection={collection.kind === "library" ? { ...collection, query: q } : collection} empty={!page?.items.length} label={collection.kind === "library" && q ? "results" : collection.kind} />}
    </div>
    {type !== "playlist" && <CatalogSearch key={`${collection.kind}:${"id" in collection ? collection.id : ""}:${type}:${params.get("view")}`} query={q} />}
    {error ? <div role="alert" className="py-8"><p className="text-warn">{error}</p><button className="mt-4 min-h-11 rounded-full bg-elevated px-5 hover:bg-hover" onClick={() => setRetry((n) => n + 1)}>Retry loading music</button></div>
      : !page ? <p role="status" className="py-12 text-muted">Opening your music…</p>
      : !page.items.length ? <div className="py-12"><h2 className="text-xl font-semibold">{q ? "No matches on this shelf." : "Nothing here yet."}</h2><p className="mt-3 max-w-lg text-sm leading-relaxed text-muted">{q ? "Try an artist name, album or fewer words." : type === "playlist" ? "Your YouTube Music playlists appear after syncing. Manage imports in Settings." : "Music appears here as files finish importing. Check Jobs for progress."}</p></div>
      : type === "track" ? <CatalogTracks items={page.items} collection={collection} />
      : <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">{page.items.map((item) => <CollectionCard key={item.id} item={item} />)}</div>}
    {page && page.total > 100 && <nav aria-label="Library pages" className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-sm">
      <p className="text-muted tabular">{start + 1}–{Math.min(start + page.items.length, page.total)} of {page.total.toLocaleString()}</p>
      <div className="flex gap-2">
        <button disabled={!start} onClick={() => change({ start: String(Math.max(0, start - 100)) })} className="inline-flex min-h-11 items-center rounded-full bg-elevated px-4 hover:bg-hover disabled:opacity-40"><ChevronLeft className="mr-1 size-4" />Previous</button>
        <button disabled={start + page.items.length >= page.total} onClick={() => change({ start: String(start + 100) })} className="inline-flex min-h-11 items-center rounded-full bg-elevated px-4 hover:bg-hover disabled:opacity-40">Next<ChevronRight className="ml-1 size-4" /></button>
      </div>
    </nav>}
  </div>;
}

function CatalogSearch({ query }: { query: string }) {
  const [draft, setDraft] = useState(query);
  const router = useRouter();
  useEffect(() => {
    const back = () => setDraft(new URLSearchParams(location.search).get("q") ?? "");
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  useEffect(() => {
    if (draft === query) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(location.search);
      next.delete("start");
      if (draft) next.set("q", draft); else next.delete("q");
      router.replace(`/app/music?${next}`, { scroll: false });
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, query, router]);
  return <label className="relative mb-7 block max-w-lg">
    <span className="sr-only">Search songs, artists or albums</span>
    <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted" />
    <input type="search" maxLength={100} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Search songs, artists or albums"
      className="h-12 w-full rounded-full bg-elevated pl-12 pr-4 text-sm placeholder:text-faint outline-none focus:ring-2 focus:ring-mint" />
  </label>;
}

function CollectionCard({ item }: { item: PlayerItem }) {
  const player = usePlayer()!;
  return <article className="group relative min-w-0" onContextMenu={(event) => {
    event.preventDefault(); player.menu(item, { x: event.clientX, y: event.clientY }, event.currentTarget.querySelector("a"));
  }}>
    <Link href={itemHref(item)} className="block rounded-md">
      <Artwork track={{ artworkUrl: item.thumb ?? "" }} className={`w-full ${item.type === "artist" ? "rounded-full" : "rounded-md"}`} />
      <h2 className="mt-3 truncate font-semibold group-hover:underline">{item.title}</h2>
      <p className="truncate text-sm text-muted">{item.artist ?? labels[item.type]}</p>
    </Link>
    <button aria-label={`Play ${item.title}`} disabled={!player.ready || player.busy} onClick={() => player.command({ action: "play", item })}
      className="absolute right-2 top-2 grid size-11 place-items-center rounded-full bg-mint text-mint-ink shadow-[0_6px_12px_-4px_#000] transition-transform hover:scale-105 disabled:opacity-40"><Play className="size-5" fill="currentColor" /></button>
    <div className="mt-1 flex justify-end"><TrackMenuButton item={item} /></div>
  </article>;
}

function CatalogTracks({ items, collection }: { items: PlayerItem[]; collection: PlayerCollection }) {
  const player = usePlayer()!;
  return <div>
    <div className="hidden grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,1fr)_5rem] gap-3 border-b border-line px-3 pb-3 text-xs text-faint sm:grid">
      <span>#</span><span>Title</span><span>Album</span><Clock3 className="ml-auto size-4" aria-label="Duration" />
    </div>
    <ol className="mt-2">{items.map((item, index) => {
      const current = player.state.track?.id === item.id;
      const play = () => player.command({ action: "collection", collection, id: item.id, shuffle: false });
      return <li key={item.id} onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest("a,input")) return;
        event.preventDefault(); player.menu(item, { x: event.clientX, y: event.clientY }, event.currentTarget.querySelector("button"));
      }} onKeyDown={(event) => {
        if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") {
          event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect();
          player.menu(item, { x: rect.x + 40, y: rect.bottom }, event.target as HTMLElement);
        }
      }} className="group grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-2 hover:bg-hover/70 sm:grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,1fr)_5rem]">
        <button aria-label={`Play ${item.title}`} disabled={!player.ready || player.busy} onClick={play} className="grid size-8 place-items-center rounded-full text-muted hover:bg-elevated hover:text-mint disabled:opacity-40"><Play className={`size-4 ${current ? "text-mint" : ""}`} fill={current ? "currentColor" : "none"} /></button>
        <div className="flex min-w-0 items-center gap-3">
          <Artwork track={{ artworkUrl: item.thumb ?? "" }} className="size-11" />
          <div className="min-w-0"><button disabled={!player.ready || player.busy} onClick={play} className={`block max-w-full truncate text-left font-medium hover:underline disabled:opacity-40 ${current ? "text-mint" : "text-fg"}`}>{item.title}</button><p className="truncate text-sm text-muted">{item.artist}</p></div>
        </div>
        <p className="hidden truncate text-sm text-muted sm:block">{item.album ?? "Single"}</p>
        <div className="flex items-center justify-end text-xs text-muted tabular"><TrackMenuButton item={item} /><span>{formatDuration((item.duration ?? 0) / 1000)}</span></div>
      </li>;
    })}</ol>
  </div>;
}
