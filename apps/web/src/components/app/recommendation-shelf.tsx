"use client";
import { Play, Shuffle } from "lucide-react";
import type { TrackView } from "@mint/core/events";
import { Artwork } from "@/components/artwork";
import { trackPlayerItem } from "@/lib/player-protocol";
import { TrackMenuButton, usePlayer } from "./player";
import { shuffled } from "@/lib/browser-catalog";

export function RecommendationShelf({ items }: { items: { track: TrackView; reason: string }[] }) {
  const player = usePlayer();
  const play = (index: number, mix = false) => {
    const entries = items.map(({ track }) => trackPlayerItem(track));
    player?.command({ action: "items", items: mix ? shuffled(entries) : entries, index: mix ? 0 : index });
  };
  if (!items.length) return <p className="py-6 text-sm text-muted">Recommendations appear as playable music finishes indexing. Search for a song to request something missing.</p>;
  return <>
    <button disabled={!player?.ready || player.busy} onClick={() => play(0, true)} className="mb-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-mint px-5 text-sm font-bold text-mint-ink disabled:opacity-40"><Shuffle className="size-4" />Play this mix</button>
    <ol className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 xl:grid-cols-6">{items.map(({ track, reason }, index) => <li key={track.id} className="group min-w-0">
      <div className="relative">
        <button disabled={!player?.ready || player.busy} aria-label={`Play ${track.title}`} className="block w-full rounded-md disabled:opacity-40" onClick={() => play(index)}>
          <Artwork track={track} className="w-full rounded-md" />
          <span className="absolute bottom-2 right-2 grid size-11 place-items-center rounded-full bg-mint text-mint-ink transition-transform group-hover:scale-105 motion-reduce:transform-none"><Play className="size-5" fill="currentColor" /></span>
        </button>
      </div>
      <div className="mt-3 flex items-start gap-1"><div className="min-w-0 flex-1">
        <button className="block max-w-full truncate text-left font-semibold hover:underline" disabled={!player?.ready || player.busy} onClick={() => play(index)}>{track.title}</button>
        <p className="truncate text-sm text-muted">{track.artist}</p>
      </div><TrackMenuButton item={trackPlayerItem(track)} /></div>
      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-faint">{reason}</p>
    </li>)}</ol>
  </>;
}
