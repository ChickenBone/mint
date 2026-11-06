"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, Clock3, Play, Search } from "lucide-react";
import { Artwork } from "@/components/artwork";
import { type CatalogPage, type PlayerCollection, type PlayerItem } from "@/lib/player-protocol";
import { collectionFromParams, collectionParams, fetchCatalog, metadataFilterKeys } from "@/lib/browser-catalog";
import { formatDuration } from "@/lib/format";
import { CollectionActions } from "./collection-actions";
import { TrackMenuButton, usePlayer } from "./player";
import { MissingMusic } from "./missing-music";

const kinds = ["track", "album", "artist", "playlist"] as const;
type Kind = typeof kinds[number];
const labels: Record<Kind, string> = { track: "Songs", album: "Albums", artist: "Artists", playlist: "Playlists" };
function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

function itemHref(item: PlayerItem) {
  if (item.type === "artist") return `/app/library/artists/${encodeURIComponent(item.id)}?type=album`;
  if (item.type === "album") return `/app/library/albums/${encodeURIComponent(item.id)}?type=track`;
  return `/app/library?q=${encodeURIComponent(item.title)}`;
}

export function MusicBrowser({ initialCollection }: { initialCollection?: PlayerCollection }) {
  const router = useRouter(), pathname = usePathname(), params = useSearchParams();
  const rawType = params.get("type");
  const type: Kind = kinds.find((kind) => kind === rawType) ?? (initialCollection?.kind === "artist" ? "album" : "track");
  const rawSort = params.get("sort");
  const sort = rawSort === "title" || rawSort === "album" || rawSort === "newest" ? rawSort : "artist";
  const parsed = collectionFromParams(params);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const collection: PlayerCollection | null = initialCollection ?? (parsed.success ? parsed.data : null);
  const q = params.get("q") ?? "";
  const start = Math.max(0, Number(params.get("start")) || 0);
  const request = collectionParams(collection ?? { kind: "library" });
  request.set("type", type); request.set("sort", sort); request.set("size", "100"); request.set("start", String(start));
  if (q) request.set("q", q);
  const key = request.toString();
  const [result, setResult] = useState<{ key: string; page?: CatalogPage; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const page = result?.key === key ? result.page : undefined;
  const error = result?.key === key ? result.error : undefined;
  const valid = collection !== null;
  const listing = collection?.kind !== "library" || Boolean(q.trim()) || pathname === "/app/library";

  useEffect(() => {
    if (!valid || !listing) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchCatalog(new URLSearchParams(key), controller.signal).then((page) => {
        if (!controller.signal.aborted) setResult({ key, page });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "Your music could not load." });
      });
    }, 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, valid, listing, retry, q]);

  const change = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    next.delete("start");
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  if (!collection) return <div role="alert" className="py-12"><h1 className="text-3xl font-bold">This collection link isn&apos;t valid.</h1><Link href="/app/library" className="mt-4 inline-block text-mint underline">Open your library</Link></div>;
  if (!listing) return <div className="mx-auto max-w-4xl py-5">
    <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">Find your next song.</h1>
    <p className="my-5 max-w-xl text-sm leading-relaxed text-muted">Your shared library is a music backlog, not a list you need to scroll. Search with a few title or artist words; Mint handles prefixes, accents and close spellings.</p>
    <CatalogSearch key="backlog-search" query={q} />
    <div className="flex flex-wrap gap-4 text-sm font-semibold"><Link href="/app" className="inline-flex min-h-11 items-center text-mint hover:underline">Your daily recommendations</Link><Link href="/app/library" className="inline-flex min-h-11 items-center text-muted hover:text-fg">Browse the catalog</Link></div>
    <MissingMusic key={q} query={q} />
  </div>;
  const first = page?.items[0];
  const title = collection.kind === "album" ? first?.album ?? "Album"
    : collection.kind === "artist" ? first?.artist ?? "Artist"
    : collection.kind === "liked" ? "Liked songs"
    : collection.kind === "playlist" ? page?.title ?? "Playlist"
    : pathname === "/app/library" ? "Library" : "Your music";
  return <div className="mx-auto max-w-[100rem]">
    {collection.kind !== "library" && <Link href="/app/library" className="mb-5 inline-flex min-h-11 items-center gap-1 text-sm text-muted hover:text-fg"><ChevronLeft className="size-4" />Library</Link>}
    <header className="mb-7 flex items-end gap-5">
      {collection.kind === "album" && first && <Artwork track={{ artworkUrl: first.thumb ?? "" }} className="hidden size-32 shrink-0 rounded-md sm:block" />}
      <div className="min-w-0">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{collection.kind === "library" ? "Library" : title}</h1>
        <p className="mt-3 text-sm text-muted">{collection.kind === "library" ? "Made for your music. Nothing between you and the next song." : collection.kind === "artist" ? "Albums and songs in your library." : first?.artist ?? "Downloaded music from your collection."}</p>
      </div>
    </header>
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <nav aria-label="Library categories" className="flex flex-wrap gap-1">
        {kinds.filter((kind) => collection.kind === "library" ? kind !== "playlist" : collection.kind === "artist" ? kind === "album" || kind === "track" : kind === "track").map((kind) =>
          <button key={kind} aria-pressed={type === kind} onClick={() => change({ type: kind })}
            className={`min-h-11 rounded-full px-4 text-sm font-semibold ${type === kind ? "bg-fg text-bg" : "bg-elevated text-muted hover:bg-hover hover:text-fg"}`}>{labels[kind]}</button>)}
      </nav>
      {type !== "playlist" && <CollectionActions collection={collection.kind === "library" ? { ...collection, query: q } : collection} empty={!page?.items.length} label={collection.kind === "library" && q ? "results" : collection.kind} />}
      {type !== "playlist" && <label className="flex min-h-11 items-center gap-2 text-sm text-muted">Sort by
        <select aria-label="Sort library" value={sort} onChange={(event) => change({ sort: event.target.value })} className="min-h-11 rounded-full bg-elevated px-3 text-fg ring-1 ring-line focus-visible:ring-mint">
          <option value="artist">Artist</option><option value="title">Title</option><option value="album">Album</option><option value="newest">Recently added</option>
        </select>
      </label>}
    </div>
    {type !== "playlist" && <CatalogSearch key={`${collection.kind}:${"id" in collection ? collection.id : ""}:${type}:${pathname}`} query={q} />}
    {collection.kind === "library" && type !== "playlist" && <details className="mb-7 border-y border-line py-4">
      <summary className="cursor-pointer text-sm font-semibold">Filter library{Object.values(collection.filters ?? {}).some((v) => v !== undefined && v !== "") ? " · active" : ""}</summary>
      <form key={metadataFilterKeys.map((key) => params.get(key) ?? "").join(":")} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => {
        event.preventDefault(); const values = new FormData(event.currentTarget);
        change(Object.fromEntries(metadataFilterKeys.map((key) => [key, String(values.get(key) ?? "").trim()])));
      }}>
        <p className="text-sm leading-relaxed text-muted sm:col-span-2 lg:col-span-3">Artist and album contain your text. Codec, genre, mood, BPM, and Camelot key filter measured audio across the library. Play and Shuffle use these same filters.</p>
        {(["artist", "album", "codec", "minYear", "maxYear", "genre", "mood", "minBpm", "maxBpm", "camelotKey"] as const).map((key) => <label key={key} className="text-sm text-muted">
          {{
            artist: "Artist contains",
            album: "Album contains",
            codec: "Codec",
            minYear: "Year from",
            maxYear: "Year through",
            genre: "Genre or sub-style",
            mood: "Mood / vibe",
            minBpm: "BPM from",
            maxBpm: "BPM through",
            camelotKey: "Key or Camelot code",
          }[key]}
          <input name={key} defaultValue={params.get(key) ?? ""} type={key === "minYear" || key === "maxYear" || key === "minBpm" || key === "maxBpm" ? "number" : "text"}
            min={key === "minYear" || key === "maxYear" ? 1000 : key === "minBpm" || key === "maxBpm" ? 40 : undefined}
            max={key === "minYear" || key === "maxYear" ? 3000 : key === "minBpm" || key === "maxBpm" ? 240 : undefined}
            maxLength={key === "codec" || key === "genre" || key === "mood" ? 100 : key === "camelotKey" ? 10 : 200}
            placeholder={{
              artist: undefined,
              album: undefined,
              codec: "flac, opus, mp3…",
              minYear: undefined,
              maxYear: undefined,
              genre: "Electronic, House, Jazz…",
              mood: "chill, energetic, focus…",
              minBpm: "90",
              maxBpm: "130",
              camelotKey: "8A, 11B, F# minor…",
            }[key]}
            className="mt-2 min-h-11 w-full rounded-md bg-elevated px-3 py-2 text-sm text-fg ring-1 ring-line focus:ring-mint" />
        </label>)}
        <label className="text-sm text-muted">
          Vocal / instrumental
          <select name="vocalType" defaultValue={params.get("vocalType") ?? ""} className="mt-2 min-h-11 w-full rounded-md bg-elevated px-3 py-2 text-sm text-fg ring-1 ring-line focus:ring-mint">
            <option value="">Any</option>
            <option value="vocal">Vocal</option>
            <option value="instrumental">Instrumental</option>
            <option value="spoken-word">Spoken word</option>
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <button className="min-h-11 rounded-full bg-mint px-5 py-2 text-sm font-bold text-mint-ink">Apply filters</button>
          <button type="button" className="min-h-11 rounded-full bg-elevated px-4 py-2 text-sm font-semibold hover:bg-hover" onClick={() => change(Object.fromEntries(metadataFilterKeys.map((key) => [key, ""])))}>Clear filters</button>
        </div>
      </form>
    </details>}
    {error ? <div role="alert" className="py-8"><p className="max-w-prose text-warn">{online ? error : "You’re offline. Catalog data needs a connection; downloaded songs remain available in Your music → Downloads."}</p><div className="mt-4 flex flex-wrap gap-3"><button className="min-h-11 rounded-full bg-elevated px-5 hover:bg-hover" onClick={() => setRetry((n) => n + 1)}>Retry loading music</button>{!online && <Link href="/app/collection?tab=downloads" className="inline-flex min-h-11 items-center rounded-full border border-line px-5 text-sm font-semibold hover:bg-hover">Open Downloads</Link>}</div></div>
      : !page ? <p role="status" className="py-12 text-muted">Opening your music…</p>
      : !page.items.length ? <div className="py-12"><h2 className="text-xl font-semibold">{q ? "No matches on this shelf." : "Nothing here yet."}</h2><p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">{q ? "Try an artist name, album or fewer words." : type === "playlist" ? "Your playlists appear here after syncing or creating one in Your music." : "Music appears here as songs finish arriving in the library. Connect a service in Settings or check Your music for progress."}</p>{!q && <div className="mt-5 flex flex-wrap gap-3"><Link href="/app/settings?section=services" className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong">Connect a service</Link><Link href="/app/collection" className="inline-flex min-h-11 items-center rounded-full border border-line px-5 text-sm font-semibold hover:bg-hover">Open Your music</Link></div>}</div>
      : type === "track" ? <CatalogTracks items={page.items} collection={collection} />
      : <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">{page.items.map((item) => <CollectionCard key={item.id} item={item} />)}</div>}
    {page && page.total > 100 && <nav aria-label="Library pages" className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-sm">
      <p className="text-muted tabular">{start + 1}–{Math.min(start + page.items.length, page.total)} of {page.total.toLocaleString()}</p>
      <div className="flex gap-2">
        <button disabled={!start} onClick={() => change({ start: String(Math.max(0, start - 100)) })} className="inline-flex min-h-11 items-center rounded-full bg-elevated px-4 hover:bg-hover disabled:opacity-40"><ChevronLeft className="mr-1 size-4" />Previous</button>
        <button disabled={start + page.items.length >= page.total} onClick={() => change({ start: String(start + 100) })} className="inline-flex min-h-11 items-center rounded-full bg-elevated px-4 hover:bg-hover disabled:opacity-40">Next<ChevronRight className="ml-1 size-4" /></button>
      </div>
    </nav>}
    {collection.kind === "library" && q.trim().length >= 2 && <MissingMusic key={q} query={q} />}
  </div>;
}

function CatalogSearch({ query }: { query: string }) {
  const [draft, setDraft] = useState(query);
  const router = useRouter(), pathname = usePathname();
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
      router.replace(`${pathname}?${next}`, { scroll: false });
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, query, pathname, router]);
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
      const play = () => player.command({ action: "collection", collection, id: item.id, occurrenceId: item.occurrenceId, shuffle: false });
      return <li key={item.occurrenceId ?? item.id} onContextMenu={(event) => {
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
