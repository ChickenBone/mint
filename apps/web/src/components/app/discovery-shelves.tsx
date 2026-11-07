"use client";

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { ArrowUpRight, Play } from "lucide-react";
import type { TrackView } from "@mint/core/events";
import { CHARTS, type ChartDefinition } from "@/lib/charts";
import { musicRequest } from "@/lib/music-client";
import type { PlayerItem } from "@/lib/player-protocol";
import { Artwork } from "@/components/artwork";
import { usePlayer } from "./player";

const colors = [
  ["#c2ed78", "#183921"], ["#bdb0ed", "#291b4a"], ["#f1a793", "#471c2a"],
  ["#293575", "#fff1df"], ["#e8c35f", "#3b2816"], ["#9ec6e7", "#152c47"],
];
type Collection = { id: string; title: string; cover: string; description: string; href: string; color: number;
  mode?: "for-you" | "recent" | "rediscover" | "radio"; seed?: string; artwork?: string; caption: string };
const mix = (mode: string, seed?: string) => `/app/discover/mixes?${new URLSearchParams({ mode, ...(seed ? { seed } : {}) })}`;
export const DISCOVERY_MIXES: Collection[] = [
  { id: "daily", title: "Daily blend", cover: "Your\ndaily\nblend", description: "Familiar favorites. A few new turns. All from your library.", href: mix("for-you"), mode: "for-you", color: 0, caption: "Daily mix" },
  { id: "fresh", title: "Fresh finds", cover: "Fresh\nfinds", description: "The latest additions to your own little music universe.", href: mix("recent"), mode: "recent", color: 1, caption: "Library picks" },
  { id: "again", title: "Play it again", cover: "Play it\nagain.", description: "The songs you left on the shelf. Time for another listen.", href: mix("rediscover"), mode: "rediscover", color: 2, caption: "Rediscover" },
];
function chartCollection(chart: ChartDefinition, index: number): Collection {
  const country = chart.country?.toUpperCase();
  return { id: chart.id, title: chart.title,
    cover: country ? `Top 50\n${country}` : chart.genre ? chart.genre.replace("Hip-Hop/Rap", "Hip-hop\nrotation").replace("Electronic", "Electro\npulse") : chart.provider === "listenbrainz" ? "World\nof listens\n50" : "Indie\nrotation",
    description: chart.territory,
    href: `/app/discover/charts/${encodeURIComponent(chart.id)}`, color: index % colors.length,
    caption: chart.providerName };
}
export function PlaylistCover({ collection }: { collection: Collection }) {
  const [paper, ink] = colors[collection.color % colors.length]!;
  return <div aria-hidden className="discovery-cover" data-pattern={collection.color % 3}
    style={{ "--cover-paper": paper, "--cover-ink": ink } as CSSProperties}>
    {collection.artwork && <div className="absolute inset-0 opacity-15 grayscale"><Artwork track={{ artworkUrl: collection.artwork }} className="h-full w-full rounded-none" /></div>}
    <svg viewBox="0 0 300 300" className="discovery-cover-shape" fill="none" aria-hidden>
      {collection.color % 3 === 0 ? <>{[0, 1, 2, 3, 4].map((n) => <circle key={n} cx="282" cy="266" r={48 + n * 25} stroke="currentColor" strokeWidth="9" />)}</>
        : collection.color % 3 === 1 ? <><path d="M-20 240 150 70 320 240 150 410Z" fill="currentColor" /><circle cx="150" cy="240" r="72" fill="var(--cover-paper)" /></>
          : <>{[0, 1, 2, 3, 4].map((n) => <path key={n} d={`M-30 ${190 + n * 25} Q80 ${75 + n * 25} 170 ${190 + n * 25} T340 ${190 + n * 25}`} stroke="currentColor" strokeWidth="10" />)}</>}
    </svg>
    <span className="discovery-cover-title">{collection.cover}</span>
    <span className="discovery-cover-credit"><span>mint</span><span>{collection.caption}</span></span>
  </div>;
}
export function DiscoveryShelves({ seeds }: { seeds: TrackView[] }) {
  const player = usePlayer(), [busy, setBusy] = useState<string | null>(null), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const artists = [...new Map(seeds.map((track) => [track.artist, track])).values()].slice(0, 3);
  const daily: Collection[] = [
    ...DISCOVERY_MIXES,
    ...artists.map((track, i): Collection => ({ id: `artist-${track.id}`, title: `${track.artist} radio`, cover: `${track.artist}\nradio`,
      description: `${track.artist} and more from that corner of your collection.`, href: mix("radio", track.id), mode: "radio", seed: track.id,
      color: i + 3, artwork: track.artworkUrl, caption: "Library radio" })),
  ];
  const play = async (collection: Collection) => {
    if (!collection.mode || !player) return;
    setBusy(collection.id); setError(""); setNotice("");
    try {
      const query = new URLSearchParams({ mode: collection.mode, ...(collection.seed ? { seed: collection.seed } : {}) });
      const result = await musicRequest<{ items: { item: PlayerItem }[] }>(`discover?${query}`);
      if (!result.items.length) { setNotice(collection.mode === "rediscover" ? "Nothing to rediscover yet. Songs return here after seven days away." : "This mix needs more playable songs. Open your library to find a starting point."); return; }
      if (await player.command({ action: "items", items: result.items.map(({ item }) => item) })) setNotice(`Playing ${collection.title}.`);
    } catch (error) { setError(error instanceof Error ? error.message : "This mix could not load. Open the playlist and try again."); }
    finally { setBusy(null); }
  };
  return <div className="discovery-shelves">
    <header className="mb-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Explore</h2>
        <p className="mt-2 text-sm text-muted">Mixes and radio from your library.</p>
      </div>
      <Link href="/app/discover/mixes" className="mt-2 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-muted hover:text-fg">Your mixes<ArrowUpRight className="size-4" /></Link>
    </header>
    {error && <p role="alert" className="mb-5 text-sm text-danger">{error}</p>}
    <p role="status" className={notice ? "mb-5 text-sm text-mint" : "sr-only"}>{notice}</p>
    <section aria-label="Your daily soundtrack" className="discovery-shelf">
      <h2 className="text-2xl font-bold tracking-tight">Your daily soundtrack</h2><p className="mt-2 text-sm text-muted">Made by Mint. Shaped by your collection.</p>
      <ul className="discovery-shelf-rail scrollbar-thin">{daily.map((collection) => <li key={collection.id} className="discovery-playlist group">
        <div className="relative">
          <Link href={collection.href} aria-label={`Open ${collection.title}`} className="block rounded-lg"><PlaylistCover collection={collection} /></Link>
          {collection.mode && <button aria-label={`Play ${collection.title}`} disabled={busy !== null || !player?.ready || player.busy}
            className="discovery-playlist-play" onClick={() => void play(collection)}><Play className="size-5" fill="currentColor" /></button>}
        </div>
        <Link href={collection.href} className="mt-4 block truncate font-semibold hover:underline">{collection.title}</Link>
        <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted">{collection.description}</p>
      </li>)}</ul>
    </section>
    <section id="charts" aria-labelledby="charts-heading" className="discovery-shelf scroll-mt-8">
      <h2 id="charts-heading" className="text-2xl font-bold tracking-tight">Charts</h2>
      <p className="mt-2 text-sm text-muted">Rankings and trending collections, with their source and scope in view.</p>
      <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {CHARTS.map((chart, index) => {
          const collection = chartCollection(chart, index);
          return <li key={collection.id} className="discovery-playlist group">
            <Link href={collection.href} aria-label={`Open ${collection.title}`} className="block rounded-lg">
              <PlaylistCover collection={collection} />
            </Link>
            <Link href={collection.href} className="mt-3 block truncate font-semibold hover:underline">{collection.title}</Link>
            <p className="mt-1 truncate text-sm text-muted">{collection.description}</p>
          </li>;
        })}
      </ul>
    </section>
  </div>;
}
