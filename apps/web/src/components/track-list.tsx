"use client";

import type { TrackView } from "@mint/core/events";
import clsx from "clsx";
import { ArrowUpRight, Clock3, Play, Sparkles } from "lucide-react";
import { TrackMenuButton, usePlayer } from "@/components/app/player";
import { trackPlayerItem, type PlayerCollection } from "@/lib/player-protocol";
import { formatDuration, youtubeMusicUrl } from "@/lib/format";
import { Artwork } from "./artwork";
import { ProgressBar, StageBadge } from "./stage-badge";
import { AlbumLink, ArtistLink } from "./app/music-links";
import { MusicItem } from "./app/music-item";

function Row({
  track,
  index,
  showStage,
  actions,
  flash,
  collection,
}: {
  track: TrackView;
  index: number;
  showStage: boolean;
  actions?: (t: TrackView) => React.ReactNode;
  flash?: number;
  collection?: PlayerCollection;
}) {
  const player = usePlayer();
  const playable = player && (track.stage === "ready" || track.stage === "analyzing");
  const item = trackPlayerItem(track);
  const play = () => player?.command(collection ? { action: "collection", collection, shuffle: false, id: item.id } : { action: "play", item });
  const inFlight = track.stage !== "ready" && track.stage !== "analyzing" && track.stage !== "failed";
  return (
    <MusicItem as="li" item={playable ? item : null}
      key={flash}
      className={clsx(
        "group grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-hover/70 sm:grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,1fr)_7.5rem_6.5rem]",
        flash && "stage-flash",
      )}
    >
      {playable ? <button aria-label={`Play ${track.title}`} disabled={!player.ready} onClick={play}
        className="grid size-8 place-items-center rounded-full text-muted hover:bg-elevated hover:text-mint disabled:opacity-40">
        <span className="text-sm tabular group-hover:hidden">{index + 1}</span><Play className="hidden size-4 group-hover:block" fill="currentColor" />
      </button> : <span className="text-center text-sm text-muted tabular">{index + 1}</span>}
      <div className="flex min-w-0 items-center gap-3">
        <Artwork track={track} className={clsx("size-11 transition-[filter] duration-500", inFlight && "grayscale-[0.7]")} />
        <div className="min-w-0">
          {playable ? <button onClick={play} disabled={!player.ready}
            className="block max-w-full truncate text-left font-medium text-fg hover:underline disabled:opacity-40">{track.title}</button>
            : <p className="truncate font-medium text-fg">{track.title}</p>}
          <p className="truncate text-sm text-muted">{player ? <ArtistLink item={item} /> : track.artist}</p>
        </div>
      </div>
      <p className="hidden truncate text-sm text-muted sm:block">{player ? <AlbumLink item={item} /> : track.album ?? "Single"}</p>
      <div className="hidden min-w-0 flex-col gap-1 sm:flex">
        {showStage || inFlight || track.stage === "failed" ? (
          <>
            <StageBadge stage={track.stage} progress={track.progress} />
            {inFlight && track.stage === "downloading" && <ProgressBar value={track.progress} />}
            {track.stage === "failed" && track.detail && (
              <p className="truncate text-[11px] text-faint" title={track.detail}>{track.detail}</p>
            )}
          </>
        ) : track.sonicAnalyzed ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted" title="Plex sonic analysis complete. Mint analysis and smart fades are tracked separately.">
            <Sparkles className="size-3.5 text-warn" aria-hidden /> Sonic
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-2 text-sm text-muted tabular">
        {actions?.(track)}
        {playable && <TrackMenuButton item={item} />}
        <span>{formatDuration(track.durationSec)}</span>
      </div>
    </MusicItem>
  );
}

export function TrackList({
  tracks,
  showStage = false,
  actions,
  flash,
  empty,
  collection,
}: {
  tracks: TrackView[];
  showStage?: boolean;
  actions?: (t: TrackView) => React.ReactNode;
  flash?: Record<string, number>;
  empty?: React.ReactNode;
  collection?: PlayerCollection;
}) {
  if (!tracks.length) return <>{empty}</>;
  return (
    <div>
      <div className="hidden grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,1fr)_7.5rem_6.5rem] gap-3 border-b border-line px-3 pb-2 text-xs font-medium text-faint sm:grid">
        <span className="text-center">#</span>
        <span>Title</span>
        <span>Album</span>
        <span>Status</span>
        <Clock3 className="ml-auto size-4" aria-label="Duration" />
      </div>
      <ol className="mt-2">
        {tracks.map((t, i) => (
          <Row key={t.id} track={t} index={i} showStage={showStage} actions={actions} flash={flash?.[t.id]} collection={collection} />
        ))}
      </ol>
    </div>
  );
}

export function TrackCard({ track, feature = false, landing = false }: { track: TrackView; feature?: boolean; landing?: boolean }) {
  const player = usePlayer();
  const playable = player && (track.stage === "ready" || track.stage === "analyzing");
  if (playable) return <MusicItem item={trackPlayerItem(track)} className={clsx("group relative", feature && "col-span-2 row-span-2")}>
    <button aria-label={`Play ${track.title}`} disabled={!player.ready} onClick={() => player.command({ action: "play", item: trackPlayerItem(track) })}
      className="block w-full rounded-md text-left disabled:opacity-50">
      <div className="relative overflow-hidden rounded-md"><Artwork track={track} eager={feature} className="w-full" />
        <span className="absolute right-3 bottom-3 grid size-11 place-items-center rounded-full bg-mint text-mint-ink shadow-lg transition-transform group-hover:scale-105"><Play className="size-5" fill="currentColor" /></span>
      </div>
      <p className={clsx("mt-3 truncate font-semibold", feature && "sm:text-xl")}>{track.title}</p>
    </button>
    <p className="truncate text-sm text-muted"><ArtistLink item={trackPlayerItem(track)} /></p>
    <div className="absolute top-2 right-2 rounded-full bg-bg/90"><TrackMenuButton item={trackPlayerItem(track)} /></div>
  </MusicItem>;
  const Element = track.youtubeVideoId ? "a" : "div";
  return (
    <Element
      href={track.youtubeVideoId ? youtubeMusicUrl(track.youtubeVideoId) : undefined}
      target={track.youtubeVideoId ? "_blank" : undefined}
      rel={track.youtubeVideoId ? "noreferrer" : undefined}
      className={clsx("group relative block rounded-lg outline-offset-4", feature && "col-span-2 row-span-2", landing && "land")}
    >
      <div className="relative overflow-hidden rounded-md shadow-[0_18px_40px_-18px_rgb(0_0_0/0.9)]">
        <Artwork
          track={track}
          eager={feature}
          className={clsx("w-full rounded-none", track.youtubeVideoId && "transition duration-700 ease-out-expo group-hover:scale-[1.04] group-focus-visible:scale-[1.04]")}
        />
        {track.youtubeVideoId && <span className="absolute top-2 right-2 grid size-8 translate-y-1 place-items-center rounded-full bg-bg/80 text-fg opacity-0 backdrop-blur-sm transition duration-300 ease-out-expo group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
          <ArrowUpRight className="size-4" aria-hidden />
        </span>}
      </div>
      <p className={clsx("mt-3 truncate font-semibold text-fg", feature && "sm:text-xl")}>{track.title}</p>
      <p className={clsx("truncate text-sm text-muted", feature && "sm:text-base")}>
        {track.artist}
        <span className="sr-only">{track.youtubeVideoId ? " (opens YouTube Music)" : " (existing library)"}</span>
      </p>
    </Element>
  );
}
