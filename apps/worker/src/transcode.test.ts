import assert from "node:assert/strict";
import test from "node:test";
import { transcodeKey } from "./transcode";
test("compatibility cache keys invalidate when the original file changes", () => {
  const file = { size: 1024, mtimeMs: 1, ino: 2 };
  assert.match(transcodeKey("track", file), /^[a-f0-9]{64}$/);
  for (const patch of [{ size: 1025 }, { mtimeMs: 2 }, { ino: 3 }]) assert.notEqual(transcodeKey("track", file), transcodeKey("track", { ...file, ...patch }));
  assert.notEqual(transcodeKey("track", file), transcodeKey("other", file));
});
