import assert from "node:assert/strict";
import test from "node:test";
import { isAppDestinationActive, legacyDiscoverHref, legacyLibraryHref, legacyMusicHref } from "../src/lib/app-routes";

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

test("primary navigation active state includes nested detail and Your music routes", () => {
  assert.equal(isAppDestinationActive("/app", "/app"), true);
  assert.equal(isAppDestinationActive("/app/discover/charts/apple-us", "/app/discover"), true);
  assert.equal(isAppDestinationActive("/app/library/albums/abc", "/app/library"), true);
  assert.equal(isAppDestinationActive("/app/downloads", "/app/collections"), true);
  assert.equal(isAppDestinationActive("/app/playlists/abc", "/app/collections"), true);
  assert.equal(isAppDestinationActive("/app/settings", "/app"), false);
  assert.equal(isAppDestinationActive("/appish", "/app"), false);
});
