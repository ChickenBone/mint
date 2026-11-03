import { optionalEnv, requireEnv } from "@mint/core/env";
import { http, httpJson, type RequestOpts } from "../http";

function base() {
  return requireEnv("PLEX_URL").replace(/\/$/, "");
}

function plex<T>(path: string, opts: RequestOpts = {}) {
  return httpJson<T>(`${base()}${path}`, {
    ...opts,
    headers: {
      "x-plex-token": requireEnv("PLEX_TOKEN"),
      "x-plex-client-identifier": "mint-worker",
      "x-plex-product": "Mint",
      ...opts.headers,
    },
  });
}

const section = () => requireEnv("PLEX_MUSIC_SECTION_ID");

/** Maps a path inside the worker container to the same file inside the Plex container. */
export function toPlexPath(localPath: string) {
  const from = optionalEnv("MUSIC_DIR", "/music");
  const to = optionalEnv("PLEX_MUSIC_DIR", from);
  return localPath.startsWith(from) ? to + localPath.slice(from.length) : localPath;
}

interface PlexTrack {
  ratingKey: string;
  title: string;
  musicAnalysisVersion?: string;
  Media?: Array<{ Part?: Array<{ id: number; file: string }> }>;
}

interface Container<T> {
  MediaContainer: { size: number; Metadata?: T[] };
}

export async function refreshPath(dir: string) {
  await plex(`/library/sections/${section()}/refresh`, { query: { path: toPlexPath(dir) } });
}

export async function findTrackByFile(localPath: string, title: string): Promise<PlexTrack | null> {
  const target = toPlexPath(localPath);
  const res = await plex<Container<PlexTrack>>(`/library/sections/${section()}/all`, {
    query: { type: 10, title },
  });
  for (const t of res.MediaContainer.Metadata ?? []) {
    if (t.Media?.some((m) => m.Part?.some((p) => p.file === target))) return t;
  }
  return null;
}

export async function getTrack(ratingKey: string): Promise<PlexTrack | null> {
  const res = await plex<Container<PlexTrack>>(`/library/metadata/${ratingKey}`).catch(() => null);
  return res?.MediaContainer.Metadata?.[0] ?? null;
}

export function isSonicallyAnalyzed(t: PlexTrack) {
  return Boolean(t.musicAnalysisVersion && Number(t.musicAnalysisVersion) > 0);
}

/** Asks Plex to (re)analyze the item; with Plex Pass + sonic analysis enabled this includes sonic analysis. */
export async function analyze(ratingKey: string) {
  await http(`${base()}/library/metadata/${ratingKey}/analyze`, {
    method: "PUT",
    headers: { "x-plex-token": requireEnv("PLEX_TOKEN") },
  });
}

let machineId: string | null = null;
async function machineIdentifier() {
  machineId ??= (await plex<{ MediaContainer: { machineIdentifier: string } }>("/identity")).MediaContainer.machineIdentifier;
  return machineId;
}

function itemsUri(mid: string, keys: string[]) {
  return `server://${mid}/com.plexapp.plugins.library/library/metadata/${keys.join(",")}`;
}

/** Creates the playlist if needed and appends any rating keys not already present. Returns the playlist ratingKey. */
export async function syncPlaylist(title: string, ratingKeys: string[], existingKey?: string | null): Promise<string | null> {
  if (!ratingKeys.length && !existingKey) return null;
  const mid = await machineIdentifier();
  let key = existingKey ?? null;
  if (key) {
    const ok = await plex(`/playlists/${key}`).then(
      () => true,
      () => false,
    );
    if (!ok) key = null;
  }
  if (!key) {
    if (!ratingKeys.length) return null;
    const res = await plex<Container<{ ratingKey: string }>>("/playlists", {
      method: "POST",
      query: { type: "audio", title, smart: 0, uri: itemsUri(mid, ratingKeys) },
    });
    return res.MediaContainer.Metadata?.[0]?.ratingKey ?? null;
  }
  const items = await plex<Container<{ ratingKey: string }>>(`/playlists/${key}/items`);
  const have = new Set((items.MediaContainer.Metadata ?? []).map((m) => m.ratingKey));
  const missing = ratingKeys.filter((k) => !have.has(k));
  for (let i = 0; i < missing.length; i += 100) {
    await plex(`/playlists/${key}/items`, { method: "PUT", query: { uri: itemsUri(mid, missing.slice(i, i + 100)) } });
  }
  return key;
}

export async function ping() {
  try {
    await plex("/identity", { timeoutMs: 5000, retries: 0 });
    return true;
  } catch {
    return false;
  }
}
