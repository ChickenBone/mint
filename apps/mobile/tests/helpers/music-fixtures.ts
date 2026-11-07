import type { CatalogPage, CollectionDetail, TrackView } from "@mint/client";

export const song: TrackView = {
  id: "00000000-0000-4000-8000-000000000001", title: "Fixture song", artist: "Fixture artist", album: "Fixture album",
  year: 2001, durationSec: 180, stage: "ready", progress: 100, detail: null, source: null, sonicAnalyzed: false,
  artworkUrl: "/api/artwork/fixture", youtubeVideoId: null, updatedAt: "2026-01-01T00:00:00Z",
};
export const catalogPage: CatalogPage = {
  title: "Fixture selection", total: 201, start: 100,
  items: [{ id: song.id, type: "track", title: song.title, artist: song.artist, artistId: "ar_fixture", thumb: song.artworkUrl,
    occurrenceId: "00000000-0000-4000-8000-000000000012" }],
};
export const collectionDetail: CollectionDetail = {
  id: "00000000-0000-4000-8000-000000000010", ownerId: "00000000-0000-4000-8000-000000000011",
  title: "Fixture playlist", description: "Fixture description", artworkUrl: null, rules: null, revision: 7,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", role: "owner",
  entries: [{ entryId: "00000000-0000-4000-8000-000000000012", position: 0, track: song },
    { entryId: "00000000-0000-4000-8000-000000000013", position: 1, track: song }],
  collaborators: [{ userId: "00000000-0000-4000-8000-000000000014", accepted: true, name: "Fixture collaborator", email: "fixture@example.com" }],
};
