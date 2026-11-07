import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  playerSheetArtworkOrigin,
  playerSheetDestination,
  playerSheetProgress,
  playerSheetReleaseVelocity,
  resistPlayerSheetProgress,
  stepPlayerSheetSpring,
} from "../src/components/app/player-sheet-gesture";

test("artwork starts at the mini-player position and reaches its expanded position", () => {
  const origin = playerSheetArtworkOrigin(
    { x: 24, y: 680, width: 48, height: 48 },
    { x: 180, y: 140, width: 360, height: 360 },
    620,
  );
  assert.deepEqual(origin, { x: -156, y: -80, scale: 48 / 360 });
  for (const progress of [0, 0.1, 0.5, 0.9, 1]) {
    const localTop = 140 + origin.y * (1 - progress);
    const screenTop = localTop + 620 * (1 - progress);
    const screenLeft = 180 + origin.x * (1 - progress);
    const size = 360 * (origin.scale + (1 - origin.scale) * progress);
    assert.ok(localTop >= 0, "moving cover stays within the outer sheet");
    assert.ok(Math.abs(screenTop - (680 + (140 - 680) * progress)) < 0.001);
    assert.ok(Math.abs(screenLeft - (24 + (180 - 24) * progress)) < 0.001);
    assert.ok(Math.abs(size - (48 + (360 - 48) * progress)) < 0.001);
  }
});

test("moving artwork is outside clipped content and only one cover is visible", () => {
  const sheet = readFileSync(new URL("../src/components/app/now-playing.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  assert.match(sheet, /className="player-transition-artwork player-drag-region" data-player-drag-region aria-hidden>[\s\S]*?<\/div>}\s*<div className="player-sheet-content"/);
  assert.match(styles, /\.player-transition-artwork\s*\{[^}]*position: absolute;[^}]*visibility: hidden;[^}]*transform:/);
  assert.doesNotMatch(styles, /\.player-transition-artwork\s*\{[^}]*pointer-events: none;/);
  assert.match(styles, /html\[data-player-sheet-moving\] \.player-transition-artwork \{ visibility: visible; \}/);
  assert.match(styles, /html\[data-player-sheet-moving\] \.player-expanded-artwork \.now-playing-art \{ visibility: hidden; \}/);
  assert.doesNotMatch(styles, /\.player-sheet-content \.player-expanded-artwork\s*\{[^}]*transform:/);
});

test("collapsed dock has no extra grab row and retains keyboard expansion", () => {
  const player = readFileSync(new URL("../src/components/app/player.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(player, /player-grab-handle|player-sheet-grip|row-start-2/);
  assert.match(player, /aria-label="Expand player"\s+onKeyDown=\{[\s\S]*?event\.key === "ArrowUp"/);
});

test("slow drags follow their full distance and can reverse direction", () => {
  assert.equal(playerSheetProgress(0, 900, 540, 720), 0.5);
  assert.equal(playerSheetProgress(0, 900, 450, 720), 0.625);
  assert.equal(playerSheetProgress(0.625, 450, 630, 720), 0.375);
  assert.equal(playerSheetDestination(0.375, 0), 0);
});

test("short deliberate flicks use recent velocity, but a pause removes fling velocity", () => {
  const flick = [
    { y: 800, time: 0 },
    { y: 760, time: 40 },
    { y: 730, time: 70 },
  ];
  const velocity = playerSheetReleaseVelocity(flick, 720, 75);
  assert.ok(velocity > 0.72);
  assert.equal(playerSheetDestination(0.12, velocity), 1);
  assert.equal(playerSheetReleaseVelocity(flick, 720, 240), 0);
  assert.equal(playerSheetDestination(0.12, 0), 0);
});

test("slow gestures settle by distance rather than their small release velocity", () => {
  const slow = [
    { y: 900, time: 0 },
    { y: 700, time: 900 },
    { y: 570, time: 1600 },
  ];
  const velocity = playerSheetReleaseVelocity(slow, 720, 1620);
  assert.ok(velocity < 0.72);
  assert.equal(playerSheetDestination(0.54, velocity), 1);
  assert.equal(playerSheetDestination(0.46, velocity), 0);
});

test("endpoint resistance stays bounded and spring steps settle without a jump", () => {
  assert.ok(resistPlayerSheetProgress(-1) > -0.21);
  assert.ok(resistPlayerSheetProgress(2) < 1.21);

  let state = { position: 0.43, velocity: 0 };
  for (let frame = 0; frame < 180; frame++) state = stepPlayerSheetSpring(state, 1, 16);
  assert.ok(Math.abs(state.position - 1) < 0.001);
  assert.ok(Math.abs(state.velocity) < 0.01);
});
