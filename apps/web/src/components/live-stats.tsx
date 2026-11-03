"use client";

import type { Stats } from "@mint/core/events";
import { formatBytes, formatCount, formatHours, timeAgo } from "@/lib/format";
import { useLiveStats } from "./realtime";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function N({ children }: { children: React.ReactNode }) {
  return <span className="whitespace-nowrap text-fg tabular">{children}</span>;
}

/** The library described in one live sentence, with the two ratios that matter underneath. */
export function LiveStats({ initial }: { initial: Stats }) {
  const s = useLiveStats(initial);
  const lidarr = s.bySource.lidarr ?? 0;
  const cobalt = s.bySource.cobalt ?? 0;
  const existing = s.existingTracks ?? 0;
  const lidarrShare = s.tracks ? lidarr / s.tracks : 0;
  const sonicShare = s.tracks ? s.sonicAnalyzed / s.tracks : 0;
  const inFlight = Object.entries(s.byStage)
    .filter(([k]) => k !== "ready" && k !== "failed")
    .reduce((n, [, v]) => n + (v ?? 0), 0);
  const workers = s.workersOnline ?? 0;

  return (
    <div>
      <p className="max-w-5xl text-3xl leading-[1.15] font-bold tracking-[-0.025em] text-faint sm:text-5xl sm:leading-[1.08]">
        <N>{formatCount(s.tracks)}</N> {plural(s.tracks, "song", "songs")} by <N>{formatCount(s.artists)}</N>{" "}
        {plural(s.artists, "artist", "artists")} across <N>{formatCount(s.albums)}</N> {plural(s.albums, "album", "albums")}.{" "}
        <N>{formatHours(s.durationSec)}</N> of music, <N>{formatBytes(s.bytes)}</N> on disk, shared with <N>{formatCount(s.members)}</N>{" "}
        {plural(s.members, "member", "members")}.
      </p>
      <p className="mt-6 max-w-3xl text-lg text-muted sm:text-xl" aria-live="polite">
        Right now <N>{formatCount(inFlight)}</N> {plural(inFlight, "song is", "songs are")} on the way in, <N>{formatCount(s.readyToday)}</N> landed
        today and <N>{formatCount(workers)}</N> {plural(workers, "volunteer is", "volunteers are")} online
        {s.failed > 0 && (
          <>
            . <span className="text-danger tabular">{formatCount(s.failed)}</span> {plural(s.failed, "needs", "need")} attention
          </>
        )}
        . <span className="text-sm text-faint">Updated {timeAgo(s.updatedAt)}.</span>
      </p>

      <div className="mt-12 grid gap-10 border-t border-line pt-8 md:grid-cols-2">
        <div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-semibold">Where songs came from</span>
            <span className="text-sm text-muted tabular">
              {formatCount(lidarr)} release · {formatCount(cobalt)} YouTube · {formatCount(existing)} existing
            </span>
          </div>
          <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-hover" aria-hidden>
            <div className="bg-mint transition-[width] duration-700 ease-out-expo" style={{ width: `${lidarrShare * 100}%` }} />
            <div className="bg-[#2f8f6a] transition-[width] duration-700 ease-out-expo" style={{ width: `${s.tracks ? cobalt / s.tracks * 100 : 0}%` }} />
            <div className="bg-muted transition-[width] duration-700 ease-out-expo" style={{ width: `${s.tracks ? existing / s.tracks * 100 : 0}%` }} />
          </div>
          <p className="mt-3 text-sm text-faint">Full releases through Lidarr and TorBox first. YouTube audio fills the gaps.</p>
        </div>
        <div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-semibold">Sonic analysis</span>
            <span className="text-sm text-muted tabular">
              {formatCount(s.sonicAnalyzed)} of {formatCount(s.tracks)}
            </span>
          </div>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-hover" aria-hidden>
            <div className="h-full bg-warn transition-[width] duration-700 ease-out-expo" style={{ width: `${sonicShare * 100}%` }} />
          </div>
          <p className="mt-3 text-sm text-faint">Analysed songs work with Plexamp Sonic Radio, Sweet Fades and sonically similar mixes.</p>
        </div>
      </div>
    </div>
  );
}
