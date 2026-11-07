import assert from "node:assert/strict";
import test from "node:test";
import { artworkTransform, dragAxis, dragProgress, sheetDestination, swipeTrack } from "../src/features/player/gesture";
import { useSeekPreview } from "../src/features/player/useSeekPreview";
import { harness } from "./helpers/hook-harness";

test("one artwork canvas follows measured left-to-center endpoints and every midpoint without teleporting", () => {
  const mini = { x: 16, y: 640, size: 48 }, full = { x: 30, y: 110, size: 260 };
  const position = (p: number) => {
    const transform = artworkTransform(mini, full, p, 260);
    return { x: transform.translateX + (260 - 260 * transform.scale) / 2,
      y: transform.translateY + (260 - 260 * transform.scale) / 2, size: 260 * transform.scale };
  };
  assert.deepEqual(position(0), mini);
  assert.deepEqual(position(1), full);
  assert.deepEqual(position(0.5), { x: 23, y: 375, size: 154 });
  for (let p = 0; p < 1; p += 0.01) {
    assert.ok(Math.abs(position(p + 0.01).y - position(p).y) < 5.31);
  }
  assert.deepEqual(position(-1), mini);
  assert.deepEqual(position(2), full);
});

test("geometry uses actual narrow/landscape frames and accommodates scrolled full artwork", () => {
  for (const width of [320, 568, 1024]) {
    const size = Math.min(width - 40, 360);
    const mini = { x: 16, y: 290, size: 48 };
    const full = { x: (width - size) / 2, y: 80 - 35, size };
    const transform = artworkTransform(mini, full, 1, size);
    assert.equal(transform.translateX, full.x);
    assert.equal(transform.translateY, 45);
    assert.equal(transform.scale, 1);
  }
});

test("directional activation excludes taps and diagonal intent; horizontal swipes retain direction", () => {
  assert.equal(dragAxis(4, 3), "pending");
  assert.equal(dragAxis(20, 4), "horizontal");
  assert.equal(dragAxis(-3, -18), "vertical");
  assert.equal(dragAxis(16, 16), "pending");
  assert.equal(dragAxis(30, 30), "cancel");
  assert.equal(swipeTrack(-90, 0, 320), "next");
  assert.equal(swipeTrack(90, 0, 320), "previous");
  assert.equal(swipeTrack(12, 0, 320), null);
  assert.equal(swipeTrack(-12, -600, 320), "next");
  assert.equal(swipeTrack(-90, 700, 320), "previous");
});

test("interrupted/reversed sheets start from visible progress and cancellation restores original state", () => {
  const interrupted = 0.65;
  assert.equal(dragProgress(interrupted, 0, 800), interrupted);
  assert.equal(dragProgress(interrupted, 80, 800), 0.55);
  assert.equal(dragProgress(interrupted, -80, 800), 0.75);
  assert.equal(sheetDestination(0.85, 0.8, true, false), false);
  assert.equal(sheetDestination(0.15, -0.8, false, false), true);
  assert.equal(sheetDestination(0.15, -0.8, true, true), true);
  assert.equal(sheetDestination(0.85, 0.8, false, true), false);
  assert.equal(dragProgress(0, 200, 800), 0);
  assert.equal(dragProgress(1, -200, 800), 1);
});

test("seek preview resets on occurrence/account changes and an interrupted old slider never seeks a new track", async () => {
  const commits: number[] = [];
  const scopeA = {}, scopeB = {};
  const hook = await harness(({ scope, id }: { scope: unknown; id: string }) =>
    useSeekPreview(scope, id, (value) => { commits.push(value); }), { scope: scopeA, id: "first" });
  await hook.act(() => hook.current.change(45));
  assert.equal(hook.current.value, 45);
  const old = hook.current;
  await hook.render({ scope: scopeA, id: "second" });
  assert.equal(hook.current.value, null);
  await hook.act(() => { old.change(80); old.complete(80); });
  assert.equal(hook.current.value, null);
  assert.deepEqual(commits, []);
  await hook.act(() => { hook.current.change(12); });
  const previousAccount = hook.current;
  await hook.render({ scope: scopeB, id: "second" });
  assert.equal(hook.current.value, null);
  await hook.act(() => { previousAccount.complete(12); });
  assert.deepEqual(commits, []);
  await hook.act(() => { hook.current.change(20); hook.current.complete(20); });
  assert.equal(hook.current.value, null);
  assert.deepEqual(commits, [20]);
  const unmounted = hook.current;
  await hook.unmount();
  unmounted.complete(30);
  assert.deepEqual(commits, [20]);
});
