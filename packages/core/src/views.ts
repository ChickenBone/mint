import { WORKER_ONLINE_MS, type WorkerView } from "./agent-protocol";
import type { TrackView } from "./events";
import type { Track, Worker } from "./db/schema";

export function toTrackView(t: Track): TrackView {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    year: t.year,
    durationSec: t.durationSec,
    stage: t.stage,
    progress: t.progress,
    detail: t.detail,
    source: t.source,
    sonicAnalyzed: t.sonicAnalyzed,
    hasPreview: t.hasPreview,
    hasArtwork: t.hasArtwork,
    youtubeVideoId: t.youtubeVideoId,
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function toWorkerView(w: Worker): WorkerView {
  return {
    id: w.id,
    name: w.name,
    status: w.status,
    online: Boolean(w.lastSeenAt && Date.now() - w.lastSeenAt.getTime() < WORKER_ONLINE_MS),
    lastSeenAt: w.lastSeenAt?.toISOString() ?? null,
    version: w.version,
    activeJobs: w.activeJobs,
    completed: w.completed,
    failed: w.failed,
    bytes: w.bytes,
  };
}
