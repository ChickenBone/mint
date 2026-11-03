export const QUEUE = {
  sync: "mint-sync",
  acquire: "mint-acquire",
  finalize: "mint-finalize",
  sonic: "mint-sonic",
  torbox: "mint-torbox",
  maintenance: "mint-maintenance",
} as const;

export interface SyncJob {
  userId: string;
  reason: "manual" | "schedule" | "linked";
}

export interface AcquireJob {
  trackId: string;
  /** Internal state machine cursor; survives delayed re-queues. */
  step?: "match" | "lidarr-add" | "lidarr-wait" | "cobalt";
  lidarrAlbumId?: number;
  lidarrStartedAt?: number;
  forceCobalt?: boolean;
}

export interface FinalizeJob {
  trackId: string;
  /** Absolute path of the downloaded audio file on the shared media volume. */
  sourcePath: string;
  source: "lidarr" | "cobalt";
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
}

export type MaintenanceJob =
  | { kind: "schedule-sync" }
  | { kind: "stats" }
  | { kind: "torbox-tick" }
  | { kind: "health" }
  | { kind: "plex-playlists"; userId: string };

export const jobId = {
  sync: (userId: string) => `sync:${userId}`,
  acquire: (trackId: string) => `acquire:${trackId}`,
  finalize: (trackId: string) => `finalize:${trackId}`,
  sonic: (trackId: string) => `sonic:${trackId}`,
  torbox: (torrentId: number) => `torbox:${torrentId}`,
  plexPlaylists: (userId: string) => `plex-playlists:${userId}`,
};
