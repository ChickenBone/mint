import type { PlayerItem } from "./playback";

type RecordingIdentity = {
  id?: string; title: string; artist: string; album: string | null; durationSec: number | null;
  existing?: { id: string; playable: boolean; recordingId?: string | null } | null;
};

export function normalizeSearchText(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function sameRecording(local: PlayerItem, recording: RecordingIdentity) {
  if (local.type !== "track" || !normalizeSearchText(local.title) || !normalizeSearchText(local.artist ?? "") ||
      normalizeSearchText(local.title) !== normalizeSearchText(recording.title) ||
      normalizeSearchText(local.artist ?? "") !== normalizeSearchText(recording.artist)) return false;
  if (recording.existing?.id === local.id && recording.id && recording.existing.recordingId &&
      recording.id.toLowerCase() !== recording.existing.recordingId.toLowerCase()) return false;
  const duration = local.duration ? local.duration / 1000 : null;
  if (duration && recording.durationSec && Math.abs(duration - recording.durationSec) > 2.5) return false;
  // The same recording can appear on a compilation or have incomplete public metadata.
  if (recording.existing?.id === local.id) return true;
  return Boolean(duration && recording.durationSec &&
    (!local.album || !recording.album || normalizeSearchText(local.album) === normalizeSearchText(recording.album)));
}

export function uniqueRecordingResults<T extends RecordingIdentity>(local: PlayerItem[], recordings: T[]): T[] {
  const byId = new Map<string, T>();
  for (const recording of recordings) {
    if (!recording.id) continue;
    const previous = byId.get(recording.id);
    if (!previous || (!previous.existing?.playable && recording.existing?.playable)) byId.set(recording.id, recording);
  }
  const emitted = new Set<string>();
  return recordings.flatMap((recording) => {
    if (recording.id && emitted.has(recording.id)) return [];
    if (recording.id) emitted.add(recording.id);
    const preferred = recording.id ? byId.get(recording.id)! : recording;
    return local.some((item) => sameRecording(item, preferred)) ? [] : [preferred];
  });
}
