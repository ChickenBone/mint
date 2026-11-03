import type { TrackView } from "./events";
import type { Track } from "./db/schema";

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
