"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import Link from "next/link";
import { Disc3, ListMusic, MicVocal, Play, Search, TrendingUp, X } from "lucide-react";
import { Artwork } from "@/components/artwork";
import { MissingMusic } from "@/components/app/missing-music";
import { fetchCatalog } from "@/lib/browser-catalog";
import { formatDuration } from "@/lib/format";
import type { PlayerItem } from "@/lib/player-protocol";
import { TrackMenuButton, usePlayer } from "./player";
import { ArtistLink } from "./music-links";
import { MusicItem } from "./music-item";

const recentKey = "mint:recent-searches";
const browseTiles = [
  { label: "All music", href: "/app/library", icon: ListMusic, className: "bg-mint/25" },
  { label: "Albums", href: "/app/library?type=album", icon: Disc3, className: "bg-elevated" },
  { label: "Artists", href: "/app/library?type=artist", icon: MicVocal, className: "bg-hover" },
  { label: "Charts", href: "/app/discover/charts", icon: TrendingUp, className: "bg-warn/20" },
];
const emptyRecent: string[] = [];
type ResultGroup = { label: string; type: "track" | "artist" | "album"; items: PlayerItem[] };
type SearchResult = { query: string; retry: number; groups: ResultGroup[]; error: string };
let recentRaw: string | null = null;
let recentValue: string[] = emptyRecent;

function getRecentSearches() {
  if (typeof window === "undefined") return emptyRecent;
  try {
    const raw = localStorage.getItem(recentKey);
    if (raw === recentRaw) return recentValue;
    recentRaw = raw;
    const value: unknown = JSON.parse(raw ?? "[]");
    recentValue = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 6) : emptyRecent;
  } catch { recentRaw = null; recentValue = emptyRecent; }
  return recentValue;
}

function getPhoneViewport() {
  return window.matchMedia("(max-width: 767px)").matches;
}

function subscribeViewport(listener: () => void) {
  const media = window.matchMedia("(max-width: 767px)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

function subscribeRecent(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener("mint:recent-searches", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("mint:recent-searches", listener);
  };
}

function isEditable(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input,textarea,select,button,a,[role=button],[role=menuitem]"));
}

export function GlobalSearch({ fullPage = false, initialQuery = "" }: { fullPage?: boolean; initialQuery?: string }) {
  const [open, setOpen] = useState(fullPage), [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<SearchResult | null>(null), [retry, setRetry] = useState(0);
  const [online, setOnline] = useState(true);
  const recent = useSyncExternalStore(subscribeRecent, getRecentSearches, () => emptyRecent);
  const phone = useSyncExternalStore(subscribeViewport, getPhoneViewport, () => false);
  const trigger = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null), panel = useRef<HTMLDivElement>(null);
  const pushedHistory = useRef(false), restoreFocus = useRef(false), player = usePlayer();
  const remember = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const next = [trimmed, ...getRecentSearches().filter((item) => item.toLocaleLowerCase() !== trimmed.toLocaleLowerCase())].slice(0, 6);
    try { localStorage.setItem(recentKey, JSON.stringify(next)); } catch {}
    recentRaw = null;
    window.dispatchEvent(new Event("mint:recent-searches"));
  }, []);

  const close = useCallback((restore = true) => {
    restoreFocus.current = restore;
    setOpen(false);
    if (pushedHistory.current && history.state?.mintSearch) {
      pushedHistory.current = false;
      history.back();
    }
  }, []);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => { window.removeEventListener("online", updateOnline); window.removeEventListener("offline", updateOnline); };
  }, []);

  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
      return;
    }
    if (!open || fullPage) return;
    input.current?.focus();
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    const back = () => {
      if (pushedHistory.current) {
        pushedHistory.current = false;
        restoreFocus.current = true;
        setOpen(false);
        window.setTimeout(() => trigger.current?.focus(), 50);
      }
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("popstate", back);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("popstate", back);
    };
  }, [open, fullPage, close]);

  useEffect(() => {
    if (!fullPage) return;
    input.current?.focus();
  }, [fullPage]);

  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target) || phone) return;
      event.preventDefault();
      trigger.current?.click();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [phone]);

  useEffect(() => {
    const normalized = query.trim();
    if (!open || normalized.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void Promise.all((["track", "artist", "album"] as const).map(async (type) => {
        const params = new URLSearchParams({ kind: "library", type, q: normalized, size: "8", start: "0" });
        return { label: type === "track" ? "Songs" : type === "artist" ? "Artists" : "Albums", type,
          items: (await fetchCatalog(params, controller.signal)).items };
      })).then((result) => {
        if (!controller.signal.aborted) setResult({ query: normalized, retry, groups: result.filter((group) => group.items.length), error: "" });
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setResult({ query: normalized, retry, groups: [], error: reason instanceof Error ? reason.message : "Search results could not load. Try again." });
      });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, query, retry, setResult]);

  const show = () => {
    if (fullPage) return;
    pushedHistory.current = true;
    history.pushState({ ...(history.state ?? {}), mintSearch: true }, "");
    setOpen(true);
  };
  const chooseTrack = (item: PlayerItem) => {
    remember(query);
    close(false);
    if (player) void player.command({ action: "play", item });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !fullPage) {
      event.preventDefault();
      close();
    } else if (event.key === "Enter" && event.target === input.current) {
      remember(query);
    } else if (event.key === "Tab" && !fullPage && panel.current && phone) {
      const targets = Array.from(panel.current.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled)"))
        .filter((element) => element.offsetParent !== null);
      const first = targets[0], last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const visible = fullPage || open;
  const activeResult = result?.query === query.trim() && result.retry === retry ? result : null;
  const groups = activeResult?.groups ?? [];
  const loading = open && query.trim().length >= 2 && !activeResult;
  const error = activeResult?.error ?? "";

  return <div className={fullPage ? "w-full" : "relative min-w-0 flex-1"}>
    {!fullPage && <button ref={trigger} type="button" aria-label="Search your music" aria-haspopup="dialog" aria-expanded={open}
      onClick={show} className="flex min-h-11 items-center gap-3 rounded-full px-3 text-sm text-muted hover:bg-elevated hover:text-fg focus-visible:outline-action sm:w-full sm:max-w-sm sm:bg-elevated sm:px-5">
      <Search className="size-4 shrink-0" aria-hidden /><span className="hidden sm:inline">Search your music</span><span className="sr-only sm:hidden">Search your music</span>
      <kbd className="ml-auto hidden rounded bg-hover px-1.5 py-0.5 text-xs text-faint md:inline">/</kbd>
    </button>}
    {visible && <div ref={panel} role="dialog" aria-label="Search your music" aria-modal={!fullPage && phone || undefined}
      onKeyDown={onKeyDown} onMouseDown={(event) => {
        if (!fullPage && event.target === event.currentTarget && phone) close();
      }}
      className={fullPage ? "mx-auto max-w-6xl" : "search-panel fixed inset-0 z-[var(--z-overlay)] overflow-y-auto bg-surface p-5 pt-[max(1.25rem,var(--safe-area-top))] md:absolute md:inset-auto md:right-0 md:top-[calc(100%+0.75rem)] md:max-h-[min(75dvh,48rem)] md:w-[min(44rem,calc(100vw-6rem))] md:rounded-surface md:border md:border-line md:bg-elevated md:p-6 md:shadow-floating"}>
      <div className="flex items-center gap-3">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search songs, artists or albums</span>
          <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden />
          <input ref={input} type="search" role="searchbox" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)}
            placeholder="Search songs, artists or albums" className="min-h-12 w-full rounded-full bg-hover pl-12 pr-4 text-sm text-fg placeholder:text-faint outline-none focus-visible:ring-2 focus-visible:ring-mint" />
        </label>
        {!fullPage && <button type="button" aria-label="Close search" onClick={() => close()} className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"><X className="size-5" /></button>}
      </div>
      {online === false && <p role="status" className="mt-4 text-sm text-warn">You’re offline. Search needs a connection; downloaded songs remain available in Downloads.</p>}
      {error && <p role="alert" className="mt-4 text-sm text-danger">{error} <button type="button" className="underline" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
      {!query.trim() && !!recent.length && <section className="mt-6" aria-label="Recent searches"><h2 className="mb-2 text-base font-bold">Recent searches</h2>
        <ul className="flex flex-wrap gap-2">{recent.map((item) => <li key={item}><button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-full bg-hover px-4 text-sm text-fg hover:bg-line" onClick={() => setQuery(item)}><Search className="size-4 text-muted" aria-hidden />{item}</button></li>)}</ul>
      </section>}
      {!query.trim() && <nav className="mt-8" aria-label="Browse">
        <h2 className="mb-3 text-base font-bold">Browse all</h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">{browseTiles.map((tile) => <li key={tile.href}>
          <Link href={tile.href} onClick={() => close(false)} className={`relative flex aspect-[16/10] min-h-24 overflow-hidden rounded-lg p-4 text-lg font-bold text-fg transition hover:brightness-110 ${tile.className}`}>
            {tile.label}<tile.icon className="absolute -bottom-2 -right-2 size-16 rotate-12 opacity-30" aria-hidden />
          </Link>
        </li>)}</ul>
      </nav>}
      {loading && <p role="status" className="mt-6 text-sm text-muted">Searching…</p>}
      {!loading && !!groups.length && <SearchResults groups={groups} fullPage={fullPage} canPlay={!!player} playDisabled={!player?.ready || !!player?.busy}
        onPlay={chooseTrack} onNavigate={() => { remember(query); close(false); }} />}
      {!loading && query.trim().length >= 2 && !groups.length && !error && <>
        <p className="mt-6 text-sm text-muted">No songs, artists or albums match “{query}”.</p>
        <MissingMusic query={query.trim()} />
      </>}
    </div>}
  </div>;
}

const albumHref = (id: string) => `/app/library/albums/${encodeURIComponent(id)}`;
const artistHref = (id: string) => `/app/library/artists/${encodeURIComponent(id)}`;

function topResult(groups: ResultGroup[]) {
  const artist = groups.find((group) => group.type === "artist")?.items[0];
  const track = groups.find((group) => group.type === "track")?.items[0];
  const album = groups.find((group) => group.type === "album")?.items[0];
  return artist ?? track ?? album ?? null;
}

function SearchResults({ groups, fullPage, canPlay, playDisabled, onPlay, onNavigate }: {
  groups: ResultGroup[]; fullPage: boolean; canPlay: boolean; playDisabled: boolean;
  onPlay: (item: PlayerItem) => void; onNavigate: () => void;
}) {
  const top = topResult(groups);
  const songs = groups.find((group) => group.type === "track")?.items.slice(0, fullPage ? 6 : 4) ?? [];
  const artists = groups.find((group) => group.type === "artist")?.items ?? [];
  const albums = groups.find((group) => group.type === "album")?.items ?? [];
  const typeLabel = (item: PlayerItem) => item.type === "artist" ? "Artist" : item.type === "album" ? "Album" : "Song";
  return <>
    <div className={`mt-6 grid gap-6 ${fullPage ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : "md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"}`}>
      {top && <section aria-label="Top result">
        <h2 className="mb-3 text-xl font-bold">Top result</h2>
        <MusicItem item={top} className="group relative flex h-[calc(100%-2.5rem)] min-h-52 flex-col gap-4 rounded-lg bg-elevated p-5 transition hover:bg-hover">
          {top.type === "artist" ? <Link href={artistHref(top.id)} onClick={onNavigate} aria-label={`Open ${top.title}`} tabIndex={-1}>
            <Artwork track={{ artworkUrl: top.thumb ?? "" }} className="size-24 rounded-full shadow-floating" />
          </Link> : <Artwork track={{ artworkUrl: top.thumb ?? "" }} className="size-24 rounded-lg shadow-floating" />}
          <div className="min-w-0">
            {top.type === "track" ? <button type="button" onClick={() => onPlay(top)} className="block max-w-full truncate text-left text-3xl font-bold tracking-tight hover:underline">{top.title}</button>
              : <Link href={top.type === "album" ? albumHref(top.id) : artistHref(top.id)} onClick={onNavigate} className="block truncate text-3xl font-bold tracking-tight hover:underline">{top.title}</Link>}
            <p className="mt-2 flex min-w-0 items-center gap-2 text-sm text-muted">
              {top.type !== "artist" && <span onClick={onNavigate} className="min-w-0 truncate"><ArtistLink item={top} /></span>}
              <span className="shrink-0 rounded-full bg-bg/60 px-3 py-1 text-xs font-semibold text-fg">{typeLabel(top)}</span>
            </p>
          </div>
          {top.type === "track" && canPlay && <button type="button" aria-label={`Play ${top.title}`} disabled={playDisabled} onClick={() => onPlay(top)}
            className="absolute bottom-5 right-5 grid size-12 place-items-center rounded-full bg-mint text-mint-ink shadow-floating transition hover:scale-105 disabled:opacity-40"><Play className="size-5 fill-current" aria-hidden /></button>}
          {canPlay && <span className="absolute right-3 top-3"><TrackMenuButton item={top} /></span>}
        </MusicItem>
      </section>}
      {!!songs.length && <section aria-label="Songs">
        <h2 className="mb-3 text-xl font-bold">Songs</h2>
        <ul>{songs.map((item) => <MusicItem as="li" item={item} key={item.id} className="group flex min-h-14 items-center gap-3 rounded-control px-2 py-1 hover:bg-hover">
          <span className="relative shrink-0">
            <Artwork track={{ artworkUrl: item.thumb ?? "" }} className="size-10 rounded" />
          </span>
          <div className="min-w-0 flex-1">
            <button type="button" onClick={() => onPlay(item)} className="block max-w-full truncate text-left text-sm font-medium hover:underline">{item.title}</button>
            <p onClick={onNavigate} className="mt-0.5 truncate text-xs text-muted"><ArtistLink item={item} /></p>
          </div>
          {item.duration ? <span className="hidden text-xs tabular-nums text-muted sm:inline">{formatDuration(item.duration / 1000)}</span> : null}
          {item !== top && canPlay && <button type="button" aria-label={`Play ${item.title}`} disabled={playDisabled} onClick={() => onPlay(item)}
            className="grid size-11 shrink-0 place-items-center rounded-full text-fg hover:bg-line disabled:opacity-40"><Play className="size-4 fill-current" aria-hidden /></button>}
          {canPlay && <TrackMenuButton item={item} />}
        </MusicItem>)}</ul>
      </section>}
    </div>
    {!!artists.length && <CardShelf label="Artists" items={artists} round canMenu={canPlay} onNavigate={onNavigate} />}
    {!!albums.length && <CardShelf label="Albums" items={albums} canMenu={canPlay} onNavigate={onNavigate} />}
  </>;
}

function CardShelf({ label, items, round = false, canMenu, onNavigate }: { label: string; items: PlayerItem[]; round?: boolean; canMenu: boolean; onNavigate: () => void }) {
  return <section className="mt-8" aria-label={label}>
    <h2 className="mb-3 text-xl font-bold">{label}</h2>
    <ul className="-mx-2 flex snap-x gap-2 overflow-x-auto pb-2">{items.map((item) => <MusicItem as="li" item={item} key={item.id}
      className="group relative w-36 shrink-0 snap-start rounded-lg p-2 transition hover:bg-hover sm:w-40">
      <Link href={item.type === "album" ? albumHref(item.id) : artistHref(item.id)} onClick={onNavigate} className="block">
        <Artwork track={{ artworkUrl: item.thumb ?? "" }} className={`aspect-square w-full shadow-floating ${round ? "rounded-full" : "rounded-lg"}`} />
        <span className="mt-2 block truncate text-sm font-semibold">{item.title}</span>
      </Link>
      <p onClick={onNavigate} className="mt-0.5 truncate text-xs text-muted">{item.type === "artist" ? "Artist" : <ArtistLink item={item} />}</p>
      {canMenu && <span className="absolute right-3 top-3 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"><TrackMenuButton item={item} /></span>}
    </MusicItem>)}</ul>
  </section>;
}
