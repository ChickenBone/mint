/**
 * Wire protocol between volunteer workers (mint-agent) and the Mint web API.
 * Type-only so the agent can import it without pulling in server dependencies.
 */

export const AGENT_PROTOCOL_VERSION = 1;
/** A worker counts as online if it heartbeated within this window. */
export const WORKER_ONLINE_MS = 90_000;
/** How long a claimed job stays reserved without a progress report. */
export const LEASE_MS = 5 * 60_000;

export interface HeartbeatRequest {
  version: string;
  protocol: number;
  activeJobs: number;
  capabilities: { cobalt: boolean; concurrency: number };
}

export interface HeartbeatResponse {
  worker: { id: string; name: string; status: "pending" | "active" | "disabled" };
  /** Suggested delay between claim attempts when the pool is empty. */
  pollMs: number;
  heartbeatMs: number;
}

export interface ClaimedJob {
  trackId: string;
  leaseId: string;
  leaseExpiresAt: string;
  youtubeVideoId: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number | null;
  upload: { url: string; token: string; maxBytes: number };
}

export interface ProgressRequest {
  leaseId: string;
  phase: "downloading" | "uploading";
  progress: number | null;
  bytes?: number;
}

export interface FailRequest {
  leaseId: string;
  error: string;
  /** True when the worker is shutting down: return the job to the pool without counting a failure. */
  release?: boolean;
}

export interface UploadTokenPayload {
  trackId: string;
  workerId: string;
  leaseId: string;
}

export interface WorkerView {
  id: string;
  name: string;
  status: "pending" | "active" | "disabled";
  online: boolean;
  lastSeenAt: string | null;
  version: string | null;
  activeJobs: number;
  completed: number;
  failed: number;
  bytes: number;
}
