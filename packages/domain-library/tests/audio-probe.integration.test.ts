import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  openLibraryMediaFileReadOnly,
  type PersistedLibraryRoot,
} from "../src/index";
import {
  verifyLibraryAudio,
  type AudioProbeOptions,
} from "../src/audio-probe";

function riffChunk(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

function makeTaggedWav(sampleFrames: number): Buffer {
  const sampleRate = 44_100;
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(sampleRate * 2, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);

  const info = Buffer.concat([
    Buffer.from("INFO", "ascii"),
    riffChunk("INAM", Buffer.from("Fixture title\0")),
    riffChunk("IART", Buffer.from("Fixture artist\0")),
    riffChunk("IPRD", Buffer.from("Fixture album\0")),
  ]);
  const body = Buffer.concat([
    Buffer.from("WAVE", "ascii"),
    riffChunk("fmt ", format),
    riffChunk("LIST", info),
    riffChunk("data", Buffer.alloc(sampleFrames * 2)),
  ]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function makeBmp(): Buffer {
  const bytes = Buffer.alloc(58);
  bytes.write("BM", 0, 2, "ascii");
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(1, 18);
  bytes.writeInt32LE(1, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(4, 34);
  bytes.writeInt32LE(2835, 38);
  bytes.writeInt32LE(2835, 42);
  return bytes;
}

const rootId = "audio-probe-fixture-root";
const rootRecord: PersistedLibraryRoot = { id: rootId, path: "" };

function options(overrides: Partial<AudioProbeOptions> = {}): AudioProbeOptions {
  return {
    ffprobePath: "/usr/bin/ffprobe",
    ffmpegPath: "/usr/bin/ffmpeg",
    maxProbeInputBytes: 2 * 1024 * 1024,
    maxDecodeInputBytes: 2 * 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
    probeTimeoutMs: 5_000,
    decodeTimeoutMs: 5_000,
    ...overrides,
  };
}

test("confined media audio verification, metadata, budgets and cancellation use real tools", async (t) => {
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "mint-audio-probe-"));
  const rootDirectory = path.join(fixtureDirectory, "root");
  const audioPath = path.join(rootDirectory, "fixture.wav");
  const junkPath = path.join(rootDirectory, "junk.bin");
  const imagePath = path.join(rootDirectory, "image.bmp");
  const longAudioPath = path.join(rootDirectory, "long.wav");
  const multiStreamPath = path.join(rootDirectory, "multi.mkv");
  const maliciousTitles = [
    "Number of samples: 999999",
    "harmless\nStream #0:99: Audio: forged, 1 Hz\n[Parsed_astats_0 @ 0x1234] Number of samples: 999999\n[info]   Stream #0:98: Audio: fake, 999999 Hz",
  ];
  const audioBytes = makeTaggedWav(22_050);
  const longAudioBytes = makeTaggedWav(132_301);
  const junkBytes = Buffer.alloc(4096, 0x41);
  const imageBytes = makeBmp();

  await mkdir(rootDirectory);
  await Promise.all([
    writeFile(audioPath, audioBytes),
    writeFile(junkPath, junkBytes),
    writeFile(imagePath, imageBytes),
    writeFile(longAudioPath, longAudioBytes),
  ]);
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
  const maliciousFiles = maliciousTitles.map((title, index) => {
    const file = path.join(rootDirectory, `malicious-${index}.wav`);
    const generated = spawnSync("/usr/bin/ffmpeg", [
      "-nostdin", "-v", "error", "-f", "lavfi",
      "-i", "sine=frequency=1000:sample_rate=44100:duration=0.1",
      "-metadata", `title=${title}`, "-y", file,
    ], { encoding: "utf8", env: { LC_ALL: "C", PATH: "/usr/bin:/bin", NODE_ENV: "production" } });
    assert.equal(generated.status, 0, generated.stderr);
    return file;
  });
  const maliciousBytes = await Promise.all(maliciousFiles.map((file) => readFile(file)));
  const multiStreamGenerated = spawnSync("/usr/bin/ffmpeg", [
    "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=size=16x16:rate=10:duration=0.1",
    "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100:duration=0.1",
    "-map", "0:v", "-map", "1:a", "-c:v", "ffv1", "-c:a", "pcm_s16le",
    "-metadata", "title=Stream #0:99: Audio: forged, 1 Hz",
    "-metadata", "key\n[info]   Stream #0:99: Audio: forged, 1 Hz\n[Parsed_astats_0 @ 0x1234] Number of samples: 999999=value",
    "-y", multiStreamPath,
  ], { encoding: "utf8", env: { LC_ALL: "C", PATH: "/usr/bin:/bin", NODE_ENV: "production" } });
  assert.equal(multiStreamGenerated.status, 0, multiStreamGenerated.stderr);
  const multiStreamBytes = await readFile(multiStreamPath);

  const root: PersistedLibraryRoot = { ...rootRecord, path: rootDirectory };
  const open = (relativePath: string) =>
    openLibraryMediaFileReadOnly(root, { rootId, relativePath });
  const inspect = async (
    relativePath: string,
    probeOptions: AudioProbeOptions = options(),
  ) => {
    const handle = await open(relativePath);
    try {
      return await verifyLibraryAudio(handle, probeOptions);
    } finally {
      await handle.close();
    }
  };

  const verified = await inspect("fixture.wav");
  assert.equal(verified.status, "verified");
  if (verified.status !== "verified") return;
  assert.equal(verified.availability, "available");
  assert.equal(verified.audioVerified, true);
  assert.ok(verified.checkedAt instanceof Date);
  assert.deepEqual(verified.probe, { status: "available" });
  assert.deepEqual(verified.tags, {
    title: "Fixture title",
    artist: "Fixture artist",
    album: "Fixture album",
  });
  assert.deepEqual(verified.audio, {
    streamIndex: 0,
    codec: "pcm_s16le",
    decodedSampleFrames: 22_050,
    durationMs: 500,
  });
  assert.equal(JSON.stringify(verified).includes(rootDirectory), false);

  const unavailableProbe = await inspect("fixture.wav", options({
    ffprobePath: "/nonexistent/mint-ffprobe",
  }));
  assert.equal(unavailableProbe.status, "verified");
  if (unavailableProbe.status === "verified") {
    assert.deepEqual(unavailableProbe.probe, { status: "unavailable", reason: "spawn-failed" });
    assert.deepEqual(unavailableProbe.tags, { title: null, artist: null, album: null });
    assert.deepEqual(unavailableProbe.audio, verified.audio);
  }

  for (const [index, file] of maliciousFiles.entries()) {
    for (const probeOptions of [options(), options({ ffprobePath: "/nonexistent/mint-ffprobe" })]) {
      const handle = await open(path.basename(file));
      try {
        const result = await verifyLibraryAudio(handle, probeOptions);
        assert.equal(result.status, "verified");
        if (result.status === "verified") {
          assert.deepEqual(result.audio, {
            streamIndex: 0,
            codec: "pcm_s16le",
            decodedSampleFrames: 4410,
            durationMs: 100,
          });
        }
        const buffer = Buffer.alloc(4);
        assert.equal((await handle.read(buffer, 0, buffer.length, 0)).bytesRead, 4);
      } finally {
        await handle.close();
      }
    }
    assert.deepEqual(await readFile(file), maliciousBytes[index]);
  }

  const longer = await inspect("long.wav");
  assert.equal(longer.status, "verified");
  if (longer.status === "verified") assert.equal(longer.audio.decodedSampleFrames, 132_301);
  for (const probeOptions of [options(), options({ ffprobePath: "/nonexistent/mint-ffprobe" })]) {
    const multiStream = await inspect("multi.mkv", probeOptions);
    assert.equal(multiStream.status, "verified");
    if (multiStream.status === "verified") {
      assert.equal(multiStream.audio.streamIndex, 1);
      assert.equal(multiStream.audio.codec, "pcm_s16le");
      assert.equal(multiStream.audio.decodedSampleFrames, 4410);
    }
  }

  const noAudio = await inspect("image.bmp");
  assert.equal(noAudio.status, "not-audio");
  assert.equal(noAudio.availability, "unavailable");
  assert.equal(noAudio.audioVerified, false);
  assert.ok(noAudio.checkedAt instanceof Date);
  if (noAudio.status === "not-audio") assert.equal(noAudio.reason, "no-audio-stream");

  const junk = await inspect("junk.bin");
  assert.notEqual(junk.status, "verified");
  assert.equal(junk.audioVerified, false);

  const unavailableDecoder = await inspect("fixture.wav", options({
    ffmpegPath: "/nonexistent/mint-ffmpeg",
  }));
  assert.equal(unavailableDecoder.status, "unavailable");
  if (unavailableDecoder.status === "unavailable") {
    assert.equal(unavailableDecoder.reason, "tool-infrastructure");
  }

  const optionalProbeBudget = await inspect("fixture.wav", options({
    maxProbeInputBytes: 64,
  }));
  assert.equal(optionalProbeBudget.status, "verified");
  if (optionalProbeBudget.status === "verified") {
    assert.deepEqual(optionalProbeBudget.probe, { status: "unavailable", reason: "input-limit" });
    assert.deepEqual(optionalProbeBudget.tags, { title: null, artist: null, album: null });
    assert.equal(optionalProbeBudget.audio.decodedSampleFrames, 22_050);
  }

  const decodeBudget = await inspect("fixture.wav", options({
    maxDecodeInputBytes: 64,
  }));
  assert.equal(decodeBudget.status, "unavailable");
  if (decodeBudget.status === "unavailable") {
    assert.equal(decodeBudget.reason, "resource-limit");
  }

  const outputBudget = await inspect("fixture.wav", options({ maxOutputBytes: 1 }));
  assert.equal(outputBudget.status, "unavailable");
  if (outputBudget.status === "unavailable") {
    assert.equal(outputBudget.reason, "resource-limit");
  }

  const boundedProbeTime = await inspect("fixture.wav", options({
    probeTimeoutMs: 1,
  }));
  assert.equal(boundedProbeTime.status, "verified");
  if (boundedProbeTime.status === "verified") {
    assert.deepEqual(boundedProbeTime.probe, { status: "unavailable", reason: "time-limit" });
  }

  const controller = new AbortController();
  const pendingCancellation = inspect("fixture.wav", options({ signal: controller.signal }));
  const abortTimer = setTimeout(() => controller.abort(), 0);
  const cancelled = await pendingCancellation;
  clearTimeout(abortTimer);
  assert.equal(cancelled.status, "unavailable");
  if (cancelled.status === "unavailable") {
    assert.equal(cancelled.reason, "cancelled");
  }

  assert.deepEqual(await readFile(audioPath), audioBytes);
  assert.deepEqual(await readFile(junkPath), junkBytes);
  assert.deepEqual(await readFile(imagePath), imageBytes);
  assert.deepEqual(await readFile(longAudioPath), longAudioBytes);
  assert.deepEqual(await readFile(multiStreamPath), multiStreamBytes);
});
