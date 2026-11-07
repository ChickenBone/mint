import type { PlayerItem } from "@mint/client";

type Recording = { title: string; artist: string; album: string | null; durationSec: number | null };
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function uniqueRecordings<T extends Recording>(local: PlayerItem[], external: T[]): T[] {
  return external.filter((recording) => !local.some((item) => item.type === "track" &&
    normalize(item.title) === normalize(recording.title) && normalize(item.artist ?? "") === normalize(recording.artist) &&
    item.duration && recording.durationSec && Math.abs(item.duration / 1000 - recording.durationSec) <= 2.5 &&
    (!item.album || !recording.album || normalize(item.album) === normalize(recording.album))));
}

export function isCurrentSearch(request: string, active: string, aborted = false) {
  return !aborted && request === active;
}
