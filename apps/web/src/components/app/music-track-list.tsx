"use client";
import type { TrackView } from "@mint/core/events";
import { Play } from "lucide-react";
import { Artwork } from "@/components/artwork";
import { formatDuration } from "@/lib/format";
import { trackPlayerItem } from "@/lib/player-protocol";
import { TrackMenuButton, usePlayer } from "./player";

/** Entry identities, rather than track identities, keep intentional playlist duplicates distinct. */
export function MusicTrackList({ entries, actions, playAsQueue = false }: {
  entries: { key: string; track: TrackView; reason?: string }[];
  actions?: (key: string, track: TrackView, index: number) => React.ReactNode;
  playAsQueue?: boolean;
}) {
  const player = usePlayer();
  const playableEntries = entries.filter((e) => ["ready", "analyzing"].includes(e.track.stage));
  return <ol className="divide-y divide-line/60">{entries.map(({ key, track, reason }, index) => {
    const item = trackPlayerItem(track), playable = ["ready", "analyzing"].includes(track.stage);
    const play = () => player?.command(playAsQueue ? { action: "items", items: playableEntries.map((e) => ({
      ...trackPlayerItem(e.track), occurrenceId: e.key,
    })), index: playableEntries.findIndex((e) => e.key === key) } : { action: "play", item });
    return <li key={key} className="group flex flex-wrap items-center gap-3 py-3 hover:bg-hover/40">
      <button className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-elevated hover:text-mint disabled:opacity-40"
        disabled={!player?.ready || !playable} aria-label={`Play ${track.title}`} onClick={play}><Play className="size-4" /></button>
      <Artwork track={track} className="size-11 shrink-0 rounded" />
      <div className="min-w-0 flex-[1_1_10rem]"><button disabled={!player?.ready || !playable} onClick={play}
        className="block max-w-full truncate text-left font-semibold hover:underline disabled:opacity-50">{track.title}</button><p className="truncate text-sm text-muted">{track.artist}</p>
        {reason && <p className="mt-1 text-xs text-faint">{reason}</p>}</div>
      <span className="hidden text-xs text-muted tabular sm:block">{formatDuration(track.durationSec)}</span>
      <TrackMenuButton item={item} />
      {actions && <div className="flex flex-wrap items-center gap-1">{actions(key, track, index)}</div>}
    </li>;
  })}</ol>;
}
