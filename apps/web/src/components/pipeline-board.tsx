"use client";

import type { Stats, TrackView } from "@mint/core/events";
import { PIPELINE_LANES } from "@mint/core/stages";
import clsx from "clsx";
import { formatCount } from "@/lib/format";
import { Artwork } from "./artwork";
import { useLiveStats, useLiveTracks } from "./realtime";
import { ProgressBar } from "./stage-badge";

const inFlight = (t: TrackView) => t.stage !== "ready" && t.stage !== "failed";
const PER_LANE = 6;

/** Kanban of every in-flight song, lane per pipeline phase, updated over the socket. */
export function PipelineBoard({ initialTracks, initialStats }: { initialTracks: TrackView[]; initialStats: Stats }) {
  const { tracks, flash } = useLiveTracks(initialTracks, { keep: inFlight, limit: 300 });
  const stats = useLiveStats(initialStats);

  return (
    <div className="-mx-5 overflow-x-auto px-5 pb-2 scrollbar-thin sm:mx-0 sm:px-0">
      <ol className="grid min-w-[56rem] grid-cols-5 gap-3">
        {PIPELINE_LANES.map((lane) => {
          const laneTracks = tracks.filter((t) => (lane.stages as readonly string[]).includes(t.stage));
          const total = Math.max(
            laneTracks.length,
            lane.stages.reduce((n, s) => n + (stats.byStage[s] ?? 0), 0),
          );
          return (
            <li key={lane.id} className="flex min-h-64 flex-col rounded-xl bg-surface p-3">
              <div className="flex items-baseline justify-between px-1 pb-3">
                <h3 className="text-sm font-semibold">{lane.label}</h3>
                <span className="text-xs text-muted tabular">{formatCount(total)}</span>
              </div>
              {laneTracks.length === 0 ? (
                <p className="px-1 text-sm text-faint">Nothing here right now.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {laneTracks.slice(0, PER_LANE).map((t) => (
                    <li key={`${t.id}-${flash[t.id] ?? 0}`} className={clsx("rounded-lg p-2", flash[t.id] && "stage-flash")}>
                      <div className="flex items-center gap-2.5">
                        <Artwork track={t} className="size-9 rounded" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{t.title}</p>
                          <p className="truncate text-xs text-muted">{t.artist}</p>
                        </div>
                      </div>
                      {(t.stage === "downloading" || t.stage === "importing") && t.progress > 0 && <ProgressBar value={t.progress} className="mt-2" />}
                      {t.detail && <p className="mt-1.5 truncate text-[11px] text-faint">{t.detail}</p>}
                    </li>
                  ))}
                  {total > PER_LANE && <li className="px-2 pt-1 text-xs text-faint">and {formatCount(total - Math.min(PER_LANE, laneTracks.length))} more</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
