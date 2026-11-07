import assert from "node:assert/strict";
import test from "node:test";
import { greeting, loadHome } from "../src/features/home/home-model";
import { catalogPage } from "./helpers/music-fixtures";

test("Home loads the original bounded recommendations and album shelf with cancellation", async () => {
  const signal = new AbortController().signal;
  const modes: string[] = [];
  const result = await loadHome({
    discover: async (mode, passed) => { assert.equal(passed, signal); modes.push(mode!); return { items: [], explanation: mode! }; },
    catalog: async (query, passed) => {
      assert.equal(passed, signal); assert.deepEqual(query, { type: "album", size: 18, sort: "newest" }); return catalogPage;
    },
  }, signal);
  assert.deepEqual(modes, ["for-you", "recent", "rediscover"]);
  assert.equal(result.albums, catalogPage);
  assert.equal(result.rediscover.explanation, "rediscover");
  assert.equal(greeting(9), "Good morning");
  assert.equal(greeting(13), "Good afternoon");
  assert.equal(greeting(22), "Good evening");
  await assert.rejects(loadHome(null, signal), /Sign in/);
});
