import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { byteRange, confinedMedia } from "./playback";

test("browser byte ranges include suffix and open-ended forms and reject invalid/multipart values", () => {
  assert.deepEqual(byteRange(undefined, 100), { start: 0, end: 99, partial: false });
  assert.deepEqual(byteRange("bytes=10-19", 100), { start: 10, end: 19, partial: true });
  assert.deepEqual(byteRange("bytes=90-", 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(byteRange("bytes=-10", 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(byteRange("bytes=0-999", 100), { start: 0, end: 99, partial: true });
  for (const header of ["bytes=100-", "bytes=-0", "bytes=-", "bytes=4-1", "bytes=0-1,4-5", "bytes=1e2-", "bytes=99999999999999999999-"]) {
    assert.equal(byteRange(header, 100), null, header);
  }
});

test("playback confines real media files, including symlinks, to configured library roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mint-playback-path-"));
  try {
    await mkdir(path.join(root, "music"));
    await mkdir(path.join(root, "originals"));
    await writeFile(path.join(root, "originals/song.flac"), "fixture");
    await writeFile(path.join(root, "private.txt"), "not media");
    await symlink(path.join(root, "private.txt"), path.join(root, "music/escape.flac"));
    assert.equal(await confinedMedia(path.join(root, "originals/song.flac"), [path.join(root, "missing"), path.join(root, "originals")]), path.join(root, "originals/song.flac"));
    await assert.rejects(confinedMedia(path.join(root, "private.txt"), [path.join(root, "music")]), /outside/);
    await assert.rejects(confinedMedia(path.join(root, "music/escape.flac"), [path.join(root, "music")]), /outside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
