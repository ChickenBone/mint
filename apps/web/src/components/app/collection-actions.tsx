"use client";

import { Play, Shuffle } from "lucide-react";
import { usePlayer } from "./player";
import type { PlayerCollection } from "@/lib/player-protocol";

export function CollectionActions({ collection, empty = false, label = "library" }: { collection: PlayerCollection; empty?: boolean; label?: string }) {
  const player = usePlayer();
  if (!player) return null;
  return <div className="flex flex-wrap items-center gap-2">
    <button aria-busy={player.busy} disabled={!player.ready || player.busy || empty} onClick={() => player.command({ action: "collection", collection, shuffle: false })}
      className="inline-flex min-h-11 items-center gap-2 rounded-full bg-mint px-5 py-2.5 text-sm font-bold text-mint-ink hover:bg-mint-strong disabled:cursor-not-allowed disabled:opacity-40">
      <Play className="size-4" fill="currentColor" />{player.busy ? "Loading music…" : `Play ${label}`}
    </button>
    <button disabled={!player.ready || player.busy || empty} onClick={() => player.command({ action: "collection", collection, shuffle: true })}
      className="inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-4 py-2.5 text-sm font-semibold text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40">
      <Shuffle className="size-4" />Shuffle
    </button>
  </div>;
}
