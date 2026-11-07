import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ModuleKind, transpileModule } from "typescript";
import type { PlaylistPort } from "../src/playback/engine";
import { editUpcoming, queueEntries, shuffleUpcoming } from "../src/playback/queue";
import { activeLyric, parseLyrics } from "../src/playback/lyrics";
import { dragProgress, recentVelocity, settleExpanded } from "../src/components/player/gesture";
import { cachedPalette, neutralPalette, paletteFromColor, prominentPixelColor, readableColor } from "../src/components/player/palette";

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

test("drag follows slow motion and settles by recent reversed velocity", () => {
  assert.equal(dragProgress(0, -100, 400), 0.25);
  assert.equal(dragProgress(0.9, 100, 400), 0.65);
  const velocity = recentVelocity([{ y: -300, time: 0 }, { y: -250, time: 160 }, { y: -200, time: 200 }], 200);
  assert.equal(velocity, 1.25);
  assert.equal(settleExpanded(0.8, velocity), false);
  assert.equal(settleExpanded(0.2, -0.7), true);
  assert.equal(settleExpanded(0.7, 0), true);
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

test("artwork colors come from actual dominant pixels and remain readable on bright covers", () => {
  const pixels = new Uint8ClampedArray([240, 20, 20, 255, 220, 10, 10, 255, 255, 255, 255, 255]);
  const color = prominentPixelColor(pixels);
  assert.match(color, /^#[a-f0-9]{6}$/);
  assert.notEqual(color, "#ffffff");
  const dark = readableColor("#ffffff");
  const channel = parseInt(dark.slice(1, 3), 16) / 255;
  const luminance = ((channel + 0.055) / 1.055) ** 2.4;
  assert.ok((1 + 0.05) / (luminance + 0.05) >= 7);
  assert.equal(readableColor("invalid"), neutralPalette.primary);
  assert.notEqual(paletteFromColor("#ff0000").primary, paletteFromColor("#0000ff").primary);
});

test("artwork extraction coalesces identical requests and bounds concurrent work", async () => {
  let finish: (() => void) | undefined, calls = 0;
  const first = cachedPalette("test-a", async () => {
    calls++;
    await new Promise<void>((resolve) => { finish = resolve; });
    return paletteFromColor("#ff0000");
  });
  const same = cachedPalette("test-a", async () => { throw new Error("must coalesce"); });
  const second = cachedPalette("test-b", async () => {
    await first;
    return paletteFromColor("#0000ff");
  });
  assert.deepEqual(await cachedPalette("test-c", async () => { throw new Error("must not exceed concurrency"); }), neutralPalette);
  finish!();
  assert.deepEqual(await first, await same);
  await second;
  assert.equal(calls, 1);
});

test("web seek uses a focusable semantic range input and commits keyboard changes without sheet drag", () => {
  const source = readFileSync(resolve("src/components/player/SeekSlider.web.tsx"), "utf8");
  assert.match(source, /<input type="range" aria-label="Playback position"/);
  for (const attribute of ["aria-valuenow", "aria-valuemin", "aria-valuemax", "onKeyDown", "onKeyUp"]) assert.ok(source.includes(attribute));
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) assert.ok(source.includes(key));
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.match(source, /if \(interacting\.current\) complete/);
  const surface = readFileSync(resolve("src/components/player/PlayerSurface.tsx"), "utf8");
  assert.match(surface, /accessibilityLabel="Lyrics"/);
  assert.match(surface, /accessibilityLabel="Queue"/);
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
