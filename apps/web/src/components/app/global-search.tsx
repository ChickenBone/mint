"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import Link from "next/link";
import { CirclePlus, Disc3, Heart, ListMusic, Loader2, MicVocal, MoreHorizontal, Play, RotateCcw, Search, TrendingUp } from "lucide-react";
import type { TrackView } from "@mint/core/events";
import { Artwork } from "@/components/artwork";
import { Dialog } from "@/components/ui/interactive";
import { ReportIssueButton } from "@/components/app/report-issue";
import { fetchCatalog } from "@/lib/browser-catalog";
import { formatDuration } from "@/lib/format";
import type { RecordingSearchItem } from "@/lib/music-requests";
import { playerItemSchema, type PlayerItem } from "@/lib/player-protocol";
import { recordingsOutsideTop, searchResponseIsCurrent, topSearchResult, uniqueExternalResults } from "@/lib/unified-search";
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
  { label: "Charts", href: "#charts", icon: TrendingUp, className: "bg-warn/20" },
];
const emptyRecent: string[] = [];

/** Requests a signed catalog recording; `like` also saves it to Liked songs so it appears there while importing. */
export async function requestCatalogRecording(token: string, youtubeUrl?: string, like = false) {
  const response = await fetch("/api/music/search", { method: "POST", cache: "no-store", credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, ...(youtubeUrl?.trim() ? { youtubeUrl: youtubeUrl.trim() } : {}), ...(like ? { like: true } : {}) }) });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The request could not be completed.");
  if (typeof body.trackId !== "string" || typeof body.stage !== "string") throw new Error("The request could not be confirmed.");
  return body as { trackId: string; stage: string };
}
type ResultGroup = { label: string; type: "track" | "artist" | "album"; items: PlayerItem[] };
type LocalResult = { query: string; groups: ResultGroup[]; errors: number; loading: boolean };
type RecordingResult = RecordingSearchItem;
type TopCandidate = Pick<PlayerItem, "title" | "artist" | "type"> & (
  { source: "library" | "catalog-artist"; item: PlayerItem } | { source: "recording"; recording: RecordingResult }
);
type CatalogArtist = { id: string; name: string };
type ExternalResult = { query: string; items: RecordingResult[]; artists: CatalogArtist[]; loading: boolean; error: string };
export type RequestState = { trackId: string; stage: string; progress: number; error: string | null; liked?: boolean };
const emptyArtists: CatalogArtist[] = [];
const emptyGroups: ResultGroup[] = [];
const emptyRecordings: RecordingResult[] = [];
const resultFilters = ["All", "Songs", "Artists", "Albums"] as const;
type ResultFilter = typeof resultFilters[number];
const songRowClass = "group flex min-h-16 items-center gap-3 rounded-control px-2 py-2 hover:bg-hover focus-within:bg-hover";
const songActionClass = "grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-line hover:text-fg focus-visible:outline-2 focus-visible:outline-mint disabled:opacity-40";
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
  const [filter, setFilter] = useState<ResultFilter>("All");
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
        if (body.catalog?.status === "unavailable") throw new Error("The music catalog is unavailable right now. Try again shortly.");
        if (body.catalog?.status === "not_configured") throw new Error("This server has no music catalog configured.");
        const artists = Array.isArray(body.artists) ? (body.artists as unknown[]).filter((artist): artist is CatalogArtist =>
          !!artist && typeof artist === "object" && typeof (artist as CatalogArtist).id === "string" && typeof (artist as CatalogArtist).name === "string") : [];
        return { items: body.items as RecordingResult[], artists };
      }).then(({ items, artists }) => {
        if (!searchResponseIsCurrent(normalized, input.current?.value.trim().slice(0, 100) ?? "", controller.signal.aborted) ||
            generation !== requestGeneration.current) return;
        setExternal({ query: normalized, items, artists, loading: false, error: "" });
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
            generation === requestGeneration.current) setExternal({ query: normalized, items: [], artists: [], loading: false,
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
      for (const [recordingId, request] of matches) next[recordingId] = {
        trackId: track.id, stage: track.stage, progress: track.progress, liked: request.liked,
        error: track.stage === "failed" ? "Couldn’t add this song." : null,
      };
      return next;
    });
    if (track.stage === "ready" || track.stage === "analyzing") void hydratePlayable(track.id);
  });

  const addToLibrary = async (item: RecordingResult, youtubeUrl?: string, like = false) => {
    const previous = requests[item.id];
    if (previous && previous.stage !== "failed" && (!like || previous.liked)) return;
    setRequests((current) => ({ ...current, [item.id]: { trackId: previous?.trackId || item.existing?.id || "",
      stage: previous && previous.stage !== "failed" ? previous.stage : "matching", progress: previous?.progress ?? 0, error: null, liked: like || previous?.liked } }));
    try {
      const body = await requestCatalogRecording(item.token, youtubeUrl, like);
      setRequests((current) => ({ ...current, [item.id]: { trackId: body.trackId, stage: body.stage, progress: 0, error: null, liked: like || previous?.liked } }));
      if (body.stage === "ready" || body.stage === "analyzing") void hydratePlayable(body.trackId);
    } catch (error) {
      console.error("Search recording request failed", error);
      setRequests((current) => ({ ...current, [item.id]: { trackId: item.existing?.id ?? "", stage: "failed", progress: 0,
        error: "Couldn’t add this song. Try again.", liked: previous?.liked } }));
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
    setExternal({ query: normalized, items: [], artists: [], loading: true, error: "" });
    requestGeneration.current++;
    setRetry((value) => value + 1);
  };
  const chooseTrack = (item: PlayerItem) => {
    remember(query);
    if (player) void player.command({ action: "play", item });
  };
  const localLoading = normalized.length >= 2 && activeLocal?.loading !== false;
  const externalLoading = normalized.length >= 2 && activeExternal?.loading !== false;
  const isEmpty = !localLoading && !externalLoading && !groups.length && !visibleExternal.length && !activeExternal?.artists.length &&
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
    {normalized.length >= 2 && <nav aria-label="Search filters" className="mt-5 flex gap-2 overflow-x-auto">
      {resultFilters.map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}
        className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-mint ${filter === value
          ? "bg-fg text-bg" : "bg-elevated text-fg hover:bg-hover"}`}>{value}</button>)}
    </nav>}
    {normalized.length >= 2 && activeLocal?.errors ? <p role="status" className="mt-5 text-sm text-warn">
      Some library results couldn’t load. <button type="button" className="underline" onClick={retrySearch}>Retry</button>
    </p> : null}
    {normalized.length >= 2 && <>
      <SearchResults groups={groups} recordings={visibleExternal} requests={requests} playable={playable} filter={filter}
        query={normalized} localLoading={localLoading} catalogArtists={activeExternal?.artists ?? emptyArtists}
        canPlay={!!player} playDisabled={!player?.ready || !!player?.busy} offline={!online}
        onPlay={chooseTrack} onNavigate={() => remember(query)} onAdd={(item, youtubeUrl, like) => void addToLibrary(item, youtubeUrl, like)} />
      {(localLoading || externalLoading) && <p role="status" className="mt-5 text-sm text-muted">Searching music…</p>}
      {activeExternal?.error && <p role="alert" className="mt-5 text-sm text-warn">
        Some songs couldn’t load. <button type="button" className="underline" onClick={retrySearch}>Retry</button>
      </p>}
      {isEmpty && <p className="mt-6 text-sm text-muted">No matches. Try another spelling.</p>}
      {!localLoading && !externalLoading && !isEmpty && !activeLocal?.errors &&
        (filter !== "Songs" || !activeExternal?.error) && filter !== "All" &&
        (filter === "Songs" ? !catalogMatches.length && !visibleExternal.length :
          !groups.some((group) => group.type === (filter === "Artists" ? "artist" : "album")) &&
          (filter !== "Artists" || !activeExternal?.artists.length)) &&
        <p className="mt-6 text-sm text-muted">No {filter.toLowerCase()} found.</p>}
    </>}
  </div>;
}

export function ExternalRecording({ item, request, playable, busy, playDisabled, onPlay, onAdd }: {
  item: RecordingResult; request?: RequestState; playable?: PlayerItem; busy: boolean; playDisabled: boolean;
  onPlay: (item: PlayerItem) => void; onAdd: (youtubeUrl?: string, like?: boolean) => void;
}) {
  const current = request ?? (item.existing ? { trackId: item.existing.id, stage: item.existing.stage,
    progress: 0, error: item.existing.stage === "failed" ? "Couldn’t add this song." : null } : undefined);
  const failed = current?.stage === "failed" || !!current?.error;
  const processing = !!current && !failed && !playable;
  const liked = !!request?.liked;
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [sourceOpen, setSourceOpen] = useState(false);
  const status = processing ? current.stage === "ready" || current.stage === "analyzing"
    ? "Checking availability…" : current.progress > 0 ? `Adding · ${Math.round(current.progress * 100)}%` : "Adding to your library…" : "";
  return <MusicItem as="li" item={playable ?? null} className={`${songRowClass} flex-wrap`}>
    <Artwork track={{ artworkUrl: playable?.thumb ?? "" }} className="size-12 shrink-0 rounded" />
    <div className="min-w-0 flex-1">
      {playable ? <button type="button" disabled={playDisabled} onClick={() => onPlay(playable)}
        className="block max-w-full truncate text-left font-semibold hover:underline disabled:opacity-40">{item.title}</button>
        : <p className="truncate font-semibold">{item.title}</p>}
      <p className="truncate text-sm text-muted">{item.artist}{item.album ? ` · ${item.album}` : ""}</p>
      {processing && <p className="mt-1 text-xs text-muted">{liked ? `Liked · ${status}` : status}</p>}
      {failed && <p role="alert" className="mt-1 text-xs text-warn">Couldn’t add this song.</p>}
    </div>
    {item.durationSec ? <span className="hidden text-xs tabular-nums text-muted sm:inline">{formatDuration(item.durationSec)}</span> : null}
    {playable ? <button type="button" aria-label={`Play ${item.title}`} disabled={playDisabled} onClick={() => onPlay(playable)}
      className={songActionClass}><Play className="size-4 fill-current" aria-hidden /></button>
      : processing ? <>
        {liked ? <span className="grid size-11 shrink-0 place-items-center text-mint" aria-label={`Liked ${item.title}`} role="img">
          <Heart className="size-4 fill-current" aria-hidden /></span>
          : <button type="button" disabled={busy} onClick={() => onAdd(undefined, true)} aria-label={`Like ${item.title} by ${item.artist}`}
            title="Like" className={songActionClass}><Heart className="size-4" aria-hidden /></button>}
        <span className="grid size-11 shrink-0 place-items-center text-muted" role="status" aria-label={`Adding ${item.title}`}>
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
        </span>
      </> : failed ? <button type="button" disabled={busy} onClick={() => onAdd(undefined, liked)}
        aria-label={`Retry adding ${item.title} by ${item.artist}`} title="Retry adding to library" className={songActionClass}>
        <RotateCcw className="size-4" aria-hidden />
      </button> : <button type="button" disabled={busy} onClick={() => onAdd(undefined, true)}
        aria-label={`Like and add: ${item.title} by ${item.artist}`} title="Like (adds the song to your library)" className={songActionClass}>
        <Heart className="size-4" aria-hidden />
      </button>}
    {playable && <TrackMenuButton item={playable} />}
    {!processing && !playable && <button type="button" aria-label={`Song options: ${item.title}`}
      onClick={() => setSourceOpen(true)} className={songActionClass}>
      <MoreHorizontal className="size-4" aria-hidden />
    </button>}
    <Dialog open={sourceOpen} onOpenChange={setSourceOpen} title={item.title}>
      <button type="button" disabled={busy || processing || !!playable} onClick={() => { onAdd(); setSourceOpen(false); }}
        className="inline-flex min-h-11 items-center gap-2 rounded-full bg-hover px-4 text-sm font-semibold text-fg disabled:opacity-40">
        <CirclePlus className="size-4" aria-hidden /> Import without liking
      </button>
      <p className="mb-3 mt-5 text-sm text-muted">Advanced source option</p>
      <label className="block text-xs text-muted">YouTube video URL
        <input type="url" maxLength={2048} value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)}
          placeholder="https://music.youtube.com/watch?v=…"
          className="mt-2 min-h-11 w-full rounded-control bg-surface px-3 text-sm text-fg ring-1 ring-line focus-visible:ring-2 focus-visible:ring-mint" />
      </label>
      <button type="button" disabled={busy || processing || !!playable || !youtubeUrl.trim()} onClick={() => { onAdd(youtubeUrl); setSourceOpen(false); }}
        className="mt-3 inline-flex min-h-11 items-center rounded-full bg-hover px-4 text-sm font-semibold text-fg disabled:opacity-40">
        Add using this source
      </button>
    </Dialog>
    {failed && <ReportIssueButton className="min-h-11 rounded-control px-2 text-sm text-muted hover:bg-hover hover:text-fg"
      context={`${item.title} — ${item.artist}`} icon={false} />}
  </MusicItem>;
}

const albumHref = (id: string) => `/app/library/albums/${encodeURIComponent(id)}`;
const artistHref = (id: string) => `/app/library/artists/${encodeURIComponent(id)}`;

export function SearchResults({ groups, recordings, requests, playable, filter, query, localLoading, offline, canPlay, playDisabled,
  onPlay, onNavigate, onAdd, catalogArtists = emptyArtists }: {
  groups: ResultGroup[]; canPlay: boolean; playDisabled: boolean; catalogArtists?: CatalogArtist[];
  recordings: RecordingResult[]; requests: Record<string, RequestState>; playable: Record<string, PlayerItem>;
  filter: ResultFilter; query: string; localLoading: boolean; offline: boolean;
  onAdd: (item: RecordingResult, youtubeUrl?: string, like?: boolean) => void;
  onPlay: (item: PlayerItem) => void; onNavigate: () => void;
}) {
  const songs = groups.find((group) => group.type === "track")?.items ?? [];
  const localArtists = groups.find((group) => group.type === "artist")?.items ?? [];
  const localNames = new Set(localArtists.map((item) => item.title.trim().toLowerCase()));
  const catalogOnly = catalogArtists.filter((artist) => !localNames.has(artist.name.trim().toLowerCase()))
    .map((artist): PlayerItem => ({ id: artist.id, type: "artist", title: artist.name }));
  const catalogIds = new Set(catalogOnly.map((item) => item.id));
  const artists = [...localArtists, ...catalogOnly];
  const albums = groups.find((group) => group.type === "album")?.items ?? [];
  const top = filter === "All" && !localLoading ? topSearchResult<TopCandidate>(query, [
    ...groups.flatMap((group) => group.items.map((item): TopCandidate => ({ ...item, source: "library", item }))),
    ...catalogOnly.map((item): TopCandidate => ({ ...item, source: "catalog-artist", item })),
    ...recordings.map((recording): TopCandidate => ({
      type: "track", title: recording.title, artist: recording.artist, source: "recording", recording,
    })),
  ]) : null;
  const topItem = top && top.source !== "recording" ? top.item : null;
  const topRecording = top?.source === "recording" ? top.recording : null;
  const remainingRecordings = recordingsOutsideTop(recordings, topRecording, !!topRecording);
  const typeLabel = (item: PlayerItem) => item.type === "artist" ? "Artist" : item.type === "album" ? "Album" : "Song";
  return <>
    <div className={`mt-6 grid items-start gap-6 ${top ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : ""}`}>
      {top && <section aria-label="Top result">
        <h2 className="mb-3 text-xl font-bold">Top result</h2>
        {topItem ? <MusicItem item={top.source === "library" ? topItem : null} className="group relative flex h-[calc(100%-2.5rem)] min-h-52 flex-col gap-4 rounded-lg bg-elevated p-5 transition hover:bg-hover">
          {topItem.type === "artist" ? <Link href={artistHref(topItem.id)} onClick={onNavigate} aria-label={`Open ${topItem.title}`} tabIndex={-1}>
            <Artwork track={{ artworkUrl: topItem.thumb ?? "" }} className="size-24 rounded-full! shadow-floating" />
          </Link> : <Artwork track={{ artworkUrl: topItem.thumb ?? "" }} className="size-24 rounded-lg shadow-floating" />}
          <div className="min-w-0">
            {topItem.type === "track" ? <button type="button" disabled={playDisabled} onClick={() => onPlay(topItem)} className="block max-w-full truncate text-left text-3xl font-bold tracking-tight hover:underline disabled:opacity-40">{topItem.title}</button>
              : <Link href={topItem.type === "album" ? albumHref(topItem.id) : artistHref(topItem.id)} onClick={onNavigate} className="block truncate text-3xl font-bold tracking-tight hover:underline">{topItem.title}</Link>}
            <p className="mt-2 flex min-w-0 items-center gap-2 text-sm text-muted">
              {topItem.type !== "artist" && <span onClick={onNavigate} className="min-w-0 truncate"><ArtistLink item={topItem} /></span>}
              <span className="shrink-0 rounded-full bg-bg/60 px-3 py-1 text-xs font-semibold text-fg">{typeLabel(topItem)}</span>
            </p>
          </div>
          {topItem.type === "track" && canPlay && <button type="button" aria-label={`Play ${topItem.title}`} disabled={playDisabled} onClick={() => onPlay(topItem)}
            className="absolute bottom-5 right-5 grid size-12 place-items-center rounded-full bg-mint text-mint-ink shadow-floating transition hover:scale-105 disabled:opacity-40"><Play className="size-5 fill-current" aria-hidden /></button>}
          {canPlay && top.source === "library" && <span className="absolute right-3 top-3"><TrackMenuButton item={topItem} /></span>}
        </MusicItem> : topRecording && <ul className="rounded-lg bg-elevated px-5">
          <ExternalRecording item={topRecording} request={requests[topRecording.id]}
            playable={playable[topRecording.existing?.id ?? ""] ?? playable[requests[topRecording.id]?.trackId ?? ""]}
            busy={offline} playDisabled={playDisabled} onPlay={onPlay}
            onAdd={(youtubeUrl, like) => onAdd(topRecording, youtubeUrl, like)} />
        </ul>}
      </section>}
      {(filter === "All" || filter === "Songs") && (!!songs.length || !!remainingRecordings.length) && <section aria-label="Songs" className="min-w-0">
        <h2 className="mb-3 text-xl font-bold">Songs</h2>
        <ul>{songs.map((item) => <MusicItem as="li" item={item} key={item.id} className={songRowClass}>
          <span className="relative shrink-0"><Artwork track={{ artworkUrl: item.thumb ?? "" }} className="size-12 rounded" /></span>
          <div className="min-w-0 flex-1">
            <button type="button" disabled={playDisabled} onClick={() => onPlay(item)} className="block max-w-full truncate text-left font-semibold hover:underline disabled:opacity-40">{item.title}</button>
            <p onClick={onNavigate} className="truncate text-sm text-muted"><ArtistLink item={item} />{item.album ? ` · ${item.album}` : ""}</p>
          </div>
          {item.duration ? <span className="hidden text-xs tabular-nums text-muted sm:inline">{formatDuration(item.duration / 1000)}</span> : null}
          {item !== topItem && canPlay && <button type="button" aria-label={`Play ${item.title}`} disabled={playDisabled} onClick={() => onPlay(item)}
            className={songActionClass}><Play className="size-4 fill-current" aria-hidden /></button>}
          {canPlay && <TrackMenuButton item={item} />}
        </MusicItem>)}
        {remainingRecordings.map((item) => <ExternalRecording key={`recording:${item.id}`} item={item} request={requests[item.id]}
          playable={playable[item.existing?.id ?? ""] ?? playable[requests[item.id]?.trackId ?? ""]}
          busy={offline} playDisabled={playDisabled} onPlay={onPlay} onAdd={(youtubeUrl, like) => onAdd(item, youtubeUrl, like)} />)}
        </ul>
      </section>}
    </div>
    {(filter === "All" || filter === "Artists") && !!artists.length && <CardShelf label="Artists" items={artists} round canMenu={canPlay} catalogIds={catalogIds} onNavigate={onNavigate} />}
    {(filter === "All" || filter === "Albums") && !!albums.length && <CardShelf label="Albums" items={albums} canMenu={canPlay} onNavigate={onNavigate} />}
  </>;
}

function CardShelf({ label, items, round = false, canMenu, catalogIds, onNavigate }: {
  label: string; items: PlayerItem[]; round?: boolean; canMenu: boolean; catalogIds?: Set<string>; onNavigate: () => void;
}) {
  return <section className="mt-8" aria-label={label}>
    <h2 className="mb-3 text-xl font-bold">{label}</h2>
    <ul className="-mx-2 flex snap-x gap-2 overflow-x-auto pb-2">{items.map((item) => <MusicItem as="li" item={catalogIds?.has(item.id) ? null : item} key={item.id}
      className="group relative w-36 shrink-0 snap-start rounded-lg p-2 transition hover:bg-hover sm:w-40">
      <Link href={item.type === "album" ? albumHref(item.id) : artistHref(item.id)} onClick={onNavigate} className="block">
        <Artwork track={{ artworkUrl: item.thumb ?? "" }} className={`aspect-square w-full shadow-floating ${round ? "rounded-full!" : "rounded-lg"}`} />
        <span className="mt-2 block truncate text-sm font-semibold">{item.title}</span>
      </Link>
      <p onClick={onNavigate} className="mt-0.5 truncate text-xs text-muted">{item.type === "artist" ? "Artist" : <ArtistLink item={item} />}</p>
      {canMenu && !catalogIds?.has(item.id) && <span className="absolute right-3 top-3 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"><TrackMenuButton item={item} /></span>}
    </MusicItem>)}</ul>
  </section>;
}
