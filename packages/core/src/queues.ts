export const QUEUE = {
  sync: "mint-sync",
  acquire: "mint-acquire",
  finalize: "mint-finalize",
  sonic: "mint-sonic",
  artistMetadata: "mint-artist-metadata",
  torbox: "mint-torbox",
  maintenance: "mint-maintenance",
} as const;

export interface SyncJob {
  userId: string;
  reason: "manual" | "schedule" | "linked";
}

export interface AcquireJob {
  trackId: string;
  requestedBy?: string;
  /** Internal state machine cursor; survives delayed re-queues. */
  step?: "match" | "lidarr-add" | "lidarr-wait" | "cobalt";
  lidarrAlbumId?: number;
  lidarrStartedAt?: number;
  forceCobalt?: boolean;
  /** Rip on this host even if volunteer workers are online. */
  local?: boolean;
  /** How many times this download has waited for a busy YouTube search. */
  youtubeWaits?: number;
}

export interface FinalizeJob {
  trackId: string;
  /** Absolute path of the downloaded audio file on the shared media volume. */
  sourcePath: string;
  source: "lidarr" | "cobalt";
  /** Volunteer worker that uploaded the file. */
  workerId?: string;
  /** Lidarr already placed and tagged the file in the library; skip tag/move. */
  inLibrary: boolean;
}

export interface SonicJob {
  trackId: string;
  startedAt: number;
}

export interface TorboxJob {
  torrentId: number;
  name: string;
  protocol?: "torrent" | "usenet";
}

export interface ArtistMetadataJob {
  artistName: string;
}

export type MaintenanceJob =
  | { kind: "schedule-sync" }
  | { kind: "stats" }
  | { kind: "torbox-tick" }
  | { kind: "health" }
  | { kind: "library-index" }
  | { kind: "artwork" }
  | { kind: "artist-metadata" }
  | { kind: "leases" }
  | { kind: "listening-queues" }
  | { kind: "plex-playlists"; userId: string };

export const jobId = {
  sync: (userId: string) => `sync-${userId}`,
  acquire: (trackId: string) => `acquire-${trackId}`,
  finalize: (trackId: string) => `finalize-${trackId}`,
  sonic: (trackId: string) => `sonic-${trackId}`,
  torbox: (torrentId: number, protocol: "torrent" | "usenet" = "torrent") => protocol === "torrent" ? `torbox-${torrentId}` : `torbox-usenet-${torrentId}`,
  plexPlaylists: (userId: string) => `plex-playlists-${userId}`,
};
