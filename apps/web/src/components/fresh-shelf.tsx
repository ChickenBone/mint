"use client";

import type { TrackView } from "@mint/core/events";
import clsx from "clsx";
import { useState } from "react";
import { useLiveTracks } from "./realtime";
import { TrackCard } from "./track-list";

const landed = (t: TrackView) => t.stage === "ready" || t.stage === "analyzing";

/**
 * Newest arrivals, led by one oversized cover. `liveAdd` lets songs that land while
 * the page is open drop in at the front; turn it off for per-member shelves.
 */
export function FreshShelf({
  initial,
  limit = 12,
  liveAdd = true,
  feature = true,
  className,
}: {
  initial: TrackView[];
  limit?: number;
  liveAdd?: boolean;
  feature?: boolean;
  className?: string;
}) {
  const { tracks } = useLiveTracks(initial, { keep: landed, accept: () => liveAdd, limit });
  const [seen] = useState(() => new Set(initial.map((t) => t.id)));
  if (!tracks.length) {
    return <p className="text-muted">The shelf is empty for now. The first songs show up here the moment they finish importing.</p>;
  }
  const shown = tracks.slice(0, limit);
  return (
    <div className={clsx("grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 sm:gap-x-5", className)}>
      {shown.map((t, i) => (
        <TrackCard key={t.id} track={t} feature={feature && i === 0 && shown.length >= 5} landing={!seen.has(t.id)} />
      ))}
    </div>
  );
}
