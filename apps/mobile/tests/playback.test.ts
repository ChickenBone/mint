import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ModuleKind, transpileModule } from "typescript";
import type { PlaylistPort } from "../src/playback/engine";
import { editUpcoming, queueEntries, shuffleUpcoming } from "../src/playback/queue";
import { activeLyric, parseLyrics } from "../src/playback/lyrics";

const entries = ["a", "b", "c", "d"].map((occurrenceId) => ({ id: "same-song", title: occurrenceId, occurrenceId }));

test("shuffle keeps current and duplicate song occurrences exactly once", () => {
  const shuffled = shuffleUpcoming(entries, 0, () => 0);
  assert.equal(shuffled[0], entries[0]);
  assert.equal(new Set(shuffled.map((entry) => entry.occurrenceId)).size, 4);
});

test("upcoming edits preserve current object and protect history", () => {
  assert.equal(editUpcoming(entries, 0, "d", "b")[0], entries[0]);
  assert.deepEqual(editUpcoming(entries, 0, "d", "b").map((entry) => entry.occurrenceId), ["a", "d", "b", "c"]);
  assert.throws(() => editUpcoming(entries, 1, "a"), /upcoming/);
  assert.throws(() => editUpcoming(entries, 1, "d", "a"), /upcoming/);
});

test("queue hydration rejects ambiguous duplicate occurrences", () => {
  assert.throws(() => queueEntries({ context: { id: "q", total: 1, revision: 1, position: 0, offset: 0, shuffle: false }, items: [{ id: "a", title: "A" }] }), /identify/);
});

test("lyrics only expose genuine monotonic word timing", () => {
  const lines = parseLyrics("[00:01.00]<00:01.00>Hello <00:01.50>world\n[00:03.00]Plain line");
  assert.equal(lines[0]?.words?.length, 2);
  assert.equal(lines[1]?.words, undefined);
  assert.equal(activeLyric(lines, 500), -1);
  assert.equal(activeLyric(lines, 1200), 0);
  assert.equal(parseLyrics("[00:01.00]<00:01.00>Hello world")[0]?.words, undefined);
  assert.equal(parseLyrics("[00:01.00]<00:02.00>Hello <00:01.50>world")[0]?.words, undefined);
});

test("web adapter preserves paused end seeks but advances an actually playing finished song", async () => {
  let listener: (status: { didJustFinish?: boolean; error?: string }) => void = () => {};
  const audio = {
    currentTime: 0, duration: 45, playing: false, isLoaded: true, isBuffering: false, loop: false,
    pause() { this.playing = false; }, play() { this.playing = true; },
    replace() { this.currentTime = 0; },
    async seekTo(time: number) { this.currentTime = time; if (time === this.duration) listener({ didJustFinish: true }); },
    addListener(_event: string, callback: typeof listener) { listener = callback; return { remove() {} }; },
    setActiveForLockScreen() {}, release() {},
  };
  const exports: { createPlaylist?: () => Promise<{ port: PlaylistPort }> } = {};
  const source = readFileSync(resolve("src/playback/playlist.web.ts"), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, {
    exports, AbortController, Blob, URL, Uint8Array,
    require(name: string) { assert.equal(name, "expo-audio"); return { createAudioPlayer: () => audio }; },
    fetch: async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/wav" } }),
  });
  assert.ok(exports.createPlaylist);
  const { port } = await exports.createPlaylist();
  port.add({ uri: "https://mint.example/one", headers: { Authorization: "fixture" } });
  port.add({ uri: "https://mint.example/two", headers: { Authorization: "fixture" } });
  port.skipTo(0);
  await new Promise((resolve) => setImmediate(resolve));
  port.pause();
  await port.seekTo(45);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.currentIndex, 0);
  assert.equal(port.currentTime, 45);
  assert.equal(port.playing, false);
  port.play();
  listener({ didJustFinish: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.currentIndex, 1);
  assert.equal(port.playing, true);
  port.destroy();
});
