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

function withQuery(path: string, params: URLSearchParams) {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
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
    next.delete("tab");
    return withQuery("/app/discover/charts", next);
  }
  if (tab === "mixes" || next.has("mode") || next.has("seed")) {
    next.delete("tab");
    return withQuery("/app/discover/mixes", next);
  }
  return null;
}

export function isAppDestinationActive(pathname: string, href: string) {
  if (href === "/app/collections") {
    return ["/app/collections", "/app/liked", "/app/spotify", "/app/downloads", "/app/history", "/app/playlists"]
      .some((route) => pathname === route || pathname.startsWith(`${route}/`));
  }
  if (href === "/app") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
