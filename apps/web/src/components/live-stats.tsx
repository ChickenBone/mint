"use client";

import type { Stats } from "@mint/core/events";
import { formatBytes, formatCount, formatHours, timeAgo } from "@/lib/format";
import { useLiveStats } from "./realtime";

/** A single ledger line of library figures; updates in place as the worker publishes. */
export function LiveStats({ initial }: { initial: Stats }) {
  const s = useLiveStats(initial);
  const lidarrShare = s.tracks ? (s.bySource.lidarr ?? 0) / s.tracks : 0;
  const sonicShare = s.tracks ? s.sonicAnalyzed / s.tracks : 0;
  const inFlight = Object.entries(s.byStage)
    .filter(([k]) => k !== "ready" && k !== "failed")
    .reduce((n, [, v]) => n + (v ?? 0), 0);

  const figures: Array<[string, string]> = [
    [formatCount(s.tracks), s.tracks === 1 ? "song" : "songs"],
    [formatCount(s.artists), "artists"],
    [formatCount(s.albums), "albums"],
    [formatHours(s.durationSec), "of music"],
    [formatBytes(s.bytes), "on disk"],
    [formatCount(s.members), s.members === 1 ? "member" : "members"],
  ];

  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3 lg:grid-cols-6">
        {figures.map(([value, label]) => (
          <div key={label} className="flex flex-col-reverse">
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="text-3xl font-bold tracking-tight tabular sm:text-4xl">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-10 grid gap-8 md:grid-cols-2">
        <div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">Where songs came from</span>
            <span className="text-muted tabular">
              {formatCount(s.bySource.lidarr ?? 0)} release · {formatCount(s.bySource.cobalt ?? 0)} YouTube
            </span>
          </div>
          <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-hover" aria-hidden>
            <div className="bg-mint transition-[width] duration-700 ease-out-expo" style={{ width: `${lidarrShare * 100}%` }} />
            <div className="bg-[#2f8f6a] transition-[width] duration-700 ease-out-expo" style={{ width: `${(1 - lidarrShare) * (s.tracks ? 100 : 0)}%` }} />
          </div>
          <p className="mt-2 text-xs text-faint">Full releases through Lidarr and TorBox first; YouTube audio fills the gaps.</p>
        </div>
        <div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">Sonic analysis</span>
            <span className="text-muted tabular">
              {formatCount(s.sonicAnalyzed)} of {formatCount(s.tracks)}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-hover" aria-hidden>
            <div className="h-full bg-warn transition-[width] duration-700 ease-out-expo" style={{ width: `${sonicShare * 100}%` }} />
          </div>
          <p className="mt-2 text-xs text-faint">Analysed songs work with Plexamp Sonic Radio, Sweet Fades and sonically similar mixes.</p>
        </div>
      </div>

      <p className="mt-8 text-sm text-muted tabular">
        <span className="text-fg">{formatCount(inFlight)}</span> in the pipeline · <span className="text-fg">{formatCount(s.readyToday)}</span> landed today
        {s.failed > 0 && (
          <>
            {" "}· <span className="text-danger">{formatCount(s.failed)}</span> need attention
          </>
        )}{" "}
        · <span className="text-fg">{formatCount(s.workersOnline ?? 0)}</span> {s.workersOnline === 1 ? "worker" : "workers"} online · updated {timeAgo(s.updatedAt)}
      </p>
    </div>
  );
}
