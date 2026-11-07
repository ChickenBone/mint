"use client";

import Link from "next/link";
import { ArrowUpRight, Play } from "lucide-react";
import type { TrackView } from "@mint/core/events";
import { Artwork } from "@/components/artwork";
import { trackPlayerItem } from "@/lib/player-protocol";
import { TrackMenuButton, usePlayer } from "./player";
import { ArtistLink } from "./music-links";
import { MusicItem } from "./music-item";

export function ListeningSpotlight({ track, reason }: { track: TrackView | null; reason?: string }) {
  const player = usePlayer();
  return <section className="listening-spotlight" aria-label="Your next listen">
    <div>
      <h2 className="max-w-xl text-[clamp(2.5rem,4.7vw,4.75rem)] font-bold leading-[1.05] tracking-[-0.035em]">Stay for<br />another song.</h2>
      <p className="mt-5 max-w-md text-base leading-relaxed text-muted">{track ? <>{track.title} by <ArtistLink item={trackPlayerItem(track)} />. {reason ?? "A familiar favorite, or the start of something new."}</> : "Your own collection. A fresh perspective. Find the music you want to come back to."}</p>
      <div className="mt-7 flex flex-wrap items-center gap-3">
        {track ? <><button disabled={!player?.ready || player.busy} onClick={() => player?.command({ action: "play", item: trackPlayerItem(track) })}
          className="inline-flex min-h-12 items-center gap-3 rounded-full bg-mint px-6 text-sm font-bold text-mint-ink hover:bg-mint-strong disabled:opacity-40"><Play className="size-4" fill="currentColor" />Listen now</button><TrackMenuButton item={trackPlayerItem(track)} /></>
          : <Link href="/app/library" className="inline-flex min-h-12 items-center rounded-full bg-mint px-6 text-sm font-bold text-mint-ink">Open your library</Link>}
        <Link href="/app/search" className="inline-flex min-h-12 items-center gap-2 rounded-full px-4 text-sm font-semibold text-muted hover:text-fg">Find something new<ArrowUpRight className="size-4" /></Link>
      </div>
    </div>
    {track && <MusicItem item={trackPlayerItem(track)} className="spotlight-sleeve mx-auto w-full max-w-sm">
      <Artwork track={track} eager className="w-full rounded-xl shadow-[0_24px_50px_-24px_#000]" />
      <div className="mt-4 hidden justify-between gap-4 text-xs text-muted sm:flex"><span className="truncate">{track.album ?? track.title}</span><span className="shrink-0">In your library</span></div>
    </MusicItem>}
  </section>;
}
