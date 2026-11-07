import assert from "node:assert/strict";
import test from "node:test";
import { createHoldGesture } from "../src/lib/music-gestures";
import { itemCollection } from "../src/lib/browser-catalog";
import { playerItemSchema } from "../src/lib/player-protocol";

test("shared playlist actions retain the source and only address local matched Spotify music", () => {
  const playlist = { id: "00000000-0000-4000-8000-000000000001", type: "playlist", title: "Test mix" };
  assert.deepEqual(itemCollection(playerItemSchema.parse(playlist)), { kind: "playlist", id: playlist.id });
  assert.deepEqual(itemCollection(playerItemSchema.parse({ ...playlist, playlistSource: "spotify" })), { kind: "spotify", id: playlist.id });
});

test("holding opens once after 550ms and suppresses only the release click", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gesture = createHoldGesture();
  let opens = 0;
  gesture.start({ x: 10, y: 10 }, () => opens++);
  context.mock.timers.tick(549); assert.equal(opens, 0);
  context.mock.timers.tick(1); assert.equal(opens, 1);
  context.mock.timers.tick(1000); assert.equal(opens, 1);
  assert.equal(gesture.held, true);
  gesture.cancel();
  assert.equal(gesture.consumeClick(), true);
  assert.equal(gesture.consumeClick(), false);
});

test("taps, scrolling, pointer cancellation and unmount cleanup never open the menu", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gesture = createHoldGesture();
  let opens = 0;
  gesture.start({ x: 0, y: 0 }, () => opens++);
  context.mock.timers.tick(100); gesture.cancel();
  context.mock.timers.tick(1000);
  assert.equal(gesture.consumeClick(), false);
  gesture.start({ x: 0, y: 0 }, () => opens++);
  gesture.move({ x: 8, y: 8 }); context.mock.timers.tick(1000);
  assert.equal(opens, 0);
  gesture.start({ x: 0, y: 0 }, () => opens++);
  gesture.cancel(); context.mock.timers.tick(1000);
  assert.equal(opens, 0);
});

test("minor finger movement is tolerated and a new gesture clears stale click suppression", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gesture = createHoldGesture();
  let opens = 0;
  gesture.start({ x: 0, y: 0 }, () => opens++);
  gesture.move({ x: 6, y: 8 }); context.mock.timers.tick(550);
  assert.equal(opens, 1);
  gesture.reset();
  assert.equal(gesture.consumeClick(), false);
});
