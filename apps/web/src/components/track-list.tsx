"use client";

import type { TrackView } from "@mint/core/events";
import clsx from "clsx";
import { ArrowUpRight, Clock3, Sparkles } from "lucide-react";
import { formatDuration, youtubeMusicUrl } from "@/lib/format";
import { Artwork } from "./artwork";
import { ProgressBar, StageBadge } from "./stage-badge";

function Row({
  track,
  index,
  showStage,
  actions,
  flash,
}: {
  track: TrackView;
  index: number;
  showStage: boolean;
  actions?: (t: TrackView) => React.ReactNode;
  flash?: number;
}) {
  const inFlight = track.stage !== "ready" && track.stage !== "analyzing" && track.stage !== "failed";
  return (
    <li
      key={flash}
      className={clsx(
        "group grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-hover/70 sm:grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,1fr)_7.5rem_3.5rem]",
        flash && "stage-flash",
      )}
    >
      <span className="text-center text-sm text-muted tabular">{index + 1}</span>
      <div className="flex min-w-0 items-center gap-3">
        <Artwork track={track} className={clsx("size-11 transition-[filter] duration-500", inFlight && "grayscale-[0.7]")} />
        <div className="min-w-0">
          <p className="truncate font-medium text-fg">{track.title}</p>
          <p className="truncate text-sm text-muted">{track.artist}</p>
        </div>
      </div>
      <p className="hidden truncate text-sm text-muted sm:block">{track.album ?? "Single"}</p>
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
          <span className="inline-flex items-center gap-1 text-xs text-muted" title="Plex sonic analysis complete. Works with Sonic Radio and Sweet Fades.">
            <Sparkles className="size-3.5 text-warn" aria-hidden /> Sonic
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-2 text-sm text-muted tabular">
        {actions?.(track)}
        <span>{formatDuration(track.durationSec)}</span>
      </div>
    </li>
  );
}

export function TrackList({
  tracks,
  showStage = false,
  actions,
  flash,
  empty,
}: {
  tracks: TrackView[];
  showStage?: boolean;
  actions?: (t: TrackView) => React.ReactNode;
  flash?: Record<string, number>;
  empty?: React.ReactNode;
}) {
  if (!tracks.length) return <>{empty}</>;
  return (
    <div>
      <div className="hidden grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,1fr)_7.5rem_3.5rem] gap-3 border-b border-line px-3 pb-2 text-xs font-medium text-faint sm:grid">
        <span className="text-center">#</span>
        <span>Title</span>
        <span>Album</span>
        <span>Status</span>
        <Clock3 className="ml-auto size-4" aria-label="Duration" />
      </div>
      <ol className="mt-2">
        {tracks.map((t, i) => (
          <Row key={t.id} track={t} index={i} showStage={showStage} actions={actions} flash={flash?.[t.id]} />
        ))}
      </ol>
    </div>
  );
}

/** Album-art card. The cover is the whole point; it links out to the song on YouTube Music. */
export function TrackCard({ track, feature = false, landing = false }: { track: TrackView; feature?: boolean; landing?: boolean }) {
  return (
    <a
      href={youtubeMusicUrl(track.youtubeVideoId)}
      target="_blank"
      rel="noreferrer"
      className={clsx("group relative block rounded-lg outline-offset-4", feature && "col-span-2 row-span-2", landing && "land")}
    >
      <div className="relative overflow-hidden rounded-md shadow-[0_18px_40px_-18px_rgb(0_0_0/0.9)]">
        <Artwork
          track={track}
          eager={feature}
          className="w-full rounded-none transition duration-700 ease-out-expo group-hover:scale-[1.04] group-focus-visible:scale-[1.04]"
        />
        <span className="absolute top-2 right-2 grid size-8 translate-y-1 place-items-center rounded-full bg-bg/80 text-fg opacity-0 backdrop-blur-sm transition duration-300 ease-out-expo group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
          <ArrowUpRight className="size-4" aria-hidden />
        </span>
      </div>
      <p className={clsx("mt-3 truncate font-semibold text-fg", feature && "sm:text-xl")}>{track.title}</p>
      <p className={clsx("truncate text-sm text-muted", feature && "sm:text-base")}>
        {track.artist}
        <span className="sr-only"> (opens YouTube Music)</span>
      </p>
    </a>
  );
}
