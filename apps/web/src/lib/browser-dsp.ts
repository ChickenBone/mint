import { defaultDsp, dspSchema, type DspSettings } from "./player-protocol";

const frequencies = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export class BrowserDSP {
  settings: DspSettings = { ...defaultDsp, bands: [...defaultDsp.bands] };
  private context?: AudioContext;
  private filters: BiquadFilterNode[] = [];
  private preamp?: GainNode;
  private compressor?: DynamicsCompressorNode;
  private decks = new Map<HTMLAudioElement, GainNode>();
  private active: HTMLAudioElement;

  constructor(private elements: HTMLAudioElement[]) { this.active = elements[0]!; }

  async initialize() {
    if (!this.context && (this.settings.enabled || this.settings.compressor || this.settings.crossfade > 0)) {
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
      let last: AudioNode = input;
      for (const node of [...this.filters, this.preamp, this.compressor]) { last.connect(node); last = node; }
      last.connect(context.destination);
      for (const element of this.elements) {
        const source = context.createMediaElementSource(element), gain = context.createGain();
        gain.gain.value = element === this.active ? 1 : 0;
        source.connect(gain); gain.connect(input); this.decks.set(element, gain);
      }
      this.apply();
    }
    if (this.context?.state === "suspended") await this.context.resume();
    if (this.context && this.context.state !== "running") throw new Error("Audio processing is suspended. Tap Play to resume it.");
  }

  private apply() {
    if (!this.context || !this.preamp || !this.compressor) return;
    const now = this.context.currentTime, settings = this.settings;
    this.filters.forEach((filter, index) => filter.gain.setTargetAtTime(settings.enabled ? settings.bands[index]! : 0, now, .02));
    const db = (settings.enabled ? settings.preamp - Math.max(0, ...settings.bands) : 0) - (settings.crossfade > 0 ? 3.1 : 0);
    this.preamp.gain.setTargetAtTime(10 ** (db / 20), now, .02);
    this.compressor.threshold.setTargetAtTime(settings.compressor ? -18 : 0, now, .02);
    this.compressor.ratio.setTargetAtTime(settings.compressor ? 4 : 1, now, .02);
    this.compressor.knee.setTargetAtTime(settings.compressor ? 18 : 0, now, .02);
    this.compressor.attack.setTargetAtTime(.003, now, .02);
    this.compressor.release.setTargetAtTime(.25, now, .02);
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
