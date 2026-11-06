"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, Clock3, Play, Search } from "lucide-react";
import { Artwork } from "@/components/artwork";
import { artistPlayerId, type CatalogPage, type PlayerCollection, type PlayerItem } from "@/lib/player-protocol";
import { collectionFromParams, collectionParams, fetchCatalog, metadataFilterKeys } from "@/lib/browser-catalog";
import { formatDuration } from "@/lib/format";
import { CollectionActions } from "./collection-actions";
import { TrackMenuButton, usePlayer } from "./player";
import { MissingMusic } from "./missing-music";
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
  if (!collection) return <div role="alert" className="py-12"><h1 className="text-3xl font-bold">This collection link isn&apos;t valid.</h1><Link href="/app/library" className="mt-4 inline-block text-mint underline">Open your library</Link></div>;
  if (!listing) return <div className="mx-auto max-w-4xl py-5">
    <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">Find your next song.</h1>
    <p className="my-5 max-w-xl text-sm leading-relaxed text-muted">Your shared library is a music backlog, not a list you need to scroll. Search with a few title or artist words; Mint handles prefixes, accents and close spellings.</p>
    <CatalogSearch key="backlog-search" query={q} />
    <div className="flex flex-wrap gap-4 text-sm font-semibold"><Link href="/app" className="inline-flex min-h-11 items-center text-mint hover:underline">Your daily recommendations</Link><Link href="/app/library" className="inline-flex min-h-11 items-center text-muted hover:text-fg">Browse the catalog</Link></div>
    <MissingMusic key={q} query={q} />
  </div>;
  const detail = identity?.key === identityKey ? identity.page : undefined;
  const first = detail?.items[0] ?? page?.items[0];
  const title = collection.kind === "album" ? detail?.title ?? first?.album ?? "Album"
    : collection.kind === "artist" ? detail?.title ?? first?.artist ?? "Artist"
    : collection.kind === "liked" ? "Liked songs"
    : collection.kind === "playlist" ? page?.title ?? "Playlist"
    : pathname === "/app/library" ? "Library" : "Your music";
  const itemCount = collection.kind === "artist" ? page?.total : detail?.total;
  return <div className="mx-auto max-w-[100rem]">
    {collection.kind !== "library" && <Link href="/app/library" className="mb-5 inline-flex min-h-11 items-center gap-1 text-sm text-muted hover:text-fg"><ChevronLeft className="size-4" />Library</Link>}
    {identity?.key === identityKey && identity.error && <p role="status" className="mb-4 text-sm text-warn">Collection artwork and overview could not load. {identity.error} Reopen this collection to retry.</p>}
    <header className={collection.kind === "artist" ? "artist-hero mb-8" : collection.kind === "album" ? "collection-hero mb-8" : "mb-7 flex items-end gap-5"}>
      {collection.kind === "album" && <div className="collection-hero-art">
        <Artwork track={{ artworkUrl: first?.thumb ?? "" }} eager className="h-full w-full rounded-none" />
      </div>}
      {collection.kind === "artist" && <div className="artist-hero-art" aria-hidden="true">
        <Artwork track={{ artworkUrl: detail?.items[0]?.thumb ?? "" }} eager className="h-full w-full rounded-none" />
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/65 to-transparent" />
      </div>}
      <div className="min-w-0">
        <h1 className="break-words text-4xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl">{collection.kind === "library" ? "Library" : title}</h1>
        <p className="mt-4 text-sm text-muted">{collection.kind === "library" ? "Made for your music. Nothing between you and the next song." : collection.kind === "artist" ? "Explore the albums. Stay for the songs." : first ? <ArtistLink item={first} /> : "Music from your collection."}</p>
        {itemCount !== undefined && <p className={`mt-3 text-sm tabular ${collection.kind === "artist" ? "text-fg/80" : "text-muted"}`}>{itemCount.toLocaleString()} {collection.kind === "artist" ? (itemCount === 1 ? "album" : "albums") : itemCount === 1 ? "song" : "songs"} in your library</p>}
        {collection.kind === "artist" && (() => {
          const artistProfile = page?.artistProfile ?? detail?.artistProfile;
          const profile = artistProfile?.profile;
          const metadataPending = !artistProfile || artistProfile.status === "queued" || artistProfile.status === "fetching";
          return (
            <div className="mt-5 max-w-3xl space-y-3">
              {metadataPending && <p role="status" className="text-sm text-fg/70">Artist details are being gathered in the background.</p>}
              {artistProfile?.status === "ambiguous" && <p className="text-sm text-fg/70">Mint couldn&apos;t confidently match this name to one artist record.</p>}
              {artistProfile?.status === "not_found" && <p className="text-sm text-fg/70">No confident match was found in the artist metadata sources.</p>}
              {artistProfile?.status === "failed" && <p role="status" className="text-sm text-warn">Artist details could not be refreshed. The background queue will retry.</p>}
              {profile && <>
                {(profile.artistType || profile.area || artistProfile?.musicBrainzArtistId) && <p className="text-sm text-fg/80">
                  {[profile.artistType, profile.area].filter(Boolean).join(" · ")}
                  {artistProfile?.musicBrainzArtistId && <> · <a href={`https://musicbrainz.org/artist/${artistProfile.musicBrainzArtistId}`} target="_blank" rel="noreferrer" className="underline">MusicBrainz</a></>}
                </p>}
                {profile.biography && <p className="text-sm leading-relaxed text-fg/90">{profile.biography}
                  {profile.biographyUrl && <> <a href={profile.biographyUrl} target="_blank" rel="noreferrer" className="whitespace-nowrap font-semibold underline">Wikipedia source</a></>}
                </p>}
                {profile.biography && <p className="text-xs text-fg/70">Biography summary by Wikipedia contributors, shared under CC BY-SA. <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer" className="underline">License</a></p>}
                {(profile.listenCount !== null || profile.listenerCount !== null) && <p className="text-sm text-fg/80">
                  <a href={`https://listenbrainz.org/artist/${artistProfile?.musicBrainzArtistId}`} target="_blank" rel="noreferrer" className="underline">ListenBrainz community</a>: {profile.listenCount?.toLocaleString() ?? "—"} listens · {profile.listenerCount?.toLocaleString() ?? "—"} listeners
                </p>}
                {!!profile.relatedArtists.length && <div>
                  <h2 className="text-sm font-semibold">Related artists</h2>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {profile.relatedArtists.map((related) => <li key={related.musicBrainzArtistId}>
                      <Link href={`/app/library/artists/${encodeURIComponent(artistPlayerId(related.name))}?type=album`}
                        className="inline-flex min-h-11 items-center rounded-full bg-bg/70 px-4 text-sm font-semibold text-fg/90 hover:bg-hover">
                        {related.name}
                      </Link>
                    </li>)}
                  </ul>
                </div>}
                {profile.unavailableSources.length > 0 && <p className="text-xs text-fg/70">Some sources could not be reached: {profile.unavailableSources.join(", ")}.</p>}
                {artistProfile?.fetchedAt && <p className="text-xs text-fg/70">Updated {new Date(artistProfile.fetchedAt).toLocaleDateString()}</p>}
              </>}
            </div>
          );
        })()}
        {(collection.kind === "album" || collection.kind === "artist") && <div className="mt-6 flex items-center gap-2">
          <CollectionActions collection={collection} empty={!first} label={collection.kind} />
          {first && <TrackMenuButton item={{ id: collection.id, type: collection.kind, title, artist: first.artist, artistId: first.artistId, thumb: first.thumb }} />}
        </div>}
      </div>
    </header>
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <nav aria-label="Library categories" className="flex flex-wrap gap-1">
        {kinds.filter((kind) => collection.kind === "library" ? kind !== "playlist" : collection.kind === "artist" ? kind === "album" || kind === "track" : kind === "track").map((kind) =>
          <button key={kind} aria-pressed={type === kind} onClick={() => change({ type: kind })}
            className={`min-h-11 rounded-full px-4 text-sm font-semibold ${type === kind ? "bg-fg text-bg" : "bg-elevated text-muted hover:bg-hover hover:text-fg"}`}>{labels[kind]}</button>)}
      </nav>
      {type !== "playlist" && collection.kind !== "album" && collection.kind !== "artist" && <CollectionActions collection={collection.kind === "library" ? { ...collection, query: q } : collection} empty={!page?.items.length} label={collection.kind === "library" && q ? "results" : collection.kind} />}
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
  return <MusicItem as="article" item={item} className="group relative min-w-0 rounded-lg p-2 transition-colors hover:bg-surface">
    <Link href={itemHref(item)} className="block rounded-md">
      <Artwork track={{ artworkUrl: item.thumb ?? "" }} className={`w-full ${item.type === "artist" ? "rounded-full" : "rounded-md"}`} />
      <h2 className="mt-3 truncate font-semibold group-hover:underline">{item.title}</h2>
    </Link>
    <p className="mt-1 truncate text-sm text-muted">{item.type === "artist" ? "Artist" : <ArtistLink item={item} />}</p>
    <button aria-label={`Play ${item.title}`} disabled={!player.ready || player.busy} onClick={() => player.command({ action: "play", item })}
      className="absolute right-2 top-2 grid size-11 place-items-center rounded-full bg-mint text-mint-ink shadow-[0_6px_12px_-4px_#000] transition-transform hover:scale-105 disabled:opacity-40"><Play className="size-5" fill="currentColor" /></button>
    <div className="mt-1 flex justify-end"><TrackMenuButton item={item} /></div>
  </MusicItem>;
}

function CatalogTracks({ items, collection }: { items: PlayerItem[]; collection: PlayerCollection }) {
  const player = usePlayer()!;
  return <div>
    <div className="hidden grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,1fr)_7rem] gap-3 border-b border-line px-3 pb-3 text-xs text-faint sm:grid">
      <span>#</span><span>Title</span><span>Album</span><Clock3 className="ml-auto size-4" aria-label="Duration" />
    </div>
    <ol className="mt-2">{items.map((item, index) => {
      const current = player.state.track?.id === item.id;
      const play = () => player.command({ action: "collection", collection, id: item.id, occurrenceId: item.occurrenceId, shuffle: false });
      return <MusicItem as="li" item={item} key={item.occurrenceId ?? item.id} className="group grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-2 hover:bg-hover/70 sm:grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,1fr)_7rem]">
        <button aria-label={`Play ${item.title}`} disabled={!player.ready || player.busy} onClick={play} className="grid size-8 place-items-center rounded-full text-muted hover:bg-elevated hover:text-mint disabled:opacity-40"><Play className={`size-4 ${current ? "text-mint" : ""}`} fill={current ? "currentColor" : "none"} /></button>
        <div className="flex min-w-0 items-center gap-3">
          <Artwork track={{ artworkUrl: item.thumb ?? "" }} className="size-11" />
          <div className="min-w-0"><button disabled={!player.ready || player.busy} onClick={play} className={`block max-w-full truncate text-left font-medium hover:underline disabled:opacity-40 ${current ? "text-mint" : "text-fg"}`}>{item.title}</button><p className="truncate text-sm text-muted"><ArtistLink item={item} /></p></div>
        </div>
        <p className="hidden truncate text-sm text-muted sm:block"><AlbumLink item={item} /></p>
        <div className="flex items-center justify-end text-xs text-muted tabular"><TrackMenuButton item={item} /><span>{formatDuration((item.duration ?? 0) / 1000)}</span></div>
      </MusicItem>;
    })}</ol>
  </div>;
}
