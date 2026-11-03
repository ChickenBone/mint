import { numberEnv, optionalEnv, requireEnv } from "@mint/core/env";
import { httpJson, type RequestOpts } from "../http";

/**
 * LIDARR_ENABLED: "auto" (default) uses Lidarr only when TorBox is set, because TorBox is what
 * fulfils its blackhole downloads. "true" forces it on for setups with their own download client.
 */
export function lidarrEnabled() {
  const mode = process.env.LIDARR_ENABLED ?? "auto";
  if (mode === "false" || !process.env.LIDARR_URL || !process.env.LIDARR_API_KEY) return false;
  return mode === "true" || Boolean(process.env.TORBOX_API_KEY);
}

export function api<T>(path: string, opts: RequestOpts = {}) {
  return httpJson<T>(`${requireEnv("LIDARR_URL").replace(/\/$/, "")}/api/v1${path}`, {
    ...opts,
    headers: { "x-api-key": requireEnv("LIDARR_API_KEY"), ...opts.headers },
  });
}

interface Profile {
  id: number;
  name: string;
  items?: Array<{ allowed: boolean; quality?: { id: number; name: string }; items?: Profile["items"] }>;
}

export async function losslessProfile(): Promise<number | null> {
  const profiles = await api<Profile[]>("/qualityprofile");
  const leaves = (items: NonNullable<Profile["items"]>): Array<{ allowed: boolean; quality?: { id: number; name: string } }> =>
    items.flatMap((item) => item.items?.length ? leaves(item.items).map((leaf) => ({ ...leaf, allowed: item.allowed && leaf.allowed })) : [item]);
  const good = profiles.filter((p) => {
    const allowed = leaves(p.items ?? []).filter((q) => q.allowed);
    return allowed.length > 0 && allowed.every((q) => /^(flac|alac|wav|ape|wavpack)(?:[ -]|$)/i.test(q.quality?.name ?? ""));
  });
  return good[0]?.id ?? null;
}
interface LidarrArtist {
  id: number;
  foreignArtistId: string;
  artistName: string;
}
export interface LidarrAlbum {
  id: number;
  foreignAlbumId: string;
  title: string;
  monitored: boolean;
  statistics?: { trackFileCount: number; trackCount: number };
}
export interface LidarrQueueItem {
  id: number;
  albumId?: number;
  title: string;
  status: string;
  trackedDownloadState?: string;
  trackedDownloadStatus?: string;
  size: number;
  sizeleft: number;
  downloadId?: string;
  errorMessage?: string;
  statusMessages?: Array<{ title: string; messages: string[] }>;
}
interface LidarrTrack {
  id: number;
  title: string;
  foreignRecordingId?: string;
  foreignTrackId?: string;
  trackFileId: number;
  hasFile: boolean;
}

let defaults: Promise<{ rootFolderPath: string; qualityProfileId: number; metadataProfileId: number }> | null = null;

function getDefaults() {
  defaults ??= (async () => {
    const [roots, qps, mps] = await Promise.all([
      api<Array<{ path: string }>>("/rootfolder"),
      api<Profile[]>("/qualityprofile"),
      api<Profile[]>("/metadataprofile"),
    ]);
    const rootFolderPath = optionalEnv("LIDARR_ROOT_FOLDER", roots[0]?.path ?? "");
    if (!rootFolderPath) throw new Error("Lidarr has no root folder configured");
    const qp = numberEnv("LIDARR_QUALITY_PROFILE_ID", 0) || qps[0]?.id;
    const mp = numberEnv("LIDARR_METADATA_PROFILE_ID", 0) || mps[0]?.id;
    if (!qp || !mp) throw new Error("Lidarr quality/metadata profiles missing");
    return { rootFolderPath, qualityProfileId: qp, metadataProfileId: mp };
  })().catch((err) => {
    defaults = null;
    throw err;
  });
  return defaults;
}

export async function ensureArtist(mbArtistId: string, qualityProfileId?: number): Promise<LidarrArtist> {
  const existing = await api<LidarrArtist[]>("/artist", { query: { mbId: mbArtistId } });
  const hit = existing.find((a) => a.foreignArtistId === mbArtistId);
  if (hit) {
    if (qualityProfileId) return api<LidarrArtist>(`/artist/${hit.id}`, { method: "PUT", body: { ...hit, qualityProfileId } });
    return hit;
  }

  const [lookup] = await api<Array<Record<string, unknown>>>("/artist/lookup", { query: { term: `lidarr:${mbArtistId}` } });
  if (!lookup) throw new Error(`Lidarr could not find artist ${mbArtistId}`);
  const d = await getDefaults();
  return api<LidarrArtist>("/artist", {
    method: "POST",
    body: {
      ...lookup,
      ...d,
      ...(qualityProfileId ? { qualityProfileId } : {}),
      monitored: true,
      monitorNewItems: "none",
      addOptions: { monitor: "none", searchForMissingAlbums: false },
    },
  });
}

export async function findAlbum(mbReleaseGroupId: string): Promise<LidarrAlbum | null> {
  const albums = await api<LidarrAlbum[]>("/album", {
    query: { foreignAlbumId: mbReleaseGroupId, includeAllArtistAlbums: true },
  });
  return albums.find((a) => a.foreignAlbumId === mbReleaseGroupId) ?? null;
}

export async function monitorAndSearch(albumId: number) {
  await api("/album/monitor", { method: "PUT", body: { albumIds: [albumId], monitored: true } });
  await api("/command", { method: "POST", body: { name: "AlbumSearch", albumIds: [albumId] } });
}

export async function queueForAlbum(albumId: number): Promise<LidarrQueueItem[]> {
  return api<LidarrQueueItem[]>("/queue/details", { query: { albumIds: albumId } });
}

/** Path of the imported file for a recording on an album, if Lidarr has it. */
export async function importedFile(
  albumId: number,
  match: { recordingId?: string | null; title: string },
): Promise<{ path: string; size: number } | null> {
  const tracks = await api<LidarrTrack[]>("/track", { query: { albumId } });
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const track =
    tracks.find((t) => match.recordingId && t.foreignRecordingId === match.recordingId) ??
    tracks.find((t) => norm(t.title) === norm(match.title));
  if (!track?.hasFile || !track.trackFileId) return null;
  const file = await api<{ path: string; size: number }>(`/trackfile/${track.trackFileId}`);
  return { path: file.path, size: file.size };
}

export async function ping(): Promise<boolean> {
  try {
    await api("/system/status", { timeoutMs: 5000, retries: 0 });
    return true;
  } catch {
    return false;
  }
}
