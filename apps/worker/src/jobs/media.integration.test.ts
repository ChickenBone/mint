import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { isLosslessUpgrade } from "../library-policy";
import { probe, tagInto } from "../media";

test("real audio probing and tagging preserve lossless quality and untouched originals", {
  skip: process.env.MINT_AUDIO_TEST !== "true",
  timeout: 60_000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mint-audio-test-"));
  t.after(() => rm(root, { recursive: true }));
  const run = promisify(execFile);
  const files = [
    { name: "original.mp3", codec: "libmp3lame" },
    { name: "candidate.flac", codec: "flac" },
    { name: "candidate.wav", codec: "pcm_s24le" },
    { name: "inferior.m4a", codec: "aac" },
  ];
  for (const file of files) {
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-c:a", file.codec, path.join(root, file.name)]);
  }
  const original = path.join(root, "original.mp3");
  const hash = () => readFile(original).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
  const before = await hash();
  await chmod(original, 0o444);
  const info = await probe(original);
  assert.equal(info.codec, "mp3");
  assert.equal(info.durationSec, 10);
  assert.equal(isLosslessUpgrade(info.codec, (await probe(path.join(root, "inferior.m4a"))).codec), false);
  for (const candidate of ["candidate.flac", "candidate.wav"]) {
    const src = path.join(root, candidate);
    assert.equal(isLosslessUpgrade(info.codec, (await probe(src)).codec), true);
    const saved = await tagInto(src, path.join(root, "upgrades", candidate), {
      title: "Fixture Tone", artist: "Generated Fixture", albumArtist: "Generated Fixture",
      album: "Test Fixtures", youtubeVideoId: "fixture0001",
    }, null);
    assert.equal((await probe(saved)).codec, "flac");
    assert.equal((await probe(saved)).durationSec, 10);
  }
  assert.equal(await hash(), before);
});
