import type { AdminAccountPage } from "@mint/contracts";

const libraryTabs: Record<string, string> = {
  album: "album",
  albums: "album",
  artist: "artist",
  artists: "artist",
  song: "track",
  songs: "track",
  track: "track",
  tracks: "track",
  playlist: "playlist",
  playlists: "playlist",
};

export type CollectionTab = "playlists" | "likes" | "requests" | "downloads" | "history";
export type PlaylistSourceFilter = "all" | "mint" | "youtube" | "spotify" | "smart";
export type SettingsSectionId = "account" | "services" | "playback" | "devices" | "storage";
export type ManageTab = "requests" | "reports" | "jobs" | "workers" | "analysis" | "matching";
export type ManageTabId = ManageTab;

export const listeningDestinations = [
  { href: "/app", label: "Home" },
  { href: "/app/search", label: "Search" },
  { href: "/app/collection", label: "Your Library" },
] as const;

const validCollectionTabs = new Set<CollectionTab>(["playlists", "likes", "requests", "downloads", "history"]);
const validPlaylistSources = new Set<PlaylistSourceFilter>(["all", "mint", "youtube", "spotify", "smart"]);
const validSettingsSections = new Set<SettingsSectionId>(["account", "services", "playback", "devices", "storage"]);
const validManageTabs = new Set<ManageTab>(["requests", "reports", "jobs", "workers", "analysis", "matching"]);

function withQuery(path: string, params: URLSearchParams) {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function resolveCollectionTab(params?: URLSearchParams | string | null): CollectionTab {
  if (typeof params === "string") {
    const normalized = params.toLowerCase() as CollectionTab;
    return validCollectionTabs.has(normalized) ? normalized : "playlists";
  }
  if (!params) return "playlists";
  const tab = params.get("tab")?.toLowerCase() as CollectionTab | undefined;
  if (tab && validCollectionTabs.has(tab)) return tab;
  if (params.has("kind") || params.has("track")) return "downloads";
  return "playlists";
}

export function resolvePlaylistSource(params?: URLSearchParams | string | null): PlaylistSourceFilter {
  if (typeof params === "string") {
    const normalized = params.toLowerCase() as PlaylistSourceFilter;
    return validPlaylistSources.has(normalized) ? normalized : "all";
  }
  if (!params) return "all";
  const source = params.get("source")?.toLowerCase() as PlaylistSourceFilter | undefined;
  return source && validPlaylistSources.has(source) ? source : "all";
}

export function resolveSettingsSection(section?: string | null): SettingsSectionId {
  const raw = section?.toLowerCase();
  if (raw === "offline") return "storage";
  const normalized = raw as SettingsSectionId | undefined;
  return normalized && validSettingsSections.has(normalized) ? normalized : "account";
}

export function resolveManageTab(tab?: string | null): ManageTab {
  const normalized = tab?.toLowerCase() as ManageTab | undefined;
  return normalized && validManageTabs.has(normalized) ? normalized : "requests";
}

export function manageAccountPageHref(
  current: URLSearchParams,
  name: "requestsCursor" | "membersCursor",
  cursor: string | null,
) {
  const params = new URLSearchParams(current);
  if (cursor) params.set(name, cursor);
  else params.delete(name);
  return withQuery("/app/manage", params);
}

export function targetManageAccounts(
  requests: AdminAccountPage,
  members: AdminAccountPage,
  requestsCursor?: string,
  membersCursor?: string,
) {
  return {
    requests: requests.items.map(({ id, name, email, requestNote, createdAt }) =>
      ({ id, name, email, requestNote, createdAt })),
    members: members.items.map(({ id, name, email, role, status, createdAt }) => ({
      id, name, email, role, status, created_at: createdAt,
      tracks: null, linked: null, last_synced_at: null,
    })),
    pagination: {
      requestsCursor: requestsCursor ?? null,
      membersCursor: membersCursor ?? null,
      nextRequestsCursor: requests.nextCursor,
      nextMembersCursor: members.nextCursor,
    },
  };
}

export function legacyMusicHref(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  const view = next.get("view");
  if (view === "now-playing") return "/app/now-playing";
  if (view === "search") {
    const search = new URLSearchParams();
    const query = next.get("q");
    if (query) search.set("q", query);
    return withQuery("/app/search", search);
  }

  next.delete("view");
  if (view === "library" && !next.has("type")) next.set("type", "album");
  if (next.get("kind") === "album" && next.has("id")) {
    const id = encodeURIComponent(next.get("id")!);
    next.delete("kind");
    next.delete("id");
    return withQuery(`/app/library/albums/${id}`, next);
  }
  if (next.get("kind") === "artist" && next.has("id")) {
    const id = encodeURIComponent(next.get("id")!);
    next.delete("kind");
    next.delete("id");
    return withQuery(`/app/library/artists/${id}`, next);
  }
  return withQuery("/app/library", next);
}

export function legacyLibraryHref(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  const tab = next.get("tab");
  if (tab) {
    next.delete("tab");
    const type = libraryTabs[tab.toLowerCase()];
    if (type) next.set("type", type);
  }
  return withQuery("/app/library", next);
}

export function legacyDiscoverHref(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  const chart = next.get("chart");
  if (chart) {
    next.delete("chart");
    return withQuery(`/app/discover/charts/${encodeURIComponent(chart)}`, next);
  }
  const tab = next.get("tab");
  if (tab === "charts") {
    return "/app/search#charts";
  }
  if (tab === "mixes" || next.has("mode") || next.has("seed")) {
    next.delete("tab");
    return withQuery("/app/discover/mixes", next);
  }
  return null;
}

export function legacyDiscoverDestination(params: URLSearchParams) {
  return legacyDiscoverHref(params) ?? "/app/search";
}

export function legacyCollectionsHref(params: URLSearchParams = new URLSearchParams()) {
  const next = new URLSearchParams(params);
  return withQuery("/app/collection", next);
}

export function legacyCollectionDetailHref(id: string, params: URLSearchParams = new URLSearchParams()) {
  const next = new URLSearchParams(params);
  return withQuery(`/app/collection/${encodeURIComponent(id)}`, next);
}

export function legacyLikedHref(params: URLSearchParams = new URLSearchParams()) {
  const next = new URLSearchParams(params);
  next.set("tab", "likes");
  return withQuery("/app/collection", next);
}

export function legacyDownloadsHref(params: URLSearchParams = new URLSearchParams()) {
  const next = new URLSearchParams(params);
  next.set("tab", "downloads");
  return withQuery("/app/collection", next);
}

export function legacyHistoryHref(params: URLSearchParams = new URLSearchParams()) {
  const next = new URLSearchParams(params);
  next.set("tab", "history");
  return withQuery("/app/collection", next);
}

export function legacySpotifyHref(params: URLSearchParams = new URLSearchParams()) {
  if (params.has("error") || params.has("linked")) {
    const next = new URLSearchParams();
    next.set("section", "services");
    if (params.get("error")) next.set("spotify_error", params.get("error")!);
    if (params.get("linked")) next.set("spotify_linked", params.get("linked")!);
    return withQuery("/app/settings", next);
  }
  const next = new URLSearchParams(params);
  next.set("tab", "playlists");
  next.set("source", "spotify");
  return withQuery("/app/collection", next);
}

export function legacyDevicesHref(params: URLSearchParams = new URLSearchParams()) {
  const next = new URLSearchParams(params);
  next.set("section", "devices");
  return withQuery("/app/settings", next);
}

export function legacyManageHref(
  tab: ManageTab | "admin",
  isAdmin: boolean,
  params: URLSearchParams = new URLSearchParams(),
) {
  if (!isAdmin) {
    if (tab === "jobs") return "/app/collection?tab=likes";
    if (tab === "workers") return "/app/settings?section=services";
    return "/app";
  }
  const next = new URLSearchParams(params);
  if (tab !== "requests" && tab !== "admin") next.set("tab", tab);
  else next.delete("tab");
  return withQuery("/app/manage", next);
}

export function isAppDestinationActive(pathname: string, href: string) {
  if (href === "/app/search" && pathname.startsWith("/app/discover/charts/")) return true;
  if (href === "/app/collection" || href === "/app/collections") {
    return [
      "/app/collection",
      "/app/collections",
      "/app/library",
      "/app/liked",
      "/app/spotify",
      "/app/downloads",
      "/app/history",
      "/app/playlists",
    ].some((route) => pathname === route || pathname.startsWith(`${route}/`));
  }
  if (href === "/app/settings") {
    return pathname === "/app/settings" || pathname.startsWith("/app/settings/") || pathname === "/app/devices";
  }
  if (href === "/app/manage") {
    return ["/app/manage", "/app/admin", "/app/jobs", "/app/workers"].some(
      (route) => pathname === route || pathname.startsWith(`${route}/`),
    );
  }
  if (href === "/app") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isAdminWorkspace(pathname: string, isAdmin: boolean) {
  return isAdmin && isAppDestinationActive(pathname, "/app/manage");
}
