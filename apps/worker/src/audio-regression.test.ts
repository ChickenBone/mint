import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { replayCorpus, summarizeReplay, wrongLength, type RegressionCorpus } from "./audio-regression";

const corpus: RegressionCorpus = JSON.parse(await readFile(new URL("./fixtures/audio-regression.json", import.meta.url), "utf8"));

test("captured YouTube listings replay against the current audio-source policy", async () => {
  const results = await replayCorpus(corpus);
  console.table(summarizeReplay(results));
  const captured = results.filter((result) => result.outcome !== "not-captured");
  assert.ok(captured.length >= 20, "the corpus should cover at least ten recordings in both modes");
  // Never import an upload a member labelled wrong, or one whose length is clearly another edit.
  assert.deepEqual(captured.filter((result) => result.rejectedPick).map((result) => result.id), []);
  assert.deepEqual(captured.filter(wrongLength).map((result) => `${result.id} (${result.mode}, ${result.lengthErrorSec}s)`), []);
  // Every recording either imports automatically or offers a member pick; none dead-ends.
  assert.deepEqual(captured.filter((result) => result.outcome === "no-source").map((result) => `${result.id} (${result.mode})`), []);
  const known = captured.filter((result) => result.mode === "known-length");
  const matched = known.filter((result) => result.outcome === "matched").length;
  assert.ok(matched / known.length >= 0.9, `only ${matched}/${known.length} recordings with a known length imported automatically`);
});
