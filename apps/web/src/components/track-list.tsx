"use client";

import type { TrackView } from "@mint/core/events";
import clsx from "clsx";
import { Clock3, Sparkles } from "lucide-react";
import { formatDuration } from "@/lib/format";
import { Artwork } from "./artwork";
import { PlayButton, useIsCurrent } from "./play-button";
import { usePlayer } from "./player";
import { ProgressBar, StageBadge } from "./stage-badge";

function Equalizer() {
  return (
    <span className="eq flex h-3.5 items-end gap-0.5" aria-label="Playing">
      <span className="h-full" />
      <span className="h-full" />
      <span className="h-full" />
    </span>
  );
}

function Row({
  track,
  index,
  context,
  showStage,
  actions,
  flash,
}: {
  track: TrackView;
  index: number;
  context: TrackView[];
  showStage: boolean;
  actions?: (t: TrackView) => React.ReactNode;
  flash?: number;
}) {
  const player = usePlayer();
  const { isCurrent, playing } = useIsCurrent(track.id);
  const inFlight = track.stage !== "ready" && track.stage !== "analyzing" && track.stage !== "failed";
  return (
    <li
      key={flash}
      onDoubleClick={() => track.hasPreview && player.play(track, context)}
      className={clsx(
        "group grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-hover/70 sm:grid-cols-[2rem_minmax(0,1.4fr)_minmax(0,1fr)_7.5rem_3.5rem]",
        flash && "stage-flash",
      )}
    >
      <div className="relative grid size-8 place-items-center text-sm text-muted tabular">
        <span className={clsx("group-hover:invisible group-focus-within:invisible", isCurrent && "invisible")}>{index + 1}</span>
        <div className={clsx("absolute inset-0 grid place-items-center", isCurrent ? "visible" : "invisible group-hover:visible group-focus-within:visible")}>
          {playing ? (
            <span className="group-hover:hidden">
              <Equalizer />
            </span>
          ) : null}
          <PlayButton track={track} context={context} size="sm" className={clsx(playing && "hidden group-hover:grid")} />
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <Artwork track={track} className="size-10" />
        <div className="min-w-0">
          <p className={clsx("truncate font-medium", isCurrent ? "text-mint" : "text-fg")}>{track.title}</p>
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
          <span className="inline-flex items-center gap-1 text-xs text-muted" title="Plex sonic analysis complete — works with Sonic Radio and Sweet Fades">
            <Sparkles className="size-3.5 text-mint" aria-hidden /> Sonic
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
          <Row key={t.id} track={t} index={i} context={tracks} showStage={showStage} actions={actions} flash={flash?.[t.id]} />
        ))}
      </ol>
    </div>
  );
}

/** Album-art card used on the landing page and home shelves. */
export function TrackCard({ track, context }: { track: TrackView; context: TrackView[] }) {
  const { isCurrent } = useIsCurrent(track.id);
  return (
    <div className="group relative rounded-lg p-3 transition-colors duration-300 hover:bg-elevated">
      <div className="relative">
        <Artwork track={track} className="w-full shadow-[0_10px_30px_-12px_rgb(0_0_0/0.8)]" sizes="(min-width: 1024px) 200px, 45vw" />
        <PlayButton
          track={track}
          context={context}
          className={clsx(
            "absolute right-2 bottom-2 transition duration-300 ease-out-expo",
            isCurrent ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100",
          )}
        />
      </div>
      <p className={clsx("mt-3 truncate font-semibold", isCurrent ? "text-mint" : "text-fg")}>{track.title}</p>
      <p className="truncate text-sm text-muted">{track.artist}</p>
    </div>
  );
}
