import assert from "node:assert/strict";
import test from "node:test";
import { YoutubeTurns, youtubeGapMs } from "./youtube-pace";

function clock() {
  let now = 1_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleeps,
    sleep: async (ms: number) => { sleeps.push(Math.round(ms)); now += ms; },
    advance: (ms: number) => { now += ms; },
  };
}

test("YouTube turns run one at a time in arrival order", async () => {
  const time = clock();
  const turns = new YoutubeTurns(0, { now: time.now, sleep: time.sleep });
  const events: string[] = [];
  let active = 0;
  const job = (name: string) => turns.run(async () => {
    active++;
    assert.equal(active, 1, "only one YouTube import is active");
    events.push(`start ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`end ${name}`);
    active--;
  });
  await Promise.all([job("a"), job("b"), job("c")]);
  assert.deepEqual(events, ["start a", "end a", "start b", "end b", "start c", "end c"]);
});

test("a jittered pause follows each used turn but not unused ones", async () => {
  const time = clock();
  const turns = new YoutubeTurns(10_000, { now: time.now, sleep: time.sleep, random: () => 0.5 });
  (await turns.take()).release();
  assert.deepEqual(time.sleeps, [], "the first turn starts immediately");
  const second = await turns.take();
  assert.deepEqual(time.sleeps, [10_000]);
  second.release(false);
  time.advance(1);
  (await turns.take()).release();
  assert.deepEqual(time.sleeps, [10_000], "an unused turn does not restart the pause");
  time.advance(30_000);
  assert.equal(turns.busy, false);
  (await turns.take()).release();
  assert.equal(time.sleeps.length, 1, "no pause once the gap has already elapsed");
});

test("an abandoned wait neither blocks nor jumps the queue", async () => {
  const turns = new YoutubeTurns(0);
  const first = await turns.take();
  const abort = new AbortController();
  const abandoned = turns.take(abort.signal);
  let thirdStarted = false;
  const third = turns.take().then((turn) => { thirdStarted = true; return turn; });
  abort.abort(new Error("stop"));
  await assert.rejects(abandoned, /stop/);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(thirdStarted, false, "still waits for the active turn");
  first.release();
  (await third).release();
  assert.equal(thirdStarted, true);
});

test("gap configuration is bounded and falls back on invalid values", () => {
  assert.equal(youtubeGapMs(undefined, 15), 15_000);
  assert.equal(youtubeGapMs("0", 15), 0);
  assert.equal(youtubeGapMs("30", 15), 30_000);
  assert.equal(youtubeGapMs("-1", 15), 15_000);
  assert.equal(youtubeGapMs("nope", 15), 15_000);
  assert.equal(youtubeGapMs("9999", 15), 15_000);
});
