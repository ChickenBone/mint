import type { TrackAnalysis } from "@mint/core/analysis";

const RATE = 8000, FFT = 1024, FRAME = 400;
const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const rounded = (n: number) => Math.round(n * 1e6) / 1e6;
const normalize = (values: number[]) => {
  const total = values.reduce((a, b) => a + b, 0);
  return values.map((n) => total ? n / total : 0);
};

function spectrum(input: Float64Array) {
  const real = new Float64Array(FFT), imag = new Float64Array(FFT);
  for (let i = 0; i < FFT; i++) {
    let j = 0, value = i;
    for (let bit = 0; bit < 10; bit++) { j = (j << 1) | (value & 1); value >>= 1; }
    real[j] = input[i]! * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT - 1)));
  }
  for (let size = 2; size <= FFT; size *= 2) {
    for (let start = 0; start < FFT; start += size) {
      for (let j = 0; j < size / 2; j++) {
        const angle = -2 * Math.PI * j / size, b = start + j + size / 2, a = start + j;
        const r = real[b]! * Math.cos(angle) - imag[b]! * Math.sin(angle);
        const im = real[b]! * Math.sin(angle) + imag[b]! * Math.cos(angle);
        real[b] = real[a]! - r; imag[b] = imag[a]! - im;
        real[a] = real[a]! + r; imag[a] = imag[a]! + im;
      }
    }
  }
  return real.slice(0, FFT / 2).map((value, i) => value * value + imag[i]! * imag[i]!);
}

export function estimateTempo(levels: number[]): TrackAnalysis["tempo"] {
  if (levels.length < 100) return { bpm: null, confidence: 0 };
  const onset = levels.map((value, i) => Math.max(0, value - (levels[i - 1] ?? value)));
  const power = onset.reduce((sum, value) => sum + value * value, 0);
  if (power < 1e-8) return { bpm: null, confidence: 0 };
  const scores: { lag: number; score: number }[] = [];
  for (let lag = 6; lag <= 30; lag++) {
    let dot = 0, a = 0, b = 0;
    for (let i = lag; i < onset.length; i++) {
      dot += onset[i]! * onset[i - lag]!;
      a += onset[i]! ** 2; b += onset[i - lag]! ** 2;
    }
    const correlation = dot / (Math.sqrt(a * b) || 1);
    // Prefer the first recurring pulse over its half-tempo multiples.
    scores.push({ lag, score: correlation * (1 - lag * 0.002) });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0]!;
  const confidence = clamp(best.score * 0.75); // Coarse energy autocorrelation cannot establish beat phase.
  return confidence >= 0.2 ? { bpm: rounded(1200 / best.lag), confidence: rounded(confidence) } : { bpm: null, confidence: rounded(confidence) };
}

export function estimateKey(chroma: number[]): TrackAnalysis["key"] {
  const normalized = normalize(chroma);
  if (normalized.filter((value) => value > 0.07).length < 4) return { name: null, confidence: 0 };
  const profiles = [
    { suffix: "major", values: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] },
    { suffix: "minor", values: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] },
  ];
  const pitches = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const candidates = profiles.flatMap((profile) => {
    const mean = profile.values.reduce((a, b) => a + b, 0) / 12;
    return pitches.map((pitch, root) => {
      let dot = 0, a = 0, b = 0;
      for (let i = 0; i < 12; i++) {
        const x = normalized[i]! - 1 / 12, y = profile.values[(i - root + 12) % 12]! - mean;
        dot += x * y; a += x * x; b += y * y;
      }
      return { name: `${pitch} ${profile.suffix}`, score: dot / (Math.sqrt(a * b) || 1) };
    });
  }).sort((a, b) => b.score - a.score);
  const confidence = clamp((candidates[0]!.score - candidates[1]!.score) * 2) * Math.max(0, candidates[0]!.score);
  return { name: confidence >= 0.08 ? candidates[0]!.name : null, confidence: rounded(Math.min(0.65, confidence)) };
}

/** Streaming analysis uses bounded envelopes rather than retaining decoded audio in memory. */
export class AudioDescriptors {
  private carry = Buffer.alloc(0);
  private count = 0;
  private sum = 0;
  private peak = 0;
  private first = -1;
  private last = -1;
  private crossings = 0;
  private previous = 0;
  private frameSum = 0;
  private levels: number[] = [];
  private waveform = new Array<number>(256).fill(0);
  private fftInput = new Float64Array(FFT);
  private chroma = new Array<number>(12).fill(0);
  private bands = new Array<number>(8).fill(0);
  constructor(private duration: number, private maxDuration: number) {}

  push(chunk: Buffer) {
    const buffer = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const end = buffer.length - buffer.length % 4;
    for (let i = 0; i < end; i += 4) {
      const sample = buffer.readFloatLE(i);
      if (!Number.isFinite(sample)) throw new Error("Audio decoder produced non-finite samples");
      if (this.count >= this.maxDuration * RATE) throw new Error(`Track exceeds analysis duration limit (${this.maxDuration}s)`);
      const amplitude = Math.abs(sample);
      if (amplitude >= 0.001) { if (this.first < 0) this.first = this.count; this.last = this.count; }
      this.peak = Math.max(this.peak, amplitude);
      this.sum += sample * sample;
      this.frameSum += sample * sample;
      if ((sample >= 0) !== (this.previous >= 0)) this.crossings++;
      this.previous = sample;
      const bin = Math.min(255, Math.floor(this.count / (this.duration * RATE) * 256));
      this.waveform[bin] = Math.max(this.waveform[bin]!, Math.min(1, amplitude));
      // Sampling spectral frames over the first three minutes bounds CPU independently of length.
      if (this.count < 180 * RATE) {
        this.fftInput[this.count % FFT] = sample;
        if (this.count % (FFT * 4) === FFT - 1) this.addSpectrum();
      }

      this.count++;
      if (this.count % FRAME === 0) {
        this.levels.push(Math.sqrt(this.frameSum / FRAME));
        this.frameSum = 0;
      }
    }
    this.carry = Buffer.from(buffer.subarray(end));
  }

  private addSpectrum() {
    const bins = spectrum(this.fftInput);
    for (let i = 4; i < bins.length; i++) {
      const frequency = i * RATE / FFT, power = bins[i]!;
      const band = Math.min(7, Math.floor(Math.log2(frequency / 31.25)));
      this.bands[Math.max(0, band)]! += power;
      if (frequency >= 65 && frequency <= 3000) {
        const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
        this.chroma[(midi + 120) % 12]! += power;
      }
    }
  }

  finish() {
    if (this.carry.length || !this.count) throw new Error("Audio decoder returned empty or incomplete audio");
    const durationSec = this.count / RATE, rms = Math.sqrt(this.sum / this.count);
    const dynamicRangeDb = rms > 0 ? Math.max(0, 20 * Math.log10(this.peak / rms)) : 0;
    const tempo = estimateTempo(this.levels), key = estimateKey(this.chroma);
    const vector = [
      ...normalize(this.chroma), ...normalize(this.bands), clamp(rms), this.crossings / this.count,
      clamp(dynamicRangeDb / 40), tempo.bpm ? tempo.bpm / 220 : 0, clamp(this.peak),
    ].map(rounded);
    return {
      durationSec: rounded(durationSec),
      leadingSilenceSec: rounded(this.first < 0 ? durationSec : this.first / RATE),
      trailingSilenceSec: rounded(this.last < 0 ? durationSec : (this.count - 1 - this.last) / RATE),
      energy: { rms: rounded(rms), peak: rounded(this.peak), dynamicRangeDb: rounded(dynamicRangeDb) },
      waveform: this.waveform.map(rounded), tempo, key,
      similarity: { method: "audio-descriptors-v1" as const, vector, confidence: rms > 0.0001 ? 0.55 : 0 },
    };
  }
}

/** Preserve every channel's envelope: phase-inverted stereo must never look like silence. */
export class MultichannelDescriptors {
  private carry = Buffer.alloc(0);
  private analyzers: AudioDescriptors[];
  constructor(private channels: number, duration: number, maxDuration: number) {
    if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw new Error("Audio channel count exceeds analysis resource limit (8)");
    this.analyzers = Array.from({ length: channels }, () => new AudioDescriptors(duration, maxDuration));
  }
  push(chunk: Buffer) {
    const buffer = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const frameBytes = 4 * this.channels, end = buffer.length - buffer.length % frameBytes;
    for (let channel = 0; channel < this.channels; channel++) {
      const mono = Buffer.allocUnsafe(end / this.channels);
      for (let offset = 0; offset < end; offset += frameBytes) {
        buffer.copy(mono, offset / this.channels, offset + channel * 4, offset + channel * 4 + 4);
      }
      this.analyzers[channel]!.push(mono);
    }
    this.carry = Buffer.from(buffer.subarray(end));
  }
  finish() {
    if (this.carry.length) throw new Error("Audio decoder returned incomplete channel frames");
    const channels = this.analyzers.map((analyzer) => analyzer.finish());
    const representative = [...channels].sort((a, b) => b.energy.rms - a.energy.rms)[0]!;
    const rms = Math.sqrt(channels.reduce((sum, item) => sum + item.energy.rms ** 2, 0) / channels.length);
    const peak = Math.max(...channels.map((item) => item.energy.peak));
    const dynamicRangeDb = rms ? Math.max(0, 20 * Math.log10(peak / rms)) : 0;
    const vector = [...representative.similarity.vector];
    vector[20] = rounded(clamp(rms)); vector[22] = rounded(clamp(dynamicRangeDb / 40)); vector[24] = rounded(clamp(peak));
    return {
      ...representative,
      leadingSilenceSec: Math.min(...channels.map((item) => item.leadingSilenceSec)),
      trailingSilenceSec: Math.min(...channels.map((item) => item.trailingSilenceSec)),
      energy: { rms: rounded(rms), peak, dynamicRangeDb: rounded(dynamicRangeDb) },
      waveform: representative.waveform.map((_, bin) => Math.max(...channels.map((item) => item.waveform[bin]!))),
      similarity: { ...representative.similarity, vector },
    };
  }
}
