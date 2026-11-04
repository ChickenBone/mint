import assert from "node:assert/strict";
import test from "node:test";
import { analysisSchema, type TrackAnalysis } from "@mint/core/analysis";
import { normalizationGain, smartTransition } from "../src/lib/smart-fades";
import { defaultDsp, type PlayerItem, type PlayerState } from "../src/lib/player-protocol";
import { ListeningHistory } from "../src/lib/listening-history";

const analysis: TrackAnalysis = analysisSchema.parse({
  version: 1, algorithm: "mint-dsp-v1", fingerprint: { sha256: "a".repeat(64), bytes: 1000, mtimeMs: 1 },
  measuredAt: new Date().toISOString(), durationSec: 120, integratedLufs: -20, truePeakDbtp: -5,
  leadingSilenceSec: 1.5, trailingSilenceSec: 2, energy: { rms: .1, peak: .5, dynamicRangeDb: 10 },
  waveform: Array(120).fill(.2), tempo: { bpm: 120, confidence: .7 }, key: { name: "C major", confidence: .5 },
  similarity: { method: "audio-descriptors-v1", vector: Array(25).fill(.2), confidence: .7 },
  provenance: { engine: "ffmpeg+mint-dsp", sampleRate: 8000, notes: [] },
});
const from: PlayerItem = { id: "00000000-0000-4000-8000-000000000001", queueId: "1", title: "Original fixture", type: "track", album: "Album", albumId: "al_a" };
const to: PlayerItem = { ...from, id: "00000000-0000-4000-8000-000000000002", queueId: "2", albumId: "al_b" };
test("Smart Fades use measured silence/energy, with safe album and missing-analysis fallbacks", () => {
  const input = { from, to, outgoing: analysis, incoming: analysis, settings: { ...defaultDsp, fadeMode: "smart" as const, crossfade: 8 }, shuffled: false, outgoingDuration: 120 };
  const plan = smartTransition(input);
  assert.equal(plan.endAt, 118); assert.equal(plan.skipIntro, 1.5); assert.equal(plan.seconds, 8);
  const dense = smartTransition({ ...input, outgoing: { ...analysis, waveform: Array(120).fill(.9) } });
  assert.equal(dense.seconds, 3.2);
  assert.equal(smartTransition({ ...input, to: { ...to, albumId: from.albumId } }).seconds, 0);
  assert.equal(smartTransition({ ...input, incoming: null }).seconds, 3);
  assert.equal(smartTransition({ ...input, settings: { ...input.settings, fadeMode: "off" } }).seconds, 0);
});
test("normalization honors loudness target, true-peak ceiling and bounded gain", () => {
  assert.equal(normalizationGain(analysis, -16), 3.5);
  assert.equal(normalizationGain({ ...analysis, truePeakDbtp: -.2 }, -16), -1.3);
  assert.equal(normalizationGain({ ...analysis, integratedLufs: null }, -16), 0);
  assert.equal(normalizationGain(null, -16), 0);
  assert.equal(normalizationGain({ ...analysis, integratedLufs: -100, truePeakDbtp: -100 }, -16), 12);
});
test("history measures audible elapsed time, rejects seek jumps, and flushes once per episode", () => {
  const events: { listenedMs: number; trackId: string; eventId: string }[] = [];
  let now = 0;
  const recorder = new ListeningHistory((event) => events.push(event), () => now);
  const state: PlayerState = { playing: true, track: from, time: 0, duration: 120_000, volume: 100, shuffle: false, repeat: 0, queue: [from, to], queueTotal: 2, queueOffset: 0 };
  recorder.update(state);
  now += 2000; recorder.update({ ...state, time: 2000 });
  now += 2000; recorder.update({ ...state, time: 80_000 });
  now += 2000; recorder.update({ ...state, playing: false, time: 82_000 });
  now += 10_000; recorder.update({ ...state, playing: false, time: 82_000 });
  now += 100; recorder.update({ ...state, track: to });
  recorder.flush(); recorder.flush();
  assert.equal(events.length, 1); assert.equal(events[0]!.listenedMs, 4000); assert.equal(events[0]!.trackId, from.id);
});
