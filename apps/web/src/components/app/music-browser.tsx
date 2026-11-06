"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowDownCircle, ChevronLeft, ChevronRight, Clock3, Play, Search, Shuffle, Volume2, X } from "lucide-react";
import { Artwork, ArtworkAtmosphere } from "@/components/artwork";
import { artistPlayerId, type CatalogPage, type PlayerCollection, type PlayerItem } from "@/lib/player-protocol";
import { collectionFromParams, collectionParams, fetchCatalog, metadataFilterKeys } from "@/lib/browser-catalog";
import { formatDuration } from "@/lib/format";
import { CollectionActions } from "./collection-actions";
import { TrackMenuButton, usePlayer } from "./player";
import { AlbumLink, ArtistLink } from "./music-links";
import { MusicItem } from "./music-item";

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
  if (item.type === "playlist") return `/app/collection/${encodeURIComponent(item.id)}`;
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
  const [identity, setIdentity] = useState<{ key: string; page?: CatalogPage; error?: string } | null>(null);
  const identityKey = initialCollection ? collectionParams(initialCollection).toString() : "";
  useEffect(() => {
    if (!identityKey) return;
    const controller = new AbortController();
    const query = new URLSearchParams(identityKey);
    query.set("type", initialCollection?.kind === "artist" ? "artist" : "track");
    query.set("size", initialCollection?.kind === "artist" ? "1" : "4");
    void fetchCatalog(query, controller.signal).then((page) => {
      if (!controller.signal.aborted) setIdentity({ key: identityKey, page });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setIdentity({ key: identityKey, error: error instanceof Error ? error.message : "Collection artwork could not load." });
    });
    return () => controller.abort();
  }, [identityKey, initialCollection?.kind]);
  const page = result?.key === key ? result.page : undefined;
  const error = result?.key === key ? result.error : undefined;
  const valid = collection !== null;
  const listing = collection?.kind !== "library" || Boolean(q.trim()) || pathname === "/app/library";
  const metadataStatus = page?.artistProfile?.status ?? identity?.page?.artistProfile?.status;
  useEffect(() => {
    if (collection?.kind !== "artist" || (metadataStatus !== "queued" && metadataStatus !== "fetching")) return;
    const timer = setTimeout(() => setRetry((value) => value + 1), 15_000);
    return () => clearTimeout(timer);
  }, [collection?.kind, metadataStatus, key]);

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
  const activeFilters = metadataFilterKeys.flatMap((filter) => {
    const value = params.get(filter);
    return value ? [{ filter, value }] : [];
  });
  if (!collection) return <div role="alert" className="py-12"><h1 className="text-3xl font-bold">This collection link isn&apos;t valid.</h1><Link href="/app/library" className="mt-4 inline-block text-mint underline">Open your library</Link></div>;
  if (!listing) return <div className="mx-auto max-w-4xl py-5">
    <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">Find your next song.</h1>
    <p className="my-5 max-w-xl text-sm leading-relaxed text-muted">Search your library and the wider music catalog.</p>
    <div className="flex flex-wrap gap-3 text-sm font-semibold">
      <Link href="/app/search" className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-mint-ink hover:bg-mint-strong">Open Search</Link>
      <Link href="/app/library" className="inline-flex min-h-11 items-center text-muted hover:text-fg">Browse your library</Link>
    </div>
  </div>;
  const detail = identity?.key === identityKey ? identity.page : undefined;
  const first = detail?.items[0] ?? page?.items[0];
  const title = collection.kind === "album" ? detail?.title ?? first?.album ?? "Album"
    : collection.kind === "artist" ? detail?.title ?? first?.artist ?? "Artist"
    : collection.kind === "liked" ? "Liked songs"
    : collection.kind === "playlist" ? page?.title ?? "Playlist"
    : pathname === "/app/library" ? "Library" : "Your music";
  const itemCount = collection.kind === "artist" ? page?.total : detail?.total;
  const artistProfile = page?.artistProfile ?? detail?.artistProfile;
  const albumMinutes = collection.kind === "album" && page && !q && start === 0 && page.items.length >= page.total && page.items.every((item) => item.duration)
    ? Math.round(page.items.reduce((sum, item) => sum + (item.duration ?? 0), 0) / 60_000) : null;
  const tabs = kinds.filter((kind) => collection.kind === "library" ? kind !== "playlist" : collection.kind === "artist" ? kind === "album" || kind === "track" : kind === "track");
  const countLabel = (count: number, kind: Kind) => `${count.toLocaleString()} ${count === 1 ? labels[kind].slice(0, -1).toLocaleLowerCase() : labels[kind].toLocaleLowerCase()}`;
  return <div className="mx-auto max-w-[100rem]">
    {collection.kind !== "library" && <Link href="/app/library" className="mb-4 inline-flex min-h-11 items-center gap-1 text-sm text-muted hover:text-fg"><ChevronLeft className="size-4" aria-hidden />All music</Link>}
    {identity?.key === identityKey && identity.error && <p role="status" className="mb-4 text-sm text-warn">Artwork and details could not load. {identity.error} Reopen this page to retry.</p>}
    {collection.kind === "library" ? <header className="mb-6">
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">All music</h1>
    </header> : <header className={collection.kind === "artist" ? "artist-hero mb-6" : "collection-hero music-atmosphere mb-6"}>
      {collection.kind === "album" && <ArtworkAtmosphere src={first?.thumb} />}
      {collection.kind === "album" && <div className="collection-hero-art">
        <Artwork track={{ artworkUrl: first?.thumb ?? "" }} eager className="h-full w-full rounded-none" />
      </div>}
      {collection.kind === "artist" && <div className="artist-hero-art" aria-hidden="true">
        <Artwork track={{ artworkUrl: detail?.items[0]?.thumb ?? "" }} eager className="h-full w-full rounded-none" />
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/65 to-transparent" />
      </div>}
      <div className="min-w-0">
        <h1 className="break-words text-4xl font-extrabold tracking-tight sm:text-6xl">{title}</h1>
        <p className={`mt-4 flex flex-wrap items-center gap-x-1.5 text-sm tabular ${collection.kind === "artist" ? "text-fg/80" : "text-muted"}`}>
          {collection.kind === "album" && first && <span className="font-semibold text-fg"><ArtistLink item={first} /></span>}
          {itemCount !== undefined && <span>{collection.kind === "album" && first ? "• " : ""}{countLabel(itemCount, collection.kind === "artist" ? type : "track")}</span>}
          {albumMinutes !== null && albumMinutes > 0 && <span>, {albumMinutes.toLocaleString()} min</span>}
        </p>
      </div>
    </header>}
    {collection.kind !== "library" && <ActionBar collection={collection} title={title} first={first} empty={!first} />}
    {collection.kind === "artist" && type === "album" && <ArtistSongs collection={collection} onSeeAll={() => change({ type: "track" })} />}
    <div className="mb-5 flex flex-wrap items-center gap-3">
      {collection.kind === "artist" && <h2 className="mr-2 text-2xl font-bold">{type === "track" ? "All songs" : "Albums"}</h2>}
      {collection.kind === "album" && <h2 className="sr-only">Songs</h2>}
      {tabs.length > 1 && <nav aria-label={collection.kind === "library" ? "Library categories" : "Artist categories"} className="flex flex-wrap gap-2">
        {tabs.map((kind) =>
          <button key={kind} type="button" aria-pressed={type === kind} onClick={() => change({ type: kind })}
            className={`min-h-11 rounded-full px-4 text-sm font-semibold transition-colors ${type === kind ? "bg-fg text-bg" : "bg-elevated text-fg hover:bg-hover"}`}>{labels[kind]}</button>)}
      </nav>}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {type !== "playlist" && <CatalogSearch key={`${collection.kind}:${"id" in collection ? collection.id : ""}:${type}:${pathname}`} query={q}
          label={collection.kind === "album" ? "Search in album" : collection.kind === "artist" ? "Search in artist" : "Search all music"} />}
        {type !== "playlist" && <label className="flex min-h-11 items-center gap-2 text-sm text-muted"><span className="sr-only sm:not-sr-only">Sort</span>
          <select aria-label="Sort library" value={sort} onChange={(event) => change({ sort: event.target.value })} className="min-h-11 rounded-full bg-elevated px-3 text-sm text-fg ring-1 ring-line focus-visible:ring-mint">
            <option value="artist">Artist</option><option value="title">Title</option><option value="album">Album</option><option value="newest">Recently added</option>
          </select>
        </label>}
      </div>
    </div>
    {collection.kind === "library" && type !== "playlist" && <div className="mb-5"><CollectionActions collection={{ ...collection, query: q }} empty={!page?.items.length} label={q ? "results" : "all"} title={q ? `Results for ${q}` : undefined} /></div>}
    {collection.kind === "library" && type !== "playlist" && <details className="mb-6 rounded-lg bg-surface px-4 py-3">
      <summary className="cursor-pointer text-sm font-semibold">Filters{activeFilters.length ? ` · ${activeFilters.length} active` : ""}</summary>
      <form key={metadataFilterKeys.map((key) => params.get(key) ?? "").join(":")} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => {
        event.preventDefault(); const values = new FormData(event.currentTarget);
        change(Object.fromEntries(metadataFilterKeys.map((key) => [key, String(values.get(key) ?? "").trim()])));
      }}>
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
    {collection.kind === "library" && activeFilters.length > 0 && <div role="group" aria-label="Active library filters" className="mb-6 flex flex-wrap items-center gap-2">
      <span className="mr-1 text-sm text-muted">Filtered by</span>
      {activeFilters.map(({ filter, value }) => {
        const label = {
          artist: "Artist",
          album: "Album",
          codec: "Codec",
          minYear: "Year from",
          maxYear: "Year through",
          genre: "Genre",
          mood: "Mood",
          minBpm: "BPM from",
          maxBpm: "BPM through",
          camelotKey: "Key",
          vocalType: "Vocal type",
        }[filter];
        const displayValue = filter === "vocalType" ? value.replace("-", " ") : value;
        return <button key={filter} type="button" aria-label={`Remove ${label} filter: ${displayValue}`}
          onClick={() => change({ [filter]: "" })}
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-3 text-sm text-fg hover:bg-hover focus-visible:outline-action">
          <span>{label}: {displayValue}</span><X className="size-4 text-muted" aria-hidden />
        </button>;
      })}
      <button type="button" onClick={() => change(Object.fromEntries(metadataFilterKeys.map((key) => [key, ""])))} className="min-h-11 px-2 text-sm text-muted underline underline-offset-4 hover:text-fg">
        Clear all
      </button>
    </div>}
    {page && page.items.length > 0 && <p role="status" aria-live="polite" className="mb-3 text-sm text-muted tabular">
      {page.total > page.items.length ? `${(start + 1).toLocaleString()}–${Math.min(start + page.items.length, page.total).toLocaleString()} of ${page.total.toLocaleString()} ${labels[type].toLocaleLowerCase()}` : countLabel(page.total, type)}
    </p>}
    {error ? <div role="alert" className="py-8"><p className="max-w-prose text-warn">{online ? error : "You’re offline. Browsing needs a connection; downloaded songs are still in Your Library → Downloads."}</p><div className="mt-4 flex flex-wrap gap-3"><button type="button" className="min-h-11 rounded-full bg-elevated px-5 hover:bg-hover" onClick={() => setRetry((n) => n + 1)}>Try again</button>{!online && <Link href="/app/collection?tab=downloads" className="inline-flex min-h-11 items-center rounded-full border border-line px-5 text-sm font-semibold hover:bg-hover">Open Downloads</Link>}</div></div>
      : !page ? <p role="status" className="py-12 text-muted">Loading…</p>
      : !page.items.length ? <div className="py-12"><h2 className="text-xl font-semibold">{q ? `No results for “${q}”` : "Nothing here yet"}</h2><p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">
        {q ? "Check the spelling, or try fewer words."
          : collection.kind === "album" ? "No songs from this album are available yet."
          : collection.kind === "artist" ? `No ${type === "track" ? "songs" : "albums"} from this artist are available yet.`
          : activeFilters.length ? "No music matches these filters."
          : "Music appears here as it’s added."}
      </p>{q ? <Link href={`/app/search?q=${encodeURIComponent(q)}`} className="mt-4 inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong">Search all music</Link>
        : <div className="mt-5 flex flex-wrap gap-3"><Link href="/app" className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong">Go to Home</Link><Link href="/app/collection" className="inline-flex min-h-11 items-center rounded-full border border-line px-5 text-sm font-semibold hover:bg-hover">Your Library</Link></div>}</div>
      : type === "track" ? <CatalogTracks items={page.items} collection={collection} offset={start} album={collection.kind === "album"} />
      : <div className="grid grid-cols-2 gap-x-2 gap-y-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-7">{page.items.map((item) => <CollectionCard key={item.id} item={item} />)}</div>}
    {page && page.total > 100 && <nav aria-label="Library pages" className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-sm">
      <div className="flex gap-2">
        <button type="button" disabled={!start} onClick={() => change({ start: String(Math.max(0, start - 100)) })} className="inline-flex min-h-11 items-center rounded-full bg-elevated px-4 hover:bg-hover disabled:opacity-40"><ChevronLeft className="mr-1 size-4" aria-hidden />Previous</button>
        <button type="button" disabled={start + page.items.length >= page.total} onClick={() => change({ start: String(start + 100) })} className="inline-flex min-h-11 items-center rounded-full bg-elevated px-4 hover:bg-hover disabled:opacity-40">Next<ChevronRight className="ml-1 size-4" aria-hidden /></button>
      </div>
    </nav>}
    {collection.kind === "artist" && <ArtistAbout artistProfile={artistProfile} name={title} />}
  </div>;
}

function CatalogSearch({ query, label }: { query: string; label: string }) {
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
  return <label className="relative block w-full min-w-0 sm:w-64">
    <span className="sr-only">{label}</span>
    <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
    <input type="search" maxLength={100} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={label}
      className="h-11 w-full rounded-full bg-elevated pl-10 pr-4 text-sm placeholder:text-faint outline-none focus:ring-2 focus:ring-mint" />
  </label>;
}

function ActionBar({ collection, title, first, empty }: { collection: PlayerCollection; title: string; first?: PlayerItem; empty: boolean }) {
  const player = usePlayer();
  if (!player) return null;
  const noun = collection.kind === "artist" ? "artist" : "album";
  const disabled = !player.ready || player.busy || empty;
  const download = collectionParams(collection);
  download.set("tab", "downloads"); download.set("title", title);
  return <div className="mb-8 flex items-center gap-3">
    <button type="button" aria-label={`Play ${noun}`} aria-busy={player.busy} disabled={disabled}
      onClick={() => player.command({ action: "collection", collection, shuffle: false })}
      className="grid size-14 place-items-center rounded-full bg-mint text-mint-ink shadow-floating transition-transform hover:scale-105 hover:bg-mint-strong disabled:cursor-not-allowed disabled:opacity-40">
      <Play className="size-6" fill="currentColor" aria-hidden />
    </button>
    <button type="button" aria-label={`Shuffle ${noun}`} disabled={disabled}
      onClick={() => player.command({ action: "collection", collection, shuffle: true })}
      className="grid size-11 place-items-center rounded-full text-muted hover:text-fg disabled:opacity-40"><Shuffle className="size-6" aria-hidden /></button>
    <Link href={`/app/collection?${download}`} aria-label={`Download ${noun}`} aria-disabled={empty || undefined}
      className={`grid size-11 place-items-center rounded-full text-muted hover:text-fg ${empty ? "pointer-events-none opacity-40" : ""}`}><ArrowDownCircle className="size-6" aria-hidden /></Link>
    {first && <TrackMenuButton item={{ id: collection.kind === "album" || collection.kind === "artist" ? collection.id : first.id, type: collection.kind === "artist" ? "artist" : "album", title, artist: first.artist, artistId: first.artistId, thumb: first.thumb }} />}
    {player.busy && <span role="status" className="text-sm text-muted">Loading…</span>}
  </div>;
}

function ArtistSongs({ collection, onSeeAll }: { collection: PlayerCollection; onSeeAll: () => void }) {
  const key = collectionParams(collection).toString();
  const [state, setState] = useState<{ key: string; page?: CatalogPage; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams(key);
    query.set("type", "track"); query.set("size", "5"); query.set("start", "0");
    void fetchCatalog(query, controller.signal).then((page) => {
      if (!controller.signal.aborted) setState({ key, page });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : "Songs could not load." });
    });
    return () => controller.abort();
  }, [key]);
  const current = state?.key === key ? state : null;
  if (current?.error) return <p role="status" className="mb-8 text-sm text-warn">Songs could not load. {current.error}</p>;
  if (!current?.page?.items.length) return null;
  return <section aria-labelledby="artist-songs" className="mb-10">
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h2 id="artist-songs" className="text-2xl font-bold">Songs</h2>
      {current.page.total > current.page.items.length && <button type="button" onClick={onSeeAll} className="min-h-11 text-sm font-semibold text-muted hover:text-fg hover:underline">
        Show all {current.page.total.toLocaleString()}
      </button>}
    </div>
    <CatalogTracks items={current.page.items} collection={collection} offset={0} compact />
  </section>;
}

type ArtistProfile = NonNullable<CatalogPage["artistProfile"]>;

function ArtistAbout({ artistProfile, name }: { artistProfile?: ArtistProfile | null; name: string }) {
  const profile = artistProfile?.profile;
  const metadataPending = !artistProfile || artistProfile.status === "queued" || artistProfile.status === "fetching";
  return <section aria-labelledby="artist-about" className="mt-12 max-w-3xl">
    <h2 id="artist-about" className="mb-4 text-2xl font-bold">About</h2>
    <div className="space-y-3 rounded-lg bg-surface p-5 sm:p-6">
      {metadataPending && <p role="status" className="text-sm text-muted">Getting details about {name}…</p>}
      {artistProfile?.status === "ambiguous" && <p className="text-sm text-muted">We couldn&apos;t confidently match this name to one artist.</p>}
      {artistProfile?.status === "not_found" && <p className="text-sm text-muted">No details found for this artist yet.</p>}
      {artistProfile?.status === "failed" && <p role="status" className="text-sm text-warn">Artist details could not be refreshed. We&apos;ll retry in the background.</p>}
      {profile && <>
        {(profile.artistType || profile.area || artistProfile?.musicBrainzArtistId) && <p className="text-sm text-muted">
          {[profile.artistType, profile.area].filter(Boolean).join(" · ")}
          {artistProfile?.musicBrainzArtistId && <>{profile.artistType || profile.area ? " · " : ""}<a href={`https://musicbrainz.org/artist/${artistProfile.musicBrainzArtistId}`} target="_blank" rel="noreferrer" className="underline hover:text-fg">MusicBrainz</a></>}
        </p>}
        {(profile.listenCount !== null || profile.listenerCount !== null) && <p className="text-sm text-fg/90 tabular">
          <span className="font-semibold">{profile.listenerCount?.toLocaleString() ?? "—"}</span> listeners · {profile.listenCount?.toLocaleString() ?? "—"} listens
          <span className="text-muted"> on <a href={`https://listenbrainz.org/artist/${artistProfile?.musicBrainzArtistId}`} target="_blank" rel="noreferrer" className="underline hover:text-fg">ListenBrainz</a></span>
        </p>}
        {profile.biography && <p className="text-sm leading-relaxed text-fg/90">{profile.biography}
          {profile.biographyUrl && <> <a href={profile.biographyUrl} target="_blank" rel="noreferrer" className="whitespace-nowrap font-semibold underline">Wikipedia source</a></>}
        </p>}
        {profile.biography && <p className="text-xs text-faint">Biography summary by Wikipedia contributors, shared under CC BY-SA. <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer" className="underline">License</a></p>}
        {profile.unavailableSources.length > 0 && <p className="text-xs text-faint">Some sources could not be reached: {profile.unavailableSources.join(", ")}.</p>}
        {artistProfile?.fetchedAt && <p className="text-xs text-faint">Updated {new Date(artistProfile.fetchedAt).toLocaleDateString()}</p>}
      </>}
    </div>
    {!!profile?.relatedArtists.length && <div className="mt-8">
      <h2 className="mb-3 text-2xl font-bold">Related artists</h2>
      <ul className="flex flex-wrap gap-2">
        {profile.relatedArtists.map((related) => <li key={related.musicBrainzArtistId}>
          <Link href={`/app/library/artists/${encodeURIComponent(artistPlayerId(related.name))}?type=album`}
            className="inline-flex min-h-11 items-center rounded-full bg-elevated px-4 text-sm font-semibold text-fg hover:bg-hover">
            {related.name}
          </Link>
        </li>)}
      </ul>
    </div>}
  </section>;
}

function CollectionCard({ item }: { item: PlayerItem }) {
  const player = usePlayer()!;
  return <MusicItem as="article" item={item} className="group relative min-w-0 rounded-lg p-3 transition-colors hover:bg-surface focus-within:bg-surface">
    <div className="relative">
      <Link href={itemHref(item)} className="block rounded-md" aria-label={item.title}>
        <Artwork track={{ artworkUrl: item.thumb ?? "" }} className={`w-full shadow-raised ${item.type === "artist" ? "rounded-full" : "rounded-md"}`} />
      </Link>
      <button type="button" aria-label={`Play ${item.title}`} disabled={!player.ready || player.busy} onClick={() => player.command({ action: "play", item })}
        className="absolute bottom-2 right-2 grid size-12 place-items-center rounded-full bg-mint text-mint-ink shadow-floating transition hover:scale-105 focus-visible:opacity-100 disabled:opacity-40 sm:translate-y-2 sm:opacity-0 sm:group-hover:translate-y-0 sm:group-hover:opacity-100 sm:group-focus-within:translate-y-0 sm:group-focus-within:opacity-100"><Play className="size-5" fill="currentColor" aria-hidden /></button>
    </div>
    <div className="mt-3 flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-semibold"><Link href={itemHref(item)} tabIndex={-1} className="hover:underline">{item.title}</Link></h3>
        <p className="mt-1 truncate text-sm text-muted">{item.type === "artist" ? "Artist" : <ArtistLink item={item} />}</p>
      </div>
      <TrackMenuButton item={item} />
    </div>
  </MusicItem>;
}

function CatalogTracks({ items, collection, offset, album = false, compact = false }: { items: PlayerItem[]; collection: PlayerCollection; offset: number; album?: boolean; compact?: boolean }) {
  const player = usePlayer()!;
  const columns = album || compact ? "grid-cols-[2.5rem_minmax(0,1fr)_auto]" : "grid-cols-[2.5rem_minmax(0,1fr)_auto] md:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_auto]";
  return <div>
    {!compact && <div className={`hidden gap-3 border-b border-line px-3 pb-2 text-xs font-medium text-faint sm:grid ${columns}`}>
      <span className="text-center">#</span><span>Title</span>{!album && <span className="hidden md:block">Album</span>}<Clock3 className="ml-auto mr-12 size-4" aria-label="Duration" />
    </div>}
    <ol className="mt-2">{items.map((item, index) => {
      const current = player.state.track?.id === item.id;
      const play = () => player.command({ action: "collection", collection, id: item.id, occurrenceId: item.occurrenceId, shuffle: false });
      return <MusicItem as="li" item={item} key={item.occurrenceId ?? item.id} className={`group grid ${columns} min-h-14 items-center gap-3 rounded-md px-3 py-1.5 hover:bg-hover/70 focus-within:bg-hover/70`}>
        <button type="button" aria-label={`Play ${item.title}`} disabled={!player.ready || player.busy} onClick={play}
          className="grid size-10 place-items-center rounded-full text-sm text-muted tabular hover:text-fg disabled:opacity-40">
          <span aria-hidden className={`group-hover:hidden group-focus-within:hidden ${current ? "text-mint" : ""}`}>{current ? <Volume2 className="size-4" /> : offset + index + 1}</span>
          <Play className="hidden size-4 text-fg group-hover:block group-focus-within:block" fill="currentColor" aria-hidden />
        </button>
        <div className="flex min-w-0 items-center gap-3">
          {!album && <Artwork track={{ artworkUrl: item.thumb ?? "" }} className="size-10 shrink-0 rounded" />}
          <div className="min-w-0"><button type="button" tabIndex={-1} disabled={!player.ready || player.busy} onClick={play} className={`block max-w-full truncate text-left font-medium hover:underline disabled:opacity-40 ${current ? "text-mint" : "text-fg"}`}>{item.title}</button><p className="truncate text-sm text-muted"><ArtistLink item={item} /></p></div>
        </div>
        {!album && !compact && <p className="hidden truncate text-sm text-muted md:block"><AlbumLink item={item} /></p>}
        <div className="flex items-center justify-end gap-1 text-sm text-muted tabular"><span className="w-12 text-right">{formatDuration((item.duration ?? 0) / 1000)}</span><TrackMenuButton item={item} /></div>
      </MusicItem>;
    })}</ol>
  </div>;
}
