"use client";

import type { TrackView } from "@mint/core/events";
import { useLiveTracks } from "./realtime";
import { TrackCard } from "./track-list";

const landed = (t: TrackView) => (t.stage === "ready" || t.stage === "analyzing") && t.hasPreview;

/** `liveAdd` lets newly landed songs from anyone join the shelf; turn off for per-member shelves. */
export function FreshShelf({ initial, limit = 12, liveAdd = true }: { initial: TrackView[]; limit?: number; liveAdd?: boolean }) {
  const { tracks } = useLiveTracks(initial, { keep: landed, accept: () => liveAdd, limit });
  if (!tracks.length) {
    return <p className="text-muted">The shelf is empty for now. The first songs show up here the moment they finish importing.</p>;
  }
  return (
    <div className="-mx-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {tracks.slice(0, limit).map((t) => (
        <TrackCard key={t.id} track={t} context={tracks} />
      ))}
    </div>
  );
}
