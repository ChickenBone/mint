import assert from "node:assert/strict";
import test from "node:test";
import { createHoldGesture } from "../src/lib/music-gestures";

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
