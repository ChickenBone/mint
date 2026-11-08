import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dragProgress, recentVelocity, settleExpanded } from "../src/features/player/gesture";
import { cachedPalette, neutralPalette, paletteFromColor, prominentPixelColor, readableColor } from "../src/features/player/palette";

test("drag follows slow motion and settles by recent reversed velocity", () => {
  assert.equal(dragProgress(0, -100, 400), 0.25);
  assert.equal(dragProgress(0.9, 100, 400), 0.65);
  const velocity = recentVelocity([{ y: -300, time: 0 }, { y: -250, time: 160 }, { y: -200, time: 200 }], 200);
  assert.equal(velocity, 1.25);
  assert.equal(settleExpanded(0.8, velocity), false);
  assert.equal(settleExpanded(0.2, -0.7), true);
  assert.equal(settleExpanded(0.7, 0), true);
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
  const source = readFileSync(resolve("src/features/player/SeekSlider.web.tsx"), "utf8");
  assert.match(source, /<input type="range" aria-label="Playback position"/);
  for (const attribute of ["aria-valuenow", "aria-valuemin", "aria-valuemax", "onKeyDown", "onKeyUp"]) assert.ok(source.includes(attribute));
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) assert.ok(source.includes(key));
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.match(source, /if \(interacting\.current\) complete/);
  const surface = readFileSync(resolve("src/features/player/PlayerSurface.tsx"), "utf8");
  assert.match(surface, /accessibilityLabel="Lyrics"/);
  assert.match(surface, /accessibilityLabel="Queue"/);
});

test("mini-player text and background expand while transport buttons stay independent", () => {
  const source = readFileSync(resolve("src/features/player/PlayerSurface.tsx"), "utf8");
  const mini = source.slice(source.indexOf("<Animated.View style={[s.mini,"), source.indexOf("<View ref={overlay}"));
  assert.match(mini, /<Pressable accessible=\{false\} onPress=\{player\.open\}/);
  assert.match(mini, /<View pointerEvents="box-none" style=\{s\.miniTrack\}/);
  assert.match(mini, /<View pointerEvents="box-none" style=\{s\.miniControls\}/);
  assert.match(mini, /onPress=\{player\.open\}[\s\S]*track\.title[\s\S]*track\.artist[\s\S]*<\/Pressable>/);
  assert.doesNotMatch(mini, /navigate\("artist"\)/);
  assert.match(mini, /onPress=\{\(\) => run\(player\.toggle\)\}/);
  assert.match(mini, /onPress=\{\(\) => run\(player\.next\)\}/);
  assert.match(source, /onPress=\{\(\) => navigate\("artist"\)\}/);
});
