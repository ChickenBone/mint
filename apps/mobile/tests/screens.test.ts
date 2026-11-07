import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { activeTab, consumerTabs, greeting } from "../src/screens/navigation";
import { isCurrentSearch, uniqueRecordings } from "../src/screens/search-model";
import { reorderedEntries } from "../src/screens/collection-model";

test("consumer navigation contains only music destinations and preserves detail context", () => {
  assert.deepEqual(consumerTabs.map((tab) => tab.href), ["/", "/search", "/library"]);
  assert.equal(activeTab("/album/al_example"), "/library");
  assert.equal(activeTab("/collection/liked"), "/library");
  assert.equal(activeTab("/artist/ar_example"), "/library");
  assert.equal(activeTab("/search"), "/search");
  assert.equal(greeting(9), "Good morning");
  assert.equal(greeting(13), "Good afternoon");
  assert.equal(greeting(22), "Good evening");
});

test("search ignores stale and aborted responses", () => {
  assert.equal(isCurrentSearch("old", "new"), false);
  assert.equal(isCurrentSearch("same", "same", true), false);
  assert.equal(isCurrentSearch("same", "same"), true);
});

test("mixed search suppresses only conservatively confirmed recordings", () => {
  const local = [{ id: "local", type: "track" as const, title: "Écho", artist: "A Band", album: "First", duration: 180000 }];
  const matches = [
    { id: "same", title: "Echo", artist: "A Band", album: "First", durationSec: 180 },
    { id: "live", title: "Echo", artist: "A Band", album: "Live", durationSec: 180 },
    { id: "unknown", title: "Echo", artist: "A Band", album: "First", durationSec: null },
    { id: "long", title: "Echo", artist: "A Band", album: "First", durationSec: 240 },
  ];
  assert.deepEqual(uniqueRecordings(local, matches).map((item) => item.id), ["live", "unknown", "long"]);
});

test("playlist reorder retains duplicate song occurrences without mutating input", () => {
  const original = ["song-a-first", "song-b", "song-a-second"];
  assert.deepEqual(reorderedEntries(original, "song-a-second", -1), ["song-a-first", "song-a-second", "song-b"]);
  assert.deepEqual(original, ["song-a-first", "song-b", "song-a-second"]);
  assert.throws(() => reorderedEntries(original, "missing", 1), /Reload/);
  assert.throws(() => reorderedEntries(original, "song-a-first", -1), /Reload/);
  assert.throws(() => reorderedEntries(["same", "same"], "same", 1), /Reload/);
});

test("route layout mounts one persistent provider and does not key it to navigation", () => {
  const root = readFileSync(resolve("app/_layout.tsx"), "utf8");
  const shell = readFileSync(resolve("src/screens/ConsumerShell.tsx"), "utf8");
  assert.equal((root.match(/<PlayerProvider>/g) ?? []).length, 1);
  assert.match(root, /<ConsumerShell><Slot \/><\/ConsumerShell>/);
  assert.doesNotMatch(root, /key=\{/);
  assert.equal((shell.match(/<PlayerSurface /g) ?? []).length, 1);
  assert.doesNotMatch(shell, /Mint|charts|admin|manage|workers|analysis/);
  assert.deepEqual(readdirSync(resolve("app")).filter((path) => /charts|admin|manage|workers|analysis/.test(path)), []);
});

test("app info is the final Settings section and exposes update diagnostics", () => {
  const settings = readFileSync(resolve("src/screens/SettingsScreen.tsx"), "utf8");
  const sections = [...settings.matchAll(/<Section title="([^"]+)">/g)].map((match) => match[1]);
  assert.equal(sections[sections.length - 1], "App info");
  assert.match(settings, /Runtime: \{Updates\.runtimeVersion/);
  assert.match(settings, /Channel: \{Updates\.channel/);
  assert.match(settings, /Running update: \{Updates\.updateId/);
  assert.match(settings, /Recovery detail: \{Updates\.emergencyLaunchReason/);
  assert.doesNotMatch(settings, /Constants\.platform\?\.android\?\.versionCode/);
});

test("acquisition remains an explicit search action, never a browse or play side effect", () => {
  for (const file of ["HomeScreen.tsx", "LibraryScreen.tsx", "DetailScreen.tsx"]) {
    assert.doesNotMatch(readFileSync(resolve("src/screens", file), "utf8"), /requestRecording|searchRecordings/);
  }
  const search = readFileSync(resolve("src/screens/SearchScreen.tsx"), "utf8");
  assert.match(search, /onPress=\{\(\) => void request\(recording\.id, recording\.token\)\}/);
  assert.equal((search.match(/api\.requestRecording/g) ?? []).length, 1);
});
