import assert from "node:assert/strict";
import test from "node:test";
import { backlogState, backlogStateLabel, filterBacklog } from "../src/lib/backlog";

test("backlog states have clear labels for playable, processing and failed songs", () => {
  assert.equal(backlogState("ready"), "playable");
  assert.equal(backlogState("analyzing"), "playable");
  assert.equal(backlogState("downloading"), "on-the-way");
  assert.equal(backlogState("failed"), "attention");
  assert.equal(backlogStateLabel("playable"), "Playable");
  assert.equal(backlogStateLabel("on-the-way"), "On the way");
  assert.equal(backlogStateLabel("attention"), "Needs attention");
});

test("backlog filters retain only the selected real state", () => {
  const tracks = [{ id: "ready", stage: "ready" }, { id: "queued", stage: "queued" }, { id: "failed", stage: "failed" }] as const;
  assert.deepEqual(filterBacklog([...tracks], "all"), tracks);
  assert.deepEqual(filterBacklog([...tracks], "playable").map((track) => track.id), ["ready"]);
  assert.deepEqual(filterBacklog([...tracks], "on-the-way").map((track) => track.id), ["queued"]);
  assert.deepEqual(filterBacklog([...tracks], "attention").map((track) => track.id), ["failed"]);
});
