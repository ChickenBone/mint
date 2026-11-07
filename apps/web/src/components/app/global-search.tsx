"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowDownToLine, Disc3, ListMusic, Loader2, MicVocal, Play, Search, TrendingUp } from "lucide-react";
import type { TrackView } from "@mint/core/events";
import { Artwork } from "@/components/artwork";
import { ReportIssueButton } from "@/components/app/report-issue";
import { fetchCatalog } from "@/lib/browser-catalog";
import { formatDuration } from "@/lib/format";
import type { RecordingSearchItem } from "@/lib/music-requests";
import { playerItemSchema, type PlayerItem } from "@/lib/player-protocol";
import { searchResponseIsCurrent, uniqueExternalResults } from "@/lib/unified-search";
import { useRealtime } from "@/components/realtime";
import { TrackMenuButton, usePlayer } from "./player";
import { ArtistLink } from "./music-links";
import { MusicItem } from "./music-item";
import { DiscoveryShelves } from "./discovery-shelves";

const recentKey = "mint:recent-searches";
const browseTiles = [
  { label: "All music", href: "/app/library", icon: ListMusic, className: "bg-mint/25" },
  { label: "Albums", href: "/app/library?type=album", icon: Disc3, className: "bg-elevated" },
  { label: "Artists", href: "/app/library?type=artist", icon: MicVocal, className: "bg-hover" },
  { label: "Charts", href: "/app/discover/charts", icon: TrendingUp, className: "bg-warn/20" },
];
const emptyRecent: string[] = [];
type ResultGroup = { label: string; type: "track" | "artist" | "album"; items: PlayerItem[] };
type LocalResult = { query: string; groups: ResultGroup[]; errors: number; loading: boolean };
type RecordingResult = RecordingSearchItem;
type ExternalResult = { query: string; items: RecordingResult[]; loading: boolean; error: string };
type RequestState = { trackId: string; stage: string; progress: number; error: string | null };
const emptyGroups: ResultGroup[] = [];
const emptyRecordings: RecordingResult[] = [];
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

function subscribeRecent(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener("mint:recent-searches", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("mint:recent-searches", listener);
  };
}

export function GlobalSearch({ initialQuery, discoverySeeds }: { initialQuery: string; discoverySeeds: TrackView[] }) {
  const [query, setQuery] = useState(initialQuery.slice(0, 100));
  const [local, setLocal] = useState<LocalResult | null>(null);
  const [external, setExternal] = useState<ExternalResult | null>(null);
  const [retry, setRetry] = useState(0);
  const [requests, setRequests] = useState<Record<string, RequestState>>({});
  const [playable, setPlayable] = useState<Record<string, PlayerItem>>({});
  const [online, setOnline] = useState(true);
  const normalized = query.trim();
  const input = useRef<HTMLInputElement>(null), player = usePlayer(), requestGeneration = useRef(0);
  const recent = useSyncExternalStore(subscribeRecent, getRecentSearches, () => emptyRecent);
  const activeLocal = local?.query === normalized ? local : null;
  const activeExternal = external?.query === normalized ? external : null;
  const groups = activeLocal?.groups ?? emptyGroups;
  const catalogMatches = useMemo(() => groups.find((group) => group.type === "track")?.items ?? [], [groups]);
  const externalItems = activeExternal?.items ?? emptyRecordings;
  const visibleExternal = uniqueExternalResults(catalogMatches, externalItems);
  const remember = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const next = [trimmed, ...getRecentSearches().filter((item) => item.toLocaleLowerCase() !== trimmed.toLocaleLowerCase())].slice(0, 6);
    try { localStorage.setItem(recentKey, JSON.stringify(next)); } catch {}
    recentRaw = null;
    window.dispatchEvent(new Event("mint:recent-searches"));
  }, []);

  const hydratePlayable = useCallback(async (trackId: string) => {
    try {
      const response = await fetch("/api/player/items", { method: "POST", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [trackId] }) });
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("items" in body) || !Array.isArray(body.items)) return;
      const item = playerItemSchema.parse(body.items[0]);
      if (item.type === "track" && item.id === trackId) setPlayable((current) => ({ ...current, [trackId]: item }));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error("Search result playback lookup failed", error);
    }
  }, [setPlayable]);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => { window.removeEventListener("online", updateOnline); window.removeEventListener("offline", updateOnline); };
  }, []);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    const focusSearch = () => input.current?.focus({ preventScroll: true });
    window.addEventListener("mint:focus-search", focusSearch);
    return () => window.removeEventListener("mint:focus-search", focusSearch);
  }, []);

  useEffect(() => {
    const syncQuery = () => {
      requestGeneration.current++;
      setQuery(new URL(window.location.href).searchParams.get("q")?.slice(0, 100) ?? "");
    };
    window.addEventListener("popstate", syncQuery);
    return () => window.removeEventListener("popstate", syncQuery);
  }, []);

  useEffect(() => {
    if (normalized.length < 2) {
      return;
    }
    const generation = requestGeneration.current;
    const controller = new AbortController();
    const types = ["track", "artist", "album"] as const;
    const localTimer = window.setTimeout(() => {
      void Promise.allSettled(types.map(async (type) => {
        const catalogParams = new URLSearchParams({ kind: "library", type, q: normalized, size: "8", start: "0" });
        const page = await fetchCatalog(catalogParams, controller.signal);
        return { label: type === "track" ? "Songs" : type === "artist" ? "Artists" : "Albums", type, items: page.items };
      })).then((settled) => {
        if (!searchResponseIsCurrent(normalized, input.current?.value.trim().slice(0, 100) ?? "", controller.signal.aborted) ||
            generation !== requestGeneration.current) return;
        const nextGroups: ResultGroup[] = [];
        let errors = 0;
        for (const result of settled) {
          if (result.status === "fulfilled") {
            if (result.value.items.length) nextGroups.push(result.value);
          } else if (!(result.reason instanceof DOMException && result.reason.name === "AbortError")) errors++;
        }
        setLocal({ query: normalized, groups: nextGroups, errors, loading: false });
      });
    }, 90);
    const externalTimer = window.setTimeout(() => {
      void fetch(`/api/music/search?${new URLSearchParams({ q: normalized })}`, {
        cache: "no-store", credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The music catalog could not be reached.");
        if (!Array.isArray(body.items)) throw new Error("The music catalog returned an invalid response.");
        return body.items as RecordingResult[];
      }).then((items) => {
        if (!searchResponseIsCurrent(normalized, input.current?.value.trim().slice(0, 100) ?? "", controller.signal.aborted) ||
            generation !== requestGeneration.current) return;
        setExternal({ query: normalized, items, loading: false, error: "" });
        for (const item of items) {
          if (item.existing?.playable) void hydratePlayable(item.existing.id);
        }
        setRequests((current) => {
          const next = { ...current };
          for (const item of items) {
            if (item.existing && !next[item.id] && !item.existing.playable) next[item.id] = {
              trackId: item.existing.id, stage: item.existing.stage, progress: 0,
              error: item.existing.stage === "failed" ? "Couldn’t add this song." : null,
            };
          }
          return next;
        });
      }).catch((error: unknown) => {
        if (searchResponseIsCurrent(normalized, input.current?.value.trim().slice(0, 100) ?? "", controller.signal.aborted) &&
            generation === requestGeneration.current) setExternal({ query: normalized, items: [], loading: false,
          error: error instanceof Error ? error.message : "The music catalog could not be reached." });
      });
    }, 300);
    return () => { controller.abort(); window.clearTimeout(localTimer); window.clearTimeout(externalTimer); };
  }, [normalized, retry, hydratePlayable]);

  useEffect(() => {
    const active = externalItems.filter((item) => {
      const request = requests[item.id];
      return request && request.stage !== "failed" && !playable[request.trackId] &&
        (request.stage === "ready" || request.stage === "analyzing");
    });
    if (!active.length) return;
    const timer = window.setInterval(() => {
      for (const item of active) {
        const request = requests[item.id];
        if (request) void hydratePlayable(request.trackId);
      }
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [externalItems, hydratePlayable, playable, requests]);

  useRealtime((event) => {
    if (event.type !== "track") return;
    const track = event.data;
    setRequests((current) => {
      const matches = Object.entries(current).filter(([, request]) => request.trackId === track.id);
      if (!matches.length) return current;
      const next = { ...current };
      for (const [recordingId] of matches) next[recordingId] = {
        trackId: track.id, stage: track.stage, progress: track.progress,
        error: track.stage === "failed" ? "Couldn’t add this song." : null,
      };
      return next;
    });
    if (track.stage === "ready" || track.stage === "analyzing") void hydratePlayable(track.id);
  });

  const addToLibrary = async (item: RecordingResult, youtubeUrl?: string) => {
    if (requests[item.id] && requests[item.id]!.stage !== "failed") return;
    setRequests((current) => ({ ...current, [item.id]: { trackId: item.existing?.id ?? "", stage: "matching", progress: 0, error: null } }));
    try {
      const response = await fetch("/api/music/search", { method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ token: item.token, ...(youtubeUrl?.trim() ? { youtubeUrl: youtubeUrl.trim() } : {}) }) });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The request could not be completed.");
      if (typeof body.trackId !== "string" || typeof body.stage !== "string") throw new Error("The request could not be confirmed.");
      setRequests((current) => ({ ...current, [item.id]: { trackId: body.trackId, stage: body.stage, progress: 0, error: null } }));
      if (body.stage === "ready" || body.stage === "analyzing") void hydratePlayable(body.trackId);
    } catch (error) {
      console.error("Search recording request failed", error);
      setRequests((current) => ({ ...current, [item.id]: { trackId: item.existing?.id ?? "", stage: "failed", progress: 0, error: "Couldn’t add this song. Try again." } }));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && event.target === input.current) remember(query);
  };
  const updateQuery = (value: string) => {
    const nextQuery = value.slice(0, 100);
    requestGeneration.current++;
    const next = new URL(window.location.href);
    if (nextQuery) next.searchParams.set("q", nextQuery); else next.searchParams.delete("q");
    window.history.replaceState(window.history.state, "", `${next.pathname}${next.search}${next.hash}`);
    setQuery(nextQuery);
  };
  const retrySearch = () => {
    setLocal({ query: normalized, groups: [], errors: 0, loading: true });
    setExternal({ query: normalized, items: [], loading: true, error: "" });
    requestGeneration.current++;
    setRetry((value) => value + 1);
  };
  const chooseTrack = (item: PlayerItem) => {
    remember(query);
    if (player) void player.command({ action: "play", item });
  };
  const localLoading = normalized.length >= 2 && activeLocal?.loading !== false;
  const externalLoading = normalized.length >= 2 && activeExternal?.loading !== false;
  const isEmpty = !localLoading && !externalLoading && !groups.length && !visibleExternal.length &&
    !activeExternal?.error && !activeLocal?.errors;

  return <div onKeyDown={onKeyDown} className="w-full">
    <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">Search</h1>
    <label className="relative mt-6 block max-w-3xl">
      <span className="sr-only">Search songs, artists or albums</span>
      <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden />
      <input ref={input} type="search" role="searchbox" value={query} maxLength={100}
        onChange={(event) => updateQuery(event.currentTarget.value)} placeholder="Songs, artists or albums"
        className="min-h-14 w-full rounded-full bg-elevated pl-12 pr-5 text-base text-fg placeholder:text-faint ring-1 ring-line outline-none focus-visible:ring-2 focus-visible:ring-mint" />
    </label>
    {!online && <p role="status" className="mt-4 text-sm text-warn">You’re offline. Connect to search and add songs.</p>}

    {!normalized && <>
      {!!recent.length && <section className="mt-7" aria-label="Recent searches"><h2 className="mb-3 text-lg font-bold">Recent searches</h2>
        <ul className="flex flex-wrap gap-2">{recent.map((item) => <li key={item}><button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-full bg-hover px-4 text-sm text-fg hover:bg-line" onClick={() => updateQuery(item)}><Search className="size-4 text-muted" aria-hidden />{item}</button></li>)}</ul>
      </section>}
      <nav className="mt-8" aria-label="Browse all">
        <h2 className="mb-3 text-lg font-bold">Browse all</h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">{browseTiles.map((tile) => <li key={tile.href}>
          <Link href={tile.href} className={`relative flex aspect-[16/10] min-h-24 overflow-hidden rounded-lg p-4 text-lg font-bold text-fg transition hover:brightness-110 ${tile.className}`}>
            {tile.label}<tile.icon className="absolute -bottom-2 -right-2 size-16 rotate-12 opacity-30" aria-hidden />
          </Link>
        </li>)}</ul>
      </nav>
      <div className="mt-12"><DiscoveryShelves seeds={discoverySeeds} /></div>
    </>}

    {normalized.length === 1 && <p className="mt-6 text-sm text-muted">Type at least two characters to search.</p>}
    {normalized.length >= 2 && activeLocal?.errors ? <p role="status" className="mt-5 text-sm text-warn">
      Some library results couldn’t load. <button type="button" className="underline" onClick={retrySearch}>Retry</button>
    </p> : null}
    {normalized.length >= 2 && localLoading && !groups.length && <p role="status" className="mt-6 text-sm text-muted">Searching your library…</p>}
    {!localLoading && !!groups.length && <SearchResults groups={groups} canPlay={!!player} playDisabled={!player?.ready || !!player?.busy}
      onPlay={chooseTrack} onNavigate={() => remember(query)} />}
    {normalized.length >= 2 && <section className="mt-8" aria-labelledby="external-results-heading">
      <h2 id="external-results-heading" className="mb-3 text-xl font-bold">More songs</h2>
      {externalLoading && <p role="status" className="text-sm text-muted">Searching more songs…</p>}
      {activeExternal?.error && <p role="alert" className="text-sm text-warn">
        Couldn’t search more songs. <button type="button" className="underline" onClick={retrySearch}>Retry</button>
      </p>}
      {!externalLoading && !activeExternal?.error && visibleExternal.length > 0 && <ol className="divide-y divide-line">
        {visibleExternal.map((item) => <ExternalRecording key={item.id} item={item}
          request={requests[item.id]} playable={playable[item.existing?.id ?? ""] ?? (requests[item.id] ? playable[requests[item.id]!.trackId] : undefined)}
          busy={!online} playDisabled={!player?.ready || !!player?.busy} onPlay={chooseTrack} onAdd={(youtubeUrl) => void addToLibrary(item, youtubeUrl)} />)}
      </ol>}
      {isEmpty && <p className="text-sm text-muted">No matches. Try another spelling.</p>}
    </section>}
  </div>;
}

function ExternalRecording({ item, request, playable, busy, playDisabled, onPlay, onAdd }: {
  item: RecordingResult; request?: RequestState; playable?: PlayerItem; busy: boolean; playDisabled: boolean;
  onPlay: (item: PlayerItem) => void; onAdd: (youtubeUrl?: string) => void;
}) {
  const current = request ?? (item.existing ? { trackId: item.existing.id, stage: item.existing.stage,
    progress: 0, error: item.existing.stage === "failed" ? "Couldn’t add this song." : null } : undefined);
  const failed = current?.stage === "failed" || !!current?.error;
  const processing = !!current && !failed && !playable;
  const [youtubeUrl, setYoutubeUrl] = useState("");
  return <li className="flex min-h-20 flex-wrap items-center gap-3 py-3">
    <Artwork track={{ artworkUrl: playable?.thumb ?? "" }} className="size-12 shrink-0 rounded" />
    <div className="min-w-0 flex-1">
      <p className="truncate font-semibold">{item.title}</p>
      <p className="truncate text-sm text-muted">{item.artist}{item.album ? ` · ${item.album}` : ""}{item.durationSec ? ` · ${formatDuration(item.durationSec)}` : ""}</p>
      {processing && <p className="mt-1 text-xs text-muted">{current.stage === "ready" || current.stage === "analyzing"
        ? "Checking availability…" : current.progress > 0 ? `Adding · ${Math.round(current.progress * 100)}%` : "Adding to your library…"}</p>}
      {failed && <p role="alert" className="mt-1 text-xs text-warn">Couldn’t add this song.</p>}
    </div>
    {playable ? <button type="button" disabled={playDisabled} onClick={() => onPlay(playable)}
      className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-mint px-4 text-sm font-semibold text-mint-ink disabled:opacity-40">
      <Play className="size-4 fill-current" aria-hidden />Play
    </button> : processing ? <span className="inline-flex min-h-11 shrink-0 items-center gap-2 px-3 text-sm text-muted" role="status">
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />Adding
    </span> : <button type="button" disabled={busy} onClick={() => onAdd()}
      className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-mint px-4 text-sm font-semibold text-mint-ink disabled:opacity-40">
      <ArrowDownToLine className="size-4" aria-hidden />{failed ? "Retry" : "Add to library"}
    </button>}
    {failed && <ReportIssueButton className="min-h-11 rounded-control px-2 text-sm text-muted hover:bg-hover hover:text-fg"
      context={`${item.title} — ${item.artist}`} icon={false} />}
    {!processing && !playable && <details className="basis-full pl-14">
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-muted hover:text-fg">Advanced source option</summary>
      <label className="mt-1 block max-w-lg text-xs text-muted">YouTube video URL
        <input type="url" maxLength={2048} value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)}
          placeholder="https://music.youtube.com/watch?v=…"
          className="mt-2 min-h-11 w-full rounded-control bg-elevated px-3 text-sm text-fg ring-1 ring-line focus-visible:ring-2 focus-visible:ring-mint" />
      </label>
      <button type="button" disabled={busy || !youtubeUrl.trim()} onClick={() => onAdd(youtubeUrl)}
        className="mt-2 inline-flex min-h-11 items-center rounded-full bg-elevated px-4 text-sm font-semibold text-fg ring-1 ring-line hover:bg-hover disabled:opacity-40">
        Add using this source
      </button>
    </details>}
  </li>;
}

const albumHref = (id: string) => `/app/library/albums/${encodeURIComponent(id)}`;
const artistHref = (id: string) => `/app/library/artists/${encodeURIComponent(id)}`;

function topResult(groups: ResultGroup[]) {
  const artist = groups.find((group) => group.type === "artist")?.items[0];
  const track = groups.find((group) => group.type === "track")?.items[0];
  const album = groups.find((group) => group.type === "album")?.items[0];
  return artist ?? track ?? album ?? null;
}

function SearchResults({ groups, canPlay, playDisabled, onPlay, onNavigate }: {
  groups: ResultGroup[]; canPlay: boolean; playDisabled: boolean;
  onPlay: (item: PlayerItem) => void; onNavigate: () => void;
}) {
  const top = topResult(groups);
  const songs = groups.find((group) => group.type === "track")?.items.slice(0, 6) ?? [];
  const artists = groups.find((group) => group.type === "artist")?.items ?? [];
  const albums = groups.find((group) => group.type === "album")?.items ?? [];
  const typeLabel = (item: PlayerItem) => item.type === "artist" ? "Artist" : item.type === "album" ? "Album" : "Song";
  return <>
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
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
          <span className="relative shrink-0"><Artwork track={{ artworkUrl: item.thumb ?? "" }} className="size-10 rounded" /></span>
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

function CardShelf({ label, items, round = false, canMenu, onNavigate }: {
  label: string; items: PlayerItem[]; round?: boolean; canMenu: boolean; onNavigate: () => void;
}) {
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
