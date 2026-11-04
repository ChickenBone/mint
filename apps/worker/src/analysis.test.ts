import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { analysisControlsSchema, analysisDistance, analysisSchema, DEFAULT_ANALYSIS_CONTROLS, withinAnalysisWindow } from "@mint/core/analysis";
import { AudioDescriptors, estimateKey, estimateTempo } from "./analysis-dsp";
import { analyzeAudio, audioProcess, parseLoudness } from "./analysis-engine";

/** Original synthesized PCM fixtures; no downloaded music or vendor analysis data. */
function wav(duration: number, sample: (time: number, channel: number) => number, channels = 1) {
  const rate = 48000, count = Math.round(duration * rate), bytes = Buffer.alloc(44 + count * channels * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2 * channels, 28); bytes.writeUInt16LE(2 * channels, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(count * channels * 2, 40);
  for (let i = 0; i < count; i++) for (let ch = 0; ch < channels; ch++) bytes.writeInt16LE(Math.round(Math.min(1, Math.max(-1, sample(i / rate, ch))) * 32767), 44 + (i * channels + ch) * 2);
  return bytes;
}

test("analysis contracts, schedule windows and ffmpeg summary distinguish absent measurements", () => {
  assert.equal(analysisControlsSchema.safeParse(DEFAULT_ANALYSIS_CONTROLS).success, true);
  assert.equal(analysisControlsSchema.safeParse({ ...DEFAULT_ANALYSIS_CONTROLS, concurrency: 100 }).success, false);
  assert.equal(withinAnalysisWindow(2, 22, 6), true);
  assert.equal(withinAnalysisWindow(12, 22, 6), false);
  assert.equal(withinAnalysisWindow(23, 0, 24), true);
  assert.deepEqual(parseLoudness("Summary:\n Integrated loudness:\n I: -15.1 LUFS\n True peak:\n Peak: -0.5 dBFS"), { integratedLufs: -15.1, truePeakDbtp: -0.5 });
  assert.deepEqual(parseLoudness("Summary:\n I: -70.0 LUFS\n True peak:\n Peak: -inf dBFS"), { integratedLufs: null, truePeakDbtp: null });
  assert.deepEqual(estimateTempo(new Array(100).fill(0)), { bpm: null, confidence: 0 });
  assert.deepEqual(estimateKey([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), { name: null, confidence: 0 });
  const pulse = Array.from({ length: 600 }, (_, i) => i % 10 === 0 ? 1 : 0);
  const tempo = estimateTempo(pulse);
  assert.equal(tempo.bpm, 120);
  assert.ok(tempo.confidence > 0.6 && tempo.confidence < 1);
});

test("streamed DSP preserves split floats, silence and bounded buffers", () => {
  const d = new AudioDescriptors(1, 2), bytes = Buffer.alloc(8000 * 4);
  for (let i = 1600; i < 6400; i++) bytes.writeFloatLE(0.5 * Math.sin(2 * Math.PI * 1000 * i / 8000), i * 4);
  for (let i = 0; i < bytes.length; i += 701) d.push(bytes.subarray(i, i + 701));
  const result = d.finish();
  assert.equal(result.durationSec, 1);
  assert.ok(Math.abs(result.leadingSilenceSec - 0.2) < 0.001);
  assert.ok(Math.abs(result.trailingSilenceSec - 0.2) < 0.001);
  assert.equal(result.waveform.length, 256);
  assert.equal(result.similarity.vector.length, 25);
  assert.ok(result.energy.rms > 0.27 && result.energy.rms < 0.28);
  assert.equal(result.key.name, null);
  const capped = new AudioDescriptors(1, 0.1);
  assert.throws(() => capped.push(bytes), /duration limit/);
  const invalid = new AudioDescriptors(1, 1), nan = Buffer.alloc(4);
  nan.writeFloatLE(NaN);
  assert.throws(() => invalid.push(nan), /non-finite/);
});

test("ffmpeg measures original fixtures, fingerprints bytes and never changes originals", async () => {
  const dir = path.resolve(`.analysis-test-${randomUUID()}`);
  await mkdir(dir);
  try {
    const file = path.join(dir, "tone.wav"), original = wav(6, (t) => t < 0.5 || t >= 5.25 ? 0 : 0.5 * Math.sin(2 * Math.PI * 1000 * t));
    await writeFile(file, original);
    const analysis = await analyzeAudio(file, { maxDurationSec: 10, timeoutSec: 30 });
    assert.equal(analysisSchema.safeParse(analysis).success, true);
    assert.equal(analysis.fingerprint.sha256, createHash("sha256").update(original).digest("hex"));
    assert.equal(analysis.fingerprint.bytes, original.length);
    assert.deepEqual(await readFile(file), original);
    assert.ok(Math.abs(analysis.durationSec - 6) < 0.01);
    assert.ok(Math.abs(analysis.leadingSilenceSec - 0.5) < 0.01);
    assert.ok(Math.abs(analysis.trailingSilenceSec - 0.75) < 0.01);
    assert.ok(analysis.integratedLufs !== null && analysis.integratedLufs > -12 && analysis.integratedLufs < -8, `LUFS ${analysis.integratedLufs}`);
    assert.ok(analysis.truePeakDbtp !== null && Math.abs(analysis.truePeakDbtp + 6) < 0.3, `true peak ${analysis.truePeakDbtp}`);
    assert.equal(analysisDistance(analysis, analysis), 0);
    const second = path.join(dir, "low.wav");
    await writeFile(second, wav(3, (t) => 0.25 * Math.sin(2 * Math.PI * 110 * t)));
    const low = await analyzeAudio(second, { maxDurationSec: 10, timeoutSec: 30 });
    assert.ok(analysisDistance(analysis, low)! > 0.1);
    const silent = path.join(dir, "silence.wav");
    await writeFile(silent, wav(2, () => 0));
    const silence = await analyzeAudio(silent, { maxDurationSec: 10, timeoutSec: 30 });
    assert.equal(silence.integratedLufs, null);
    assert.equal(silence.truePeakDbtp, null);
    assert.equal(silence.leadingSilenceSec, 2);
    assert.equal(silence.trailingSilenceSec, 2);
    assert.equal(silence.similarity.confidence, 0);
    assert.equal(silence.tempo.bpm, null);
    assert.equal(silence.key.name, null);
    const stereo = path.join(dir, "phase-inverted-stereo.wav");
    await writeFile(stereo, wav(3, (t, ch) => (ch ? -1 : 1) * 0.4 * Math.sin(2 * Math.PI * 1000 * t), 2));
    const antiphase = await analyzeAudio(stereo, { maxDurationSec: 10, timeoutSec: 30 });
    assert.ok(antiphase.leadingSilenceSec < 0.01 && antiphase.trailingSilenceSec < 0.01, "Out-of-phase stereo must not be trimmed as silence");
    assert.ok(antiphase.energy.rms > 0.28);
    assert.ok(Math.max(...antiphase.waveform) > 0.39);
    const beats = path.join(dir, "original-120bpm.wav");
    await writeFile(beats, wav(10, (t) => t % 0.5 < 0.08 ? 0.5 * Math.sin(2 * Math.PI * 1000 * t) : 0));
    const rhythm = await analyzeAudio(beats, { maxDurationSec: 12, timeoutSec: 30 });
    assert.equal(rhythm.tempo.bpm, 120);
    assert.ok(rhythm.tempo.confidence > 0.5 && rhythm.tempo.confidence < 1);
    await assert.rejects(analyzeAudio(file, { maxDurationSec: 1, timeoutSec: 30 }), /duration limit/);
    await assert.rejects(analyzeAudio(file, { maxDurationSec: 10, timeoutSec: 30, maxBytes: 1 }), /file exceeds/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(analyzeAudio(file, { maxDurationSec: 10, timeoutSec: 30, signal: controller.signal }), /cancelled|aborted/i);
    await symlink(file, path.join(dir, "link.wav"));
    await assert.rejects(analyzeAudio(path.join(dir, "link.wav"), { maxDurationSec: 10, timeoutSec: 30 }), /ELOOP/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("subprocesses enforce bounded execution and output", async () => {
  await assert.rejects(audioProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { path: "" }, { maxDurationSec: 10, timeoutSec: 0.1 }), /time limit/);
  await assert.rejects(audioProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000001))"], { path: "" }, { maxDurationSec: 10, timeoutSec: 5 }), /output exceeded/);
});
