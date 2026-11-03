"use client";

import type { TrackView } from "@mint/core/events";
import { useRouter } from "next/navigation";
import { TrackList } from "../track-list";
import { useLiveTracks, useRealtime } from "../realtime";
import { RetryButton } from "./retry-button";
import type { PlayerCollection } from "@/lib/player-protocol";

/**
 * A member's list that updates rows in place from public track events and
 * re-fetches when the member's own library changes (new likes, removals).
 */
export function LiveTrackList({
  initial,
  mode = "library",
  empty,
  collection,
}: {
  initial: TrackView[];
  mode?: "library" | "jobs";
  empty?: React.ReactNode;
  collection?: PlayerCollection;
}) {
  const router = useRouter();
  const { tracks, flash } = useLiveTracks(initial, {
    keep: mode === "jobs" ? (t) => t.stage !== "ready" : () => true,
    accept: () => false,
    limit: 2000,
  });
  useRealtime((e) => {
    if (e.type === "library") router.refresh();
  });
  return (
    <TrackList
      tracks={tracks}
      collection={collection}
      flash={flash}
      showStage={mode === "jobs"}
      empty={empty}
      actions={(t) => (t.stage === "failed" ? <RetryButton trackId={t.id} /> : mode === "jobs" && t.stage === "searching" ? <RetryButton trackId={t.id} forceCobalt /> : null)}
    />
  );
}
