import type { RecordingSearchItem } from "./music-requests";
import type { PlayerItem } from "./player-protocol";

function normalize(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function sameRecording(local: PlayerItem, external: RecordingSearchItem) {
  if (local.type !== "track" || normalize(local.title) !== normalize(external.title) ||
      normalize(local.artist ?? "") !== normalize(external.artist)) return false;
  const localDuration = local.duration ? local.duration / 1000 : null;
  if (!localDuration || !external.durationSec || Math.abs(localDuration - external.durationSec) > 2.5) return false;
  return !local.album || !external.album || normalize(local.album) === normalize(external.album);
}

export function uniqueExternalResults(localTracks: PlayerItem[], recordings: RecordingSearchItem[]) {
  return recordings.filter((recording) => !localTracks.some((track) => sameRecording(track, recording)));
}

export function searchResponseIsCurrent(requestQuery: string, activeQuery: string, aborted: boolean) {
  return !aborted && requestQuery === activeQuery;
}
