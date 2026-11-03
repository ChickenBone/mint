import type { Redis } from "ioredis";
import type { WorkerView } from "./agent-protocol";
import type { Source, Stage } from "./stages";

export const CHANNEL = {
  public: "mint:public",
  admin: "mint:admin",
  user: (id: string) => `mint:user:${id}`,
} as const;

export interface Stats {
  tracks: number;
  artists: number;
  albums: number;
  members: number;
  durationSec: number;
  bytes: number;
  sonicAnalyzed: number;
  bySource: Record<Source, number>;
  byStage: Partial<Record<Stage, number>>;
  readyToday: number;
  failed: number;
  workersOnline: number;
  updatedAt: string;
}

/** Public-safe projection of a track. Never includes user identity or file paths. */
export interface TrackView {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  year: number | null;
  durationSec: number | null;
  stage: Stage;
  progress: number;
  detail: string | null;
  source: Source | null;
  sonicAnalyzed: boolean;
  /** Remote cover art URL; never served from the home server. */
  artworkUrl: string;
  youtubeVideoId: string;
  updatedAt: string;
}

export interface SyncState {
  status: "idle" | "syncing" | "error";
  message: string | null;
  found?: number;
  added?: number;
  lastSyncedAt?: string | null;
}

export type RealtimeEvent =
  | { type: "hello"; data: { user: { id: string; name: string; role: "user" | "admin" } | null } }
  | { type: "stats"; data: Stats }
  | { type: "track"; data: TrackView }
  | { type: "sync"; data: SyncState }
  | { type: "library"; data: { trackIds: string[] } }
  | { type: "access-request"; data: { pending: number } }
  | { type: "worker"; data: WorkerView };

export async function publish(redis: Redis, channel: string, event: RealtimeEvent) {
  await redis.publish(channel, JSON.stringify(event));
}
