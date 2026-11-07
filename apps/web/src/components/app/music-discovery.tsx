"use client";
import { useState } from "react";
import Link from "next/link";
import type { TrackView } from "@mint/core/events";
import type { PlayerItem } from "@/lib/player-protocol";
import type { DiscoveryMode } from "@/lib/music-discovery";
import { musicRequest } from "@/lib/music-client";
import { Heart, Play, Shuffle, X } from "lucide-react";
import { usePlayer } from "./player";
import { MusicTrackList } from "./music-track-list";
import { DISCOVERY_MIXES, PlaylistCover } from "./discovery-shelves";

type Shelf = { items: { track: TrackView; item: PlayerItem; reason: string }[]; explanation: string };
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-elevated px-4 py-2 text-sm font-semibold hover:bg-hover disabled:opacity-40";
const field = "min-h-11 w-full rounded-md bg-elevated px-3 py-2 text-sm ring-1 ring-line focus:ring-mint";
const labels: Record<DiscoveryMode, string> = { "for-you": "For you", recent: "Recently added", rediscover: "Rediscover", radio: "Library radio", sonic: "Sonic mix" };
export function MusicDiscovery({ initial, initialMode, initialSeeds, initialLikes }: {
  initial: Shelf; initialMode: DiscoveryMode; initialSeeds: string[]; initialLikes: string[];
}) {
  const [shelf, setShelf] = useState(initial), [mode, setMode] = useState(initialMode), [seeds, setSeeds] = useState(initialSeeds);
  const [seedNames, setSeedNames] = useState<Record<string, string>>({}), [found, setFound] = useState<TrackView[]>([]);
  const [likes, setLikes] = useState(new Set(initialLikes)), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const player = usePlayer();
  const collection = DISCOVERY_MIXES.find((collection) => collection.mode === mode) ?? {
    id: mode, title: labels[mode], cover: mode === "sonic" ? "Measured\nmix" : "Library\nradio", color: 3,
    description: mode === "sonic" ? "Connections found in your music’s measured sound." : "Follow a few favorites into another corner of your library.",
    href: "/app/search", caption: "Mint mix",
  };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const load = async (next: DiscoveryMode) => {
    const query = new URLSearchParams({ mode: next }); for (const id of seeds) query.append("seed", id);
    const result = await musicRequest<Shelf>(`discover?${query}`); setShelf(result); setMode(next);
  };
  return <section className="mx-auto max-w-6xl">
    <nav aria-label="Mix navigation" className="mb-6 flex flex-wrap gap-4 text-sm font-semibold">
      <Link href="/app/search" className="inline-flex min-h-11 items-center text-muted hover:text-fg">Search</Link>
      <Link href="/app/discover/mixes" aria-current="page" className="inline-flex min-h-11 items-center text-fg">Your mixes</Link>
      <Link href="/app/discover/charts" className="inline-flex min-h-11 items-center text-muted hover:text-fg">Charts</Link>
    </nav>
    <header className="grid grid-cols-[7rem_minmax(0,1fr)] items-end gap-5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-8">
      <PlaylistCover collection={collection} />
      <div><h1 className="text-3xl font-bold tracking-tight sm:text-5xl">{collection.title}</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">{collection.description}</p></div>
    </header>
    <nav className="my-7 flex flex-wrap gap-2" aria-label="Discovery shelves">{(["for-you", "recent", "rediscover"] as const).map((value) =>
      <button key={value} className={`${button} ${mode === value ? "bg-fg text-bg" : ""}`} aria-pressed={mode === value} disabled={busy} onClick={() => void run(() => load(value))}>{labels[value]}</button>)}</nav>
    <details className="mb-7 border-y border-line py-5" open={mode === "radio" || mode === "sonic"}>
      <summary className="cursor-pointer font-semibold">Start a radio or mix</summary>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted">Pick up to 20 songs. Radio follows their artists and albums; a sound-alike mix finds songs that sound similar.</p>
      <form className="my-5 flex flex-wrap gap-3" onSubmit={(event) => {
        event.preventDefault(); const q = String(new FormData(event.currentTarget).get("q") ?? "");
        void run(async () => { const result = await musicRequest<{ tracks: TrackView[] }>(`library?q=${encodeURIComponent(q)}`); setFound(result.tracks); if (!result.tracks.length) setNotice("No matching playable songs. Try another artist or title."); });
      }}><label className="min-w-0 flex-1"><span className="sr-only">Find songs or artists</span><input name="q" maxLength={100} className={field} placeholder="Find a song, artist or album" /></label><button className={button} disabled={busy}>Search</button></form>
      {!!found.length && <ul className="mb-5 max-h-64 overflow-y-auto divide-y divide-line/60">{found.map((t) => <li key={t.id} className="flex items-center justify-between gap-3 py-2">
        <p className="min-w-0 truncate text-sm">{t.title}<span className="ml-2 text-muted">{t.artist}</span></p><button className={button} disabled={seeds.includes(t.id) || seeds.length >= 20} onClick={() => {
          setSeeds([...seeds, t.id]); setSeedNames({ ...seedNames, [t.id]: `${t.title} · ${t.artist}` });
        }}>{seeds.includes(t.id) ? "Added" : "Add"}</button></li>)}</ul>}
      <ul className="mb-4 flex flex-wrap gap-2">{seeds.map((id) => <li key={id}><button className={button} onClick={() => setSeeds(seeds.filter((s) => s !== id))} aria-label={`Remove ${seedNames[id] ?? id}`}>
        <span className="max-w-60 truncate">{seedNames[id] ?? `Song ${seeds.indexOf(id) + 1}`}</span><X className="size-4" /></button></li>)}</ul>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={!seeds.length || busy} onClick={() => void run(() => load("radio"))}>Start radio</button>
        <button className={button} disabled={!seeds.length || busy} onClick={() => void run(() => load("sonic"))}>Start sound-alike mix</button></div>
    </details>
    {error && <p role="alert" className="my-5 text-warn">{error}</p>}
    <p role="status" className="my-4 text-sm text-muted">{busy ? "Finding your next songs…" : notice}</p>
    <h2 className="text-2xl font-bold">{labels[mode]}</h2><p className="mt-3 mb-5 max-w-2xl text-sm leading-relaxed text-muted">{shelf.explanation}</p>
    {!!shelf.items.length && <div className="mb-5 flex flex-wrap items-end gap-3"><button className="inline-flex min-h-11 items-center gap-2 rounded-full bg-mint px-5 py-2 text-sm font-bold text-mint-ink disabled:opacity-40"
      disabled={!player?.ready || player.busy || busy} onClick={() => player?.command({ action: "items", items: shelf.items.map((r) => r.item) })}><Play className="size-4" fill="currentColor" />Play mix</button>
      <button className={button} disabled={!player?.ready || player.busy || busy} onClick={() => player?.command({ action: "items", items: shelf.items.map((r) => r.item), shuffle: true })}><Shuffle className="size-4" />Shuffle mix</button>
      <form className="flex min-w-0 flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); const title = new FormData(event.currentTarget).get("title");
        void run(async () => { const result = await musicRequest<{ id: string }>("collections", "POST", { title, trackIds: shelf.items.map((r) => r.track.id) }); setNotice("Saved to Your Library."); void result; });
      }}><label className="sr-only" htmlFor="mix-name">Saved mix name</label><input id="mix-name" name="title" required maxLength={200} className={`${field} w-44`} placeholder="Name this mix" /><button className={button} disabled={busy}>Save as playlist</button></form>
    </div>}
    {!shelf.items.length ? <div className="py-10"><p className="text-muted">{mode === "sonic" ? "No sound-alike matches yet. Try different songs or check back later." : mode === "rediscover" ? "Keep listening. Your history will bring forgotten favorites back here." : "Nothing to play here yet."}</p>
      <Link href="/app/library" className="mt-5 inline-block text-sm text-mint underline">Open your music library</Link></div>
      : <MusicTrackList playAsQueue entries={shelf.items.map((r) => ({ key: r.track.id, track: r.track, reason: r.reason }))} actions={(_, track) =>
        <button className={button} disabled={busy} aria-label={`${likes.has(track.id) ? "Unlike" : "Like"} ${track.title}`} aria-pressed={likes.has(track.id)} onClick={() => void run(async () => {
          const liked = likes.has(track.id); await musicRequest(`likes/${track.id}`, liked ? "DELETE" : "PUT");
          const next = new Set(likes); if (liked) next.delete(track.id); else next.add(track.id); setLikes(next);
        })}><Heart className={`size-4 ${likes.has(track.id) ? "fill-mint text-mint" : ""}`} /></button>} />}
  </section>;
}
