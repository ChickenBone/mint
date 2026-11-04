import type { Track } from "./db/schema";

export const artworkPath = (trackId: string) => `/api/artwork/${trackId}`;

export function trackArtworkUrl(track: Pick<Track, "id" | "plexRatingKey" | "artworkUrl" | "youtubeVideoId" | "mbReleaseGroupId">) {
  return track.plexRatingKey || track.artworkUrl || track.youtubeVideoId || track.mbReleaseGroupId ? artworkPath(track.id) : "";
}
