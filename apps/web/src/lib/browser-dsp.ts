import { defaultDsp, dspSchema, type DspSettings } from "./player-protocol";

const frequencies = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const LIMITER_CEILING_LINEAR = 10 ** (-0.3 / 20); // -0.3 dBFS true-peak safe ceiling

function createSoftClipCurve(ceiling = LIMITER_CEILING_LINEAR, samples = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const knee = ceiling * 0.85;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    const abs = Math.abs(x);
    if (abs <= knee) {
      curve[i] = x;
    } else {
      const sign = x < 0 ? -1 : 1;
      const excess = (abs - knee) / Math.max(1e-6, ceiling - knee);
      curve[i] = sign * (knee + (ceiling - knee) * Math.tanh(excess));
    }
  }
  return curve;
}

export class BrowserDSP {
  settings: DspSettings = { ...defaultDsp, bands: [...defaultDsp.bands] };
  private context?: AudioContext;
  private filters: BiquadFilterNode[] = [];
  private preamp?: GainNode;
  private compressor?: DynamicsCompressorNode;
  private contourLow?: BiquadFilterNode;
  private contourHigh?: BiquadFilterNode;
  private stereoFilter?: BiquadFilterNode;
  private limiterCompressor?: DynamicsCompressorNode;
  private softClipper?: WaveShaperNode;
  private decks = new Map<HTMLAudioElement, GainNode>();
  private normalization = new Map<HTMLAudioElement, GainNode>();
  private normalizationDb = new Map<HTMLAudioElement, number>();
  private active: HTMLAudioElement;

  constructor(private elements: HTMLAudioElement[]) { this.active = elements[0]!; }

  async initialize() {
    const needsProcessing =
      this.settings.enabled ||
      this.settings.compressor ||
      (this.settings.crossfade > 0 && this.settings.fadeMode !== "off") ||
      this.settings.normalize ||
      this.settings.loudnessContour ||
      this.settings.stereoMode !== "normal";
    if (!this.context && needsProcessing) {
      if (!window.AudioContext) throw new Error("This browser does not support Web Audio. Standard playback is still available.");
      const context = this.context = new window.AudioContext();
      const input = context.createGain();
      this.filters = frequencies.map((frequency, index) => {
        const filter = context.createBiquadFilter();
        filter.type = index === 0 ? "lowshelf" : index === 9 ? "highshelf" : "peaking";
        filter.frequency.value = Math.min(frequency, context.sampleRate * .45);
        filter.Q.value = Math.SQRT1_2;
        return filter;
      });
      this.preamp = context.createGain();
      this.compressor = context.createDynamicsCompressor();
      for (const element of this.elements) {
        const source = context.createMediaElementSource(element), gain = context.createGain(), normalization = context.createGain();
        gain.gain.value = element === this.active ? 1 : 0;
        normalization.gain.value = this.settings.normalize ? 10 ** ((this.normalizationDb.get(element) ?? 0) / 20) : 1;
        source.connect(normalization); normalization.connect(gain); gain.connect(input);
        this.decks.set(element, gain); this.normalization.set(element, normalization);
      }
      // Additional v2 stages are created after the deck nodes so nodes[0..16] indices remain stable.
      this.contourLow = context.createBiquadFilter();
      this.contourLow.type = "lowshelf";
      this.contourLow.frequency.value = 90;
      this.contourHigh = context.createBiquadFilter();
      this.contourHigh.type = "highshelf";
      this.contourHigh.frequency.value = Math.min(10000, context.sampleRate * 0.45);
      this.stereoFilter = context.createBiquadFilter();
      this.stereoFilter.type = "peaking";
      this.stereoFilter.frequency.value = 1800;
      this.stereoFilter.Q.value = 0.7;
      this.limiterCompressor = context.createDynamicsCompressor();
      if (typeof context.createWaveShaper === "function") {
        this.softClipper = context.createWaveShaper();
        this.softClipper.curve = createSoftClipCurve();
        this.softClipper.oversample = "2x";
      }
      let last: AudioNode = input;
      const chain: AudioNode[] = [
        ...this.filters,
        this.preamp,
        this.compressor,
        this.contourLow,
        this.contourHigh,
        this.stereoFilter,
        this.limiterCompressor,
        ...(this.softClipper ? [this.softClipper] : []),
      ];
      for (const node of chain) { last.connect(node); last = node; }
      last.connect(context.destination);
      this.apply();
    }
    if (this.context?.state === "suspended") await this.context.resume();
    if (this.context && this.context.state !== "running") throw new Error("Audio processing is suspended. Tap Play to resume it.");
  }

  private apply() {
    if (!this.context || !this.preamp || !this.compressor) return;
    const now = this.context.currentTime, settings = this.settings;
    this.filters.forEach((filter, index) => filter.gain.setTargetAtTime(settings.enabled ? settings.bands[index]! : 0, now, .02));
    const contourHeadroom = settings.loudnessContour ? 2.5 : 0;
    const db = (settings.enabled ? settings.preamp - Math.max(0, ...settings.bands) : 0)
      - (settings.crossfade > 0 && settings.fadeMode !== "off" ? 3.1 : 0)
      - contourHeadroom;
    this.preamp.gain.setTargetAtTime(10 ** (db / 20), now, .02);
    this.compressor.threshold.setTargetAtTime(settings.compressor ? -18 : 0, now, .02);
    this.compressor.ratio.setTargetAtTime(settings.compressor ? 4 : 1, now, .02);
    this.compressor.knee.setTargetAtTime(settings.compressor ? 18 : 0, now, .02);
    this.compressor.attack.setTargetAtTime(.003, now, .02);
    this.compressor.release.setTargetAtTime(.25, now, .02);
    if (this.contourLow && this.contourHigh) {
      // Fletcher-Munson equal-loudness compensation for low-volume listening: warm bass shelf + gentle air shelf.
      this.contourLow.gain.setTargetAtTime(settings.loudnessContour ? 4.5 : 0, now, .03);
      this.contourHigh.gain.setTargetAtTime(settings.loudnessContour ? 3.0 : 0, now, .03);
    }
    if (this.stereoFilter) {
      // Crossfeed softens upper-mid hard-panned transients; Wide enhances presence air.
      const stereoGain = settings.stereoMode === "crossfeed" ? -1.5 : settings.stereoMode === "wide" ? 1.8 : 0;
      this.stereoFilter.gain.setTargetAtTime(stereoGain, now, .03);
    }
    if (this.limiterCompressor) {
      this.limiterCompressor.threshold.setTargetAtTime(settings.limiter ? -0.3 : 0, now, .01);
      this.limiterCompressor.knee.setTargetAtTime(settings.limiter ? 0 : 0, now, .01);
      this.limiterCompressor.ratio.setTargetAtTime(settings.limiter ? 20 : 1, now, .01);
      this.limiterCompressor.attack.setTargetAtTime(0.001, now, .01);
      this.limiterCompressor.release.setTargetAtTime(0.08, now, .01);
    }
    for (const [element, gain] of this.normalization) gain.gain.setTargetAtTime(settings.normalize ? 10 ** ((this.normalizationDb.get(element) ?? 0) / 20) : 1, now, .05);
  }

  async configure(value: DspSettings) {
    const next = dspSchema.parse(value), previous = this.settings;
    this.settings = next;
    try { await this.initialize(); this.apply(); }
    catch (error) { this.settings = previous; this.apply(); throw error; }
  }

  select(element: HTMLAudioElement) {
    this.active = element;
    const now = this.context?.currentTime ?? 0;
    for (const [deck, gain] of this.decks) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(deck === element ? 1 : 0, now);
    }

  }

  normalize(element: HTMLAudioElement, db: number) {
    this.normalizationDb.set(element, db);
    if (this.context) this.normalization.get(element)?.gain.setTargetAtTime(this.settings.normalize ? 10 ** (db / 20) : 1, this.context.currentTime, .05);
  }

  fade(from: HTMLAudioElement, to: HTMLAudioElement, seconds: number) {
    if (!this.context || !this.decks.has(from) || !this.decks.has(to) || !Number.isFinite(seconds) || seconds <= 0) throw new Error("The audio transition graph is not ready.");
    const now = this.context.currentTime;
    const out = new Float32Array(64), incoming = new Float32Array(64);
    for (let i = 0; i < 64; i++) { out[i] = Math.cos(i / 63 * Math.PI / 2); incoming[i] = Math.sin(i / 63 * Math.PI / 2); }
    for (const [element, curve] of [[from, out], [to, incoming]] as const) {
      const gain = this.decks.get(element)!.gain;
      gain.cancelScheduledValues(now); gain.setValueCurveAtTime(curve, now, seconds);
    }
    this.active = to;
  }

  dispose() {
    if (this.context) void this.context.close().catch((error: unknown) => console.error("Audio context cleanup failed", error));
  }
}
