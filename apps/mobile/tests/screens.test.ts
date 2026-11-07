import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { activeTab, consumerTabs } from "../src/shell/navigation";

test("consumer navigation contains only music destinations and preserves detail context", () => {
  assert.deepEqual(consumerTabs.map((tab) => tab.href), ["/", "/search", "/library"]);
  assert.equal(activeTab("/album/al_example"), "/library");
  assert.equal(activeTab("/collection/liked"), "/library");
  assert.equal(activeTab("/artist/ar_example"), "/library");
  assert.equal(activeTab("/search"), "/search");
});

test("route layout mounts one persistent provider and does not key it to navigation", () => {
  const root = readFileSync(resolve("app/_layout.tsx"), "utf8");
  const shell = readFileSync(resolve("src/shell/ConsumerShell.tsx"), "utf8");
  assert.equal((root.match(/<PlayerProvider>/g) ?? []).length, 1);
  assert.match(root, /<ConsumerShell><Slot \/><\/ConsumerShell>/);
  assert.doesNotMatch(root, /key=\{/);
  assert.equal((shell.match(/<PlayerSurface /g) ?? []).length, 1);
  assert.doesNotMatch(shell, /Mint|charts|admin|manage|workers|analysis/);
  assert.deepEqual(readdirSync(resolve("app")).filter((path) => /charts|admin|manage|workers|analysis/.test(path)), []);
});

test("acquisition remains an explicit search action, never a browse or play side effect", () => {
  for (const file of ["home/HomeScreen.tsx", "your-music/LibraryScreen.tsx", "albums/AlbumScreen.tsx", "artists/ArtistScreen.tsx", "playlists/PlaylistScreen.tsx"]) {
    assert.doesNotMatch(readFileSync(resolve("src/features", file), "utf8"), /requestRecording|searchRecordings/);
  }
  const search = readFileSync(resolve("src/features/search/SearchScreen.tsx"), "utf8");
  assert.match(search, /onPress=\{\(\) => void request\(recording\.id, recording\.token\)\}/);
  assert.equal((search.match(/api\.requestRecording/g) ?? []).length, 1);
});
