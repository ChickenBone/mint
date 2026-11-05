import assert from "node:assert/strict";
import test from "node:test";
import {
  isAppDestinationActive,
  legacyCollectionDetailHref,
  legacyCollectionsHref,
  legacyDevicesHref,
  legacyDiscoverHref,
  legacyDownloadsHref,
  legacyHistoryHref,
  legacyLibraryHref,
  legacyLikedHref,
  legacyManageHref,
  legacyMusicHref,
  legacySpotifyHref,
  resolveCollectionTab,
  resolveManageTab,
  resolvePlaylistSource,
  resolveSettingsSection,
} from "../src/lib/app-routes";

test("legacy music views redirect to canonical destinations and preserve search state", () => {
  assert.equal(legacyMusicHref(new URLSearchParams("view=now-playing")), "/app/now-playing");
  assert.equal(legacyMusicHref(new URLSearchParams("view=search&q=quiet+orbit")), "/app/search?q=quiet+orbit");
  assert.equal(legacyMusicHref(new URLSearchParams("view=library&type=track&q=orbit")), "/app/library?type=track&q=orbit");
  assert.equal(legacyMusicHref(new URLSearchParams("view=library&kind=album&id=abc&type=track")), "/app/library/albums/abc?type=track");
});

test("legacy library tabs map to canonical catalog types", () => {
  assert.equal(legacyLibraryHref(new URLSearchParams("tab=artists&q=paper")), "/app/library?q=paper&type=artist");
  assert.equal(legacyLibraryHref(new URLSearchParams("tab=songs")), "/app/library?type=track");
  assert.equal(legacyLibraryHref(new URLSearchParams("tab=unknown")), "/app/library");
});

test("legacy discover tabs map to real subroutes", () => {
  assert.equal(legacyDiscoverHref(new URLSearchParams("chart=apple-us")), "/app/discover/charts/apple-us");
  assert.equal(legacyDiscoverHref(new URLSearchParams("tab=charts")), "/app/discover/charts");
  assert.equal(legacyDiscoverHref(new URLSearchParams("tab=mixes&mode=recent")), "/app/discover/mixes?mode=recent");
  assert.equal(legacyDiscoverHref(new URLSearchParams()), null);
});

test("legacy Your music routes redirect to /app/collection and preserve query state", () => {
  assert.equal(legacyCollectionsHref(), "/app/collection");
  assert.equal(legacyCollectionsHref(new URLSearchParams("folder=favs")), "/app/collection?folder=favs");
  assert.equal(legacyCollectionDetailHref("pl-1"), "/app/collection/pl-1");
  assert.equal(legacyLikedHref(), "/app/collection?tab=likes");
  assert.equal(legacyDownloadsHref(new URLSearchParams("track=123&title=Song")), "/app/collection?track=123&title=Song&tab=downloads");
  assert.equal(legacyHistoryHref(), "/app/collection?tab=history");
  assert.equal(legacySpotifyHref(), "/app/collection?tab=playlists&source=spotify");
  assert.equal(legacySpotifyHref(new URLSearchParams("linked=1")), "/app/settings?section=services&spotify_linked=1");
});

test("legacy devices and management routes redirect with role-aware destinations", () => {
  assert.equal(legacyDevicesHref(), "/app/settings?section=devices");
  assert.equal(legacyDevicesHref(new URLSearchParams("party=invite-token")), "/app/settings?party=invite-token&section=devices");

  // Admins go to /app/manage tabs; non-admins are routed to listener-safe equivalents
  assert.equal(legacyManageHref("admin", true), "/app/manage");
  assert.equal(legacyManageHref("admin", false), "/app");
  assert.equal(legacyManageHref("jobs", true), "/app/manage?tab=jobs");
  assert.equal(legacyManageHref("jobs", false), "/app/collection?tab=likes");
  assert.equal(legacyManageHref("workers", true), "/app/manage?tab=workers");
  assert.equal(legacyManageHref("workers", false), "/app/settings?section=services");
  assert.equal(legacyManageHref("analysis", true), "/app/manage?tab=analysis");
  assert.equal(legacyManageHref("analysis", false), "/app");
});

test("Your music, Settings and Management tab/section resolvers normalize query values", () => {
  assert.equal(resolveCollectionTab("likes"), "likes");
  assert.equal(resolveCollectionTab("downloads"), "downloads");
  assert.equal(resolveCollectionTab("history"), "history");
  assert.equal(resolveCollectionTab("invalid"), "playlists");

  assert.equal(resolvePlaylistSource("mint"), "mint");
  assert.equal(resolvePlaylistSource("youtube"), "youtube");
  assert.equal(resolvePlaylistSource("spotify"), "spotify");
  assert.equal(resolvePlaylistSource("smart"), "smart");
  assert.equal(resolvePlaylistSource("other"), "all");

  assert.equal(resolveSettingsSection("services"), "services");
  assert.equal(resolveSettingsSection("playback"), "playback");
  assert.equal(resolveSettingsSection("devices"), "devices");
  assert.equal(resolveSettingsSection("offline"), "storage");
  assert.equal(resolveSettingsSection("storage"), "storage");
  assert.equal(resolveSettingsSection("account"), "account");
  assert.equal(resolveSettingsSection(null), "account");

  assert.equal(resolveManageTab("jobs"), "jobs");
  assert.equal(resolveManageTab("workers"), "workers");
  assert.equal(resolveManageTab("analysis"), "analysis");
  assert.equal(resolveManageTab("unknown"), "requests");
});

test("primary navigation active state includes nested detail, Your music, Settings and Management routes", () => {
  assert.equal(isAppDestinationActive("/app", "/app"), true);
  assert.equal(isAppDestinationActive("/app/discover/charts/apple-us", "/app/discover"), true);
  assert.equal(isAppDestinationActive("/app/library/albums/abc", "/app/library"), true);
  assert.equal(isAppDestinationActive("/app/collection", "/app/collection"), true);
  assert.equal(isAppDestinationActive("/app/collection/abc", "/app/collection"), true);
  assert.equal(isAppDestinationActive("/app/downloads", "/app/collection"), true);
  assert.equal(isAppDestinationActive("/app/playlists/abc", "/app/collection"), true);
  assert.equal(isAppDestinationActive("/app/devices", "/app/settings"), true);
  assert.equal(isAppDestinationActive("/app/manage", "/app/manage"), true);
  assert.equal(isAppDestinationActive("/app/admin/analysis", "/app/manage"), true);
  assert.equal(isAppDestinationActive("/app/settings", "/app"), false);
  assert.equal(isAppDestinationActive("/appish", "/app"), false);
});
