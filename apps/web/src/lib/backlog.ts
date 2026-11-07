import type { TrackView } from "@mint/core/events";

export type BacklogState = "playable" | "on-the-way" | "attention";
export type BacklogFilter = "all" | BacklogState;

export function backlogState(stage: TrackView["stage"]): BacklogState {
  if (stage === "ready" || stage === "analyzing") return "playable";
  if (stage === "failed") return "attention";
  return "on-the-way";
}

export function backlogStateLabel(state: BacklogState) {
  return state === "playable" ? "Playable" : state === "on-the-way" ? "On the way" : "Needs attention";
}

export function filterBacklog<T extends { stage: TrackView["stage"] }>(tracks: T[], filter: BacklogFilter): T[] {
  return filter === "all" ? tracks : tracks.filter((track) => backlogState(track.stage) === filter);
}
