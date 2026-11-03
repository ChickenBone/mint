import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./audio.js", import.meta.url), "utf8");
function fixture(saved) {
  const values = new Map(saved ? [["audio:v1", JSON.stringify(saved)]] : []), nodes = [], errors = [];
  const param = () => ({ value: 0, events: [], setTargetAtTime(value) { this.value = value; }, cancelScheduledValues() { this.events = []; },
    setValueAtTime(value) { this.value = value; }, setValueCurveAtTime(curve, start, duration) { this.events.push({ curve, start, duration }); } });
  const node = () => { const result = { connect() {}, gain: param(), frequency: param(), Q: param(), threshold: param(), ratio: param(), knee: param(), attack: param(), release: param() }; nodes.push(result); return result; };
  class AudioContext {
    state = "running"; currentTime = 0; sampleRate = 48000; destination = {};
    createGain = node; createBiquadFilter = node; createDynamicsCompressor = node; createMediaElementSource = node;
  }
  const window = { AudioContext, localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) } };
  vm.runInNewContext(source, { window, Float32Array });
  const elements = [{}, {}], dsp = new window.MintBrowserDSP(elements, (error) => errors.push(error));
  return { dsp, elements, errors, values, nodes };
}
const settings = { enabled: true, preamp: -6, bands: [0, 0, 0, 0, 0, 6, 0, 0, 0, 0], compressor: true, crossfade: 4 };

test("DSP builds ten real filters, reserves gain headroom, compresses, persists and bypasses", async () => {
  const { dsp, values } = fixture();
  await dsp.configure(settings);
  assert.equal(dsp.filters.length, 10);
  assert.equal(dsp.filters[5].frequency.value, 1000);
  assert.equal(dsp.filters[5].gain.value, 6);
  assert.ok(Math.abs(dsp.preamp.gain.value - 10 ** (-15.1 / 20)) < 1e-8);
  assert.equal(dsp.compressor.ratio.value, 4);
  assert.equal(JSON.parse(values.get("audio:v1")).crossfade, 4);
  await dsp.configure({ ...settings, enabled: false, compressor: false, crossfade: 0 });
  assert.equal(dsp.filters[5].gain.value, 0);
  assert.equal(dsp.preamp.gain.value, 1);
  assert.equal(dsp.compressor.ratio.value, 1);
});

test("equal-power fades overlap both decks and selecting cancels both scheduled curves", async () => {
  const { dsp, elements } = fixture();
  await dsp.configure(settings);
  dsp.fade(elements[0], elements[1], 4);
  const out = dsp.decks.get(elements[0]).gain.events[0], incoming = dsp.decks.get(elements[1]).gain.events[0];
  assert.equal(out.duration, 4);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(out.curve[i] ** 2 + incoming.curve[i] ** 2 - 1) < 1e-6);
  dsp.select(elements[1]);
  assert.equal(dsp.decks.get(elements[0]).gain.value, 0);
  assert.equal(dsp.decks.get(elements[1]).gain.value, 1);
  assert.equal(dsp.decks.get(elements[0]).gain.events.length, 0);
});

test("DSP rejects invalid or unsupported processing rather than pretending it is enabled", async () => {
  const { dsp, errors } = fixture({ ...settings, bands: [99] });
  assert.match(errors[0], /Saved audio settings/);
  for (const invalid of [{ ...settings, bands: [0] }, { ...settings, preamp: 1 }, { ...settings, crossfade: Infinity }, { ...settings, bands: Array(10).fill(NaN) }]) {
    await assert.rejects(dsp.configure(invalid), /Invalid audio settings/);
  }
});
