/* Original browser DSP and transition graph. No native Plexamp DSP is emulated. */
(() => {
  const frequencies = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const defaults = () => ({ enabled: false, preamp: -6, bands: frequencies.map(() => 0), compressor: false, crossfade: 0 });
  function validate(value) {
    if (!value || typeof value.enabled !== "boolean" || typeof value.compressor !== "boolean" ||
        !Number.isFinite(value.preamp) || value.preamp < -18 || value.preamp > 0 ||
        !Number.isFinite(value.crossfade) || value.crossfade < 0 || value.crossfade > 12 ||
        !Array.isArray(value.bands) || value.bands.length !== 10 || value.bands.some((gain) => !Number.isFinite(gain) || Math.abs(gain) > 12)) {
      throw new Error("Invalid audio settings. EQ bands must be within ±12 dB and preamp within -18–0 dB.");
    }
    return { enabled: value.enabled, preamp: value.preamp, bands: value.bands.slice(), compressor: value.compressor, crossfade: value.crossfade };
  }
  class BrowserDSP {
    constructor(elements, report) {
      this.elements = elements;
      this.report = report;
      this.settings = defaults();
      this.active = elements[0];
      this.decks = new Map();
      const saved = window.localStorage.getItem("audio:v1");
      if (saved) {
        try { this.settings = validate(JSON.parse(saved)); }
        catch (error) { report(`Saved audio settings could not be loaded: ${error.message}`); }
      }
    }
    needed() { return this.settings.enabled || this.settings.compressor || this.settings.crossfade > 0; }
    async initialize() {
      if (!this.context && this.needed()) {
        if (!window.AudioContext) throw new Error("This browser does not support Web Audio. Use current Android Chrome for DSP.");
        const context = this.context = new window.AudioContext();
        this.input = context.createGain();
        this.filters = frequencies.map((frequency, index) => {
          const filter = context.createBiquadFilter();
          filter.type = index === 0 ? "lowshelf" : index === 9 ? "highshelf" : "peaking";
          filter.frequency.value = Math.min(frequency, context.sampleRate * .45);
          filter.Q.value = Math.SQRT1_2;
          return filter;
        });
        this.preamp = context.createGain();
        this.compressor = context.createDynamicsCompressor();
        let last = this.input;
        for (const node of [...this.filters, this.preamp, this.compressor]) { last.connect(node); last = node; }
        last.connect(context.destination);
        for (const element of this.elements) {
          const source = context.createMediaElementSource(element), gain = context.createGain();
          gain.gain.value = element === this.active ? 1 : 0;
          source.connect(gain); gain.connect(this.input); this.decks.set(element, gain);
        }
        this.apply();
      }
      if (this.context?.state === "suspended") await this.context.resume();
      if (this.context && this.context.state !== "running") throw new Error("Audio processing is suspended. Tap Play to resume it.");
    }
    apply() {
      if (!this.context) return;
      const now = this.context.currentTime, settings = this.settings;
      this.filters.forEach((filter, index) => filter.gain.setTargetAtTime(settings.enabled ? settings.bands[index] : 0, now, .02));
      // Positive EQ boosts reserve matching headroom; a compressor is not a clipping guarantee.
      const db = (settings.enabled ? settings.preamp - Math.max(0, ...settings.bands) : 0) - (settings.crossfade > 0 ? 3.1 : 0);
      this.preamp.gain.setTargetAtTime(10 ** (db / 20), now, .02);
      this.compressor.threshold.setTargetAtTime(settings.compressor ? -18 : 0, now, .02);
      this.compressor.ratio.setTargetAtTime(settings.compressor ? 4 : 1, now, .02);
      this.compressor.knee.setTargetAtTime(settings.compressor ? 18 : 0, now, .02);
      this.compressor.attack.setTargetAtTime(.003, now, .02);
      this.compressor.release.setTargetAtTime(.25, now, .02);
    }
    async configure(value) {
      const next = validate(value), previous = this.settings;
      this.settings = next;
      try { await this.initialize(); this.apply(); }
      catch (error) { this.settings = previous; this.apply(); throw error; }
      window.localStorage.setItem("audio:v1", JSON.stringify(this.settings));
    }
    select(element) {
      this.active = element;
      const now = this.context?.currentTime ?? 0;
      for (const [deck, gain] of this.decks) {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(deck === element ? 1 : 0, now);
      }
    }
    fade(from, to, seconds) {
      if (!this.context || !this.decks.has(from) || !this.decks.has(to)) throw new Error("The audio transition graph is not ready.");
      const now = this.context.currentTime;
      const out = new Float32Array(64), incoming = new Float32Array(64);
      for (let i = 0; i < 64; i++) { out[i] = Math.cos(i / 63 * Math.PI / 2); incoming[i] = Math.sin(i / 63 * Math.PI / 2); }
      for (const [element, curve] of [[from, out], [to, incoming]]) {
        const gain = this.decks.get(element).gain;
        gain.cancelScheduledValues(now); gain.setValueCurveAtTime(curve, now, seconds);
      }
      this.active = to;
    }
  }
  window.MintBrowserDSP = BrowserDSP;
})();
