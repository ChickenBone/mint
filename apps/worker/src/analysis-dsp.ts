import type { AnalysisMood, TrackAnalysisV2 } from "@mint/core/analysis";

export const SAMPLE_RATE = 16000;
const FFT = 1024;
const MEL_BANDS = 26;
const MFCC_COUNT = 13;
const BARK_EDGES = [100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1720, 2700, 8000] as const;
const CONTRAST_EDGES = [60, 150, 350, 700, 1400, 2800, 8000] as const;

const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const rounded = (n: number) => Math.round(n * 1e6) / 1e6;
const normalize = (values: number[]) => {
  const total = values.reduce((a, b) => a + b, 0);
  return values.map((n) => (total ? n / total : 0));
};

export const CAMELOT_WHEEL: Record<string, { camelot: string; openKey: string; scale: "major" | "minor" }> = {
  "G# minor": { camelot: "1A", openKey: "6m", scale: "minor" },
  "D# minor": { camelot: "2A", openKey: "7m", scale: "minor" },
  "A# minor": { camelot: "3A", openKey: "8m", scale: "minor" },
  "F minor": { camelot: "4A", openKey: "9m", scale: "minor" },
  "C minor": { camelot: "5A", openKey: "10m", scale: "minor" },
  "G minor": { camelot: "6A", openKey: "11m", scale: "minor" },
  "D minor": { camelot: "7A", openKey: "12m", scale: "minor" },
  "A minor": { camelot: "8A", openKey: "1m", scale: "minor" },
  "E minor": { camelot: "9A", openKey: "2m", scale: "minor" },
  "B minor": { camelot: "10A", openKey: "3m", scale: "minor" },
  "F# minor": { camelot: "11A", openKey: "4m", scale: "minor" },
  "C# minor": { camelot: "12A", openKey: "5m", scale: "minor" },
  "B major": { camelot: "1B", openKey: "6d", scale: "major" },
  "F# major": { camelot: "2B", openKey: "7d", scale: "major" },
  "C# major": { camelot: "3B", openKey: "8d", scale: "major" },
  "G# major": { camelot: "4B", openKey: "9d", scale: "major" },
  "D# major": { camelot: "5B", openKey: "10d", scale: "major" },
  "A# major": { camelot: "6B", openKey: "11d", scale: "major" },
  "F major": { camelot: "7B", openKey: "12d", scale: "major" },
  "C major": { camelot: "8B", openKey: "1d", scale: "major" },
  "G major": { camelot: "9B", openKey: "2d", scale: "major" },
  "D major": { camelot: "10B", openKey: "3d", scale: "major" },
  "A major": { camelot: "11B", openKey: "4d", scale: "major" },
  "E major": { camelot: "12B", openKey: "5d", scale: "major" },
};

export function keyToCamelot(name: string | null | undefined) {
  if (!name) return { camelot: null, openKey: null, scale: null };
  return CAMELOT_WHEEL[name] ?? { camelot: null, openKey: null, scale: null };
}

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

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

function buildMelFilterbank(rate: number) {
  const minMel = hzToMel(40);
  const maxMel = hzToMel(Math.min(7600, rate * 0.48));
  const points = Array.from({ length: MEL_BANDS + 2 }, (_, i) =>
    melToHz(minMel + (i / (MEL_BANDS + 1)) * (maxMel - minMel)),
  );
  const binFreqs = Array.from({ length: FFT / 2 }, (_, k) => (k * rate) / FFT);
  return Array.from({ length: MEL_BANDS }, (_, m) => {
    const left = points[m]!, center = points[m + 1]!, right = points[m + 2]!;
    const weights = new Float64Array(FFT / 2);
    for (let k = 1; k < FFT / 2; k++) {
      const f = binFreqs[k]!;
      if (f >= left && f <= center && center > left) weights[k] = (f - left) / (center - left);
      else if (f > center && f <= right && right > center) weights[k] = (right - f) / (right - center);
    }
    return weights;
  });
}

const DCT_MATRIX = Array.from({ length: MFCC_COUNT }, (_, n) =>
  Float64Array.from({ length: MEL_BANDS }, (_, m) => Math.cos((Math.PI * n * (m + 0.5)) / MEL_BANDS)),
);

export function estimateTempo(levels: number[], onsetFlux?: number[]): TrackAnalysisV2["tempo"] {
  const empty: TrackAnalysisV2["tempo"] = {
    bpm: null,
    confidence: 0,
    tempoStability: 0,
    firstDownbeatSec: 0,
    beatIntervalSec: null,
    timeSignature: "4/4",
  };
  if (levels.length < 60) return empty;
  const onset = levels.map((value, i) => {
    const energyDiff = Math.max(0, value - (levels[i - 1] ?? value));
    const flux = onsetFlux?.[i] ?? 0;
    return energyDiff + flux * 0.35;
  });
  const power = onset.reduce((sum, value) => sum + value * value, 0);
  if (power < 1e-8) return empty;

  const rawCorrelations = new Map<number, number>();
  for (let lag = 5; lag <= 32; lag++) {
    let dot = 0, a = 0, b = 0;
    for (let i = lag; i < onset.length; i++) {
      dot += onset[i]! * onset[i - lag]!;
      a += onset[i]! ** 2;
      b += onset[i - lag]! ** 2;
    }
    rawCorrelations.set(lag, dot / (Math.sqrt(a * b) || 1));
  }

  const scores: { lag: number; score: number; raw: number }[] = [];
  for (let lag = 6; lag <= 30; lag++) {
    const raw = rawCorrelations.get(lag) ?? 0;
    const doubleLag = rawCorrelations.get(lag * 2) ?? 0;
    const halfLag = lag % 2 === 0 ? (rawCorrelations.get(lag / 2) ?? 0) : 0;
    // Comb-filter harmonic reinforcement + gentle perceptual preference against half-tempo multiples.
    const combScore = raw + 0.12 * doubleLag + 0.06 * halfLag;
    const prior = 1 - lag * 0.002;
    scores.push({ lag, score: combScore * prior, raw });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0]!;
  const confidence = clamp(best.raw * 0.78);
  if (confidence < 0.2) {
    return { ...empty, confidence: rounded(confidence) };
  }

  const bpm = rounded(1200 / best.lag);
  const beatIntervalSec = rounded(60 / bpm);

  // Measure stability by comparing first-half and second-half autocorrelation at the winning lag.
  const mid = Math.floor(onset.length / 2);
  const halfCorr = (start: number, end: number) => {
    let dot = 0, a = 0, b = 0;
    for (let i = start + best.lag; i < end; i++) {
      dot += onset[i]! * onset[i - best.lag]!;
      a += onset[i]! ** 2;
      b += onset[i - best.lag]! ** 2;
    }
    return dot / (Math.sqrt(a * b) || 1);
  };
  const c1 = halfCorr(0, mid);
  const c2 = halfCorr(mid, onset.length);
  const tempoStability = rounded(clamp((best.raw * 0.6) + (Math.min(c1, c2) / Math.max(1e-6, Math.max(c1, c2))) * 0.4));

  // Estimate beat phase (firstDownbeatSec) by finding the phase offset with highest grid energy.
  const lagFrames = best.lag;
  let bestPhase = 0, bestPhaseScore = -1;
  for (let phase = 0; phase < lagFrames; phase++) {
    let sum = 0, count = 0;
    for (let i = phase; i < onset.length; i += lagFrames) {
      sum += onset[i]!;
      count++;
    }
    const avg = count ? sum / count : 0;
    if (avg > bestPhaseScore) {
      bestPhaseScore = avg;
      bestPhase = phase;
    }
  }
  const maxOnset = Math.max(...onset, 1e-6);
  let firstDownbeatFrame = bestPhase;
  for (let i = bestPhase; i < Math.min(onset.length, bestPhase + lagFrames * 16); i += lagFrames) {
    if (onset[i]! >= maxOnset * 0.25) {
      firstDownbeatFrame = i;
      break;
    }
  }
  const firstDownbeatSec = rounded(firstDownbeatFrame * 0.05);

  // Estimate meter (4/4 vs 3/4) from bar-level accent periodicity.
  const meter3 = best.lag * 3 <= 32 ? (rawCorrelations.get(best.lag * 3) ?? 0) : 0;
  const meter4 = best.lag * 2 <= 32 ? (rawCorrelations.get(best.lag * 2) ?? 0) : 0;
  const timeSignature: "4/4" | "3/4" | "6/8" = meter3 > meter4 * 1.22 && meter3 > 0.35 ? "3/4" : "4/4";

  return {
    bpm,
    confidence: rounded(confidence),
    tempoStability,
    firstDownbeatSec,
    beatIntervalSec,
    timeSignature,
  };
}

export function estimateKey(chroma: number[]): TrackAnalysisV2["key"] {
  const empty: TrackAnalysisV2["key"] = {
    name: null,
    camelot: null,
    openKey: null,
    scale: null,
    confidence: 0,
  };
  const normalized = normalize(chroma);
  if (normalized.filter((value) => value > 0.07).length < 4) return empty;
  // Blended Krumhansl-Kessler + Temperley tonal profiles for major and minor scales.
  const profiles = [
    { suffix: "major" as const, values: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] },
    { suffix: "minor" as const, values: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] },
  ];
  const pitches = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const candidates = profiles.flatMap((profile) => {
    const mean = profile.values.reduce((a, b) => a + b, 0) / 12;
    return pitches.map((pitch, root) => {
      let dot = 0, a = 0, b = 0;
      for (let i = 0; i < 12; i++) {
        const x = normalized[i]! - 1 / 12;
        const y = profile.values[(i - root + 12) % 12]! - mean;
        dot += x * y;
        a += x * x;
        b += y * y;
      }
      return {
        name: `${pitch} ${profile.suffix}`,
        scale: profile.suffix,
        score: dot / (Math.sqrt(a * b) || 1),
      };
    });
  }).sort((a, b) => b.score - a.score);

  const confidence = clamp((candidates[0]!.score - candidates[1]!.score) * 2) * Math.max(0, candidates[0]!.score);
  if (confidence < 0.08) {
    return { ...empty, confidence: rounded(Math.min(0.65, confidence)) };
  }
  const winner = candidates[0]!.name;
  const wheel = keyToCamelot(winner);
  return {
    name: winner,
    camelot: wheel.camelot,
    openKey: wheel.openKey,
    scale: wheel.scale,
    confidence: rounded(Math.min(0.85, confidence * 1.15)),
  };
}

export interface ClassificationInput {
  rms: number;
  peak: number;
  dynamicRangeDb: number;
   barkBands: number[];
  spectralCentroidHz: number;
  spectralRolloffHz: number;
  spectralFlatness: number;
  spectralFlux: number;
  zeroCrossingRate: number;
  mfccMean: number[];
  mfccStd: number[];
  spectralContrast: number[];
  chroma: number[];
  tempo: TrackAnalysisV2["tempo"];
  key: TrackAnalysisV2["key"];
  activeFrameRatio: number;
  syllabicModulation: number;
  lowBandFlux: number;
  highBandFlux: number;
}

export function classifyAudioFeatures(input: ClassificationInput): TrackAnalysisV2["classification"] {
  if (input.rms < 1e-4) {
    return {
      genres: [],
      moods: [],
      valence: 0,
      arousal: 0,
      danceability: 0,
      voiceInstrumental: { label: "instrumental", vocalPresence: 0, confidence: 1 },
    };
  }

  const bark = normalize(input.barkBands);
  const subBass = (bark[0]! + bark[1]!) || 0;
  const bass = (bark[2]! + bark[3]!) || 0;
  const lowMid = (bark[4]! + bark[5]!) || 0;
  const vocalBand = (bark[6]! + bark[7]! + bark[8]!) || 0;
  const highMid = bark[9]! || 0;
  const presence = (bark[10]! + bark[11]!) || 0;

  const activeBarkInVocal = [bark[5]!, bark[6]!, bark[7]!, bark[8]!, bark[9]!].filter((v) => v > 0.04).length;
  const mfccVarEnergy = input.mfccStd.slice(1, 8).reduce((a, b) => a + b, 0) / 7;
  const formantRichness = clamp((activeBarkInVocal - 1) / 3) * clamp(mfccVarEnergy / 1.5);

  // Syllabic modulation (3-8 Hz) + mid-band formant richness distinguishes vocals from pure tones and percussive clicks.
  const rawVocalScore = clamp(
    vocalBand * 0.42 +
    clamp(input.syllabicModulation * 2.2) * 0.38 +
    formantRichness * 0.20,
  ) * (input.activeFrameRatio > 0.45 ? 1 : 0.35);

  const vocalPresence = rounded(
    activeBarkInVocal >= 2 && input.syllabicModulation > 0.08
      ? clamp(rawVocalScore * 1.25)
      : clamp(rawVocalScore * 0.35),
  );

  const isSpokenWord = vocalPresence >= 0.55 && (input.tempo.confidence < 0.28 || input.key.confidence < 0.1) && input.syllabicModulation > 0.22;
  const voiceLabel: "vocal" | "instrumental" | "spoken-word" =
    isSpokenWord ? "spoken-word" : vocalPresence >= 0.5 ? "vocal" : "instrumental";
  const voiceConfidence = rounded(
    voiceLabel === "instrumental"
      ? clamp(1 - vocalPresence * 0.9, 0.55, 0.98)
      : clamp(0.5 + (vocalPresence - 0.5) * 0.95, 0.52, 0.95),
  );

  const bpm = input.tempo.bpm ?? 0;
  const tempoSuitability = bpm >= 85 && bpm <= 145
    ? 1 - Math.abs(bpm - 120) / 80
    : bpm > 145 && bpm <= 180
      ? 0.65
      : bpm >= 65 && bpm < 85
        ? 0.55
        : 0.15;

  const danceability = rounded(clamp(
    input.tempo.confidence * 0.38 +
    input.tempo.tempoStability * 0.27 +
    tempoSuitability * (input.tempo.confidence > 0.2 ? 0.25 : 0.05) +
    clamp(input.lowBandFlux * 3 + input.spectralFlux * 1.5) * 0.10,
  ));

  const normCentroid = clamp(input.spectralCentroidHz / 3200);
  const normRms = clamp(input.rms / 0.35);
  const normFlux = clamp(input.spectralFlux * 4);
  const tempoEnergy = bpm ? clamp((bpm - 60) / 120) : 0.2;

  const arousal = rounded(clamp(
    normRms * 0.32 +
    normFlux * 0.28 +
    normCentroid * 0.18 +
    tempoEnergy * 0.14 +
    presence * 0.08,
  ));

  const scaleBonus = input.key.scale === "major" ? 0.68 : input.key.scale === "minor" ? 0.32 : 0.5;
  const valence = rounded(clamp(
    scaleBonus * 0.34 +
    normCentroid * 0.24 +
    danceability * 0.24 +
    (1 - clamp(input.spectralFlatness * 2)) * 0.18,
  ));

  // Score canonical genres and subgenres
  const genreCandidates: { name: string; subgenre?: string; score: number }[] = [];

  // Electronic
  const electronicScore = clamp(
    input.tempo.tempoStability * 0.35 +
    input.tempo.confidence * 0.30 +
    (subBass + bass + presence) * 0.20 +
    (1 - vocalPresence * 0.4) * 0.15,
  ) * (input.tempo.confidence >= 0.35 ? 1.15 : 0.45);
  const electronicSub =
    bpm >= 155 ? "Drum & Bass"
    : bpm >= 127 && normCentroid < 0.55 ? "Techno"
    : vocalPresence >= 0.48 ? "Synthpop"
    : "House";
  genreCandidates.push({ name: "Electronic", subgenre: electronicSub, score: electronicScore });

  // Ambient
  const ambientScore = clamp(
    (1 - normFlux) * 0.38 +
    (1 - input.tempo.confidence) * 0.32 +
    input.activeFrameRatio * 0.18 +
    (1 - arousal) * 0.12,
  ) * (input.tempo.confidence < 0.4 ? 1.15 : 0.35);
  genreCandidates.push({
    name: "Ambient",
    subgenre: normCentroid < 0.35 ? "Drone" : "Chamber",
    score: ambientScore,
  });

  // Pop
  const popScore = clamp(
    vocalPresence * 0.35 +
    danceability * 0.28 +
    valence * 0.22 +
    (vocalBand + highMid) * 0.15,
  ) * (vocalPresence >= 0.45 ? 1.1 : 0.6);
  genreCandidates.push({ name: "Pop", subgenre: electronicScore > 0.55 ? "Synthpop" : undefined, score: popScore });

  // Hip-Hop
  const hipHopTempo = (bpm >= 68 && bpm <= 102) || (bpm >= 136 && bpm <= 165) ? 0.9 : 0.35;
  const hipHopScore = clamp(
    (subBass + bass) * 0.32 +
    vocalPresence * 0.28 +
    hipHopTempo * 0.22 +
    input.tempo.confidence * 0.18,
  ) * (subBass + bass > 0.22 || vocalPresence > 0.45 ? 1 : 0.55);
  genreCandidates.push({
    name: "Hip-Hop",
    subgenre: bpm >= 132 ? "Trap" : arousal < 0.45 ? "Lo-Fi" : "Boom Bap",
    score: hipHopScore,
  });

  // Rock & Metal
  const rockScore = clamp(
    (lowMid + vocalBand + highMid) * 0.32 +
    arousal * 0.28 +
    clamp(input.spectralFlatness * 2.5 + input.zeroCrossingRate * 2) * 0.22 +
    normFlux * 0.18,
  ) * (arousal > 0.45 && highMid + vocalBand > 0.25 ? 1.05 : 0.5);
  genreCandidates.push({
    name: "Rock",
    subgenre: vocalPresence >= 0.45 ? "Indie Rock" : "Post-Rock",
    score: rockScore,
  });

  if (arousal > 0.65 && input.spectralFlatness > 0.18 && highMid + presence > 0.25) {
    genreCandidates.push({
      name: "Metal",
      score: clamp(arousal * 0.45 + input.spectralFlatness * 1.4 + normFlux * 0.25),
    });
  }

  // R&B
  const rnbScore = clamp(
    vocalPresence * 0.38 +
    (bass + lowMid) * 0.30 +
    (1 - clamp(Math.abs(bpm - 88) / 50)) * 0.18 +
    (1 - input.spectralFlatness) * 0.14,
  ) * (vocalPresence >= 0.45 ? 1.02 : 0.5);
  genreCandidates.push({ name: "R&B", subgenre: "Neo-Soul", score: rnbScore });

  // Jazz & Classical
  const activeChroma = normalize(input.chroma).filter((v) => v > 0.065).length;
  const harmonicComplexity = clamp((activeChroma - 3) / 6);
  const dynamicFactor = clamp(input.dynamicRangeDb / 22);
  const jazzScore = clamp(harmonicComplexity * 0.38 + dynamicFactor * 0.30 + (lowMid + vocalBand) * 0.20 + (1 - input.tempo.tempoStability * 0.5) * 0.12) * 0.85;
  genreCandidates.push({ name: "Jazz", subgenre: danceability > 0.5 ? "Bossa Nova" : undefined, score: jazzScore });

  const classicalScore = clamp(
    dynamicFactor * 0.38 +
    (1 - input.tempo.confidence) * 0.25 +
    (1 - input.spectralFlatness) * 0.22 +
    harmonicComplexity * 0.15,
  ) * (input.tempo.confidence < 0.45 && vocalPresence < 0.5 ? 0.95 : 0.45);
  genreCandidates.push({ name: "Classical", subgenre: "Chamber", score: classicalScore });

  // Folk & Country
  const folkScore = clamp(
    vocalBand * 0.34 +
    (1 - subBass) * 0.22 +
    dynamicFactor * 0.22 +
    vocalPresence * 0.22,
  ) * 0.78;
  genreCandidates.push({ name: "Folk & Country", score: folkScore });

  const genres = genreCandidates
    .sort((a, b) => b.score - a.score)
    .filter((item) => item.score >= 0.2)
    .slice(0, 3)
    .map((item) => ({
      name: item.name,
      ...(item.subgenre ? { subgenre: item.subgenre } : {}),
      confidence: rounded(clamp(item.score, 0.2, 0.96)),
    }));

  // Score moods
  const moodCandidates: { name: AnalysisMood; score: number }[] = [
    { name: "energetic", score: clamp(arousal * 0.55 + danceability * 0.30 + normFlux * 0.15) },
    { name: "party", score: clamp(danceability * 0.55 + arousal * 0.25 + valence * 0.20) },
    { name: "chill", score: clamp((1 - arousal) * 0.55 + (1 - normFlux) * 0.25 + (1 - input.spectralFlatness) * 0.20) },
    { name: "focus", score: clamp((1 - vocalPresence) * 0.45 + (1 - normFlux * 0.6) * 0.30 + input.activeFrameRatio * 0.25) },
    { name: "uplifting", score: clamp(valence * 0.55 + arousal * 0.25 + normCentroid * 0.20) },
    { name: "dark", score: clamp((1 - valence) * 0.45 + (1 - normCentroid) * 0.35 + (subBass + bass) * 0.20) },
    { name: "melancholic", score: clamp((1 - valence) * 0.50 + (1 - arousal) * 0.35 + (input.key.scale === "minor" ? 0.15 : 0)) },
    { name: "aggressive", score: clamp(arousal * 0.50 + clamp(input.spectralFlatness * 2) * 0.30 + normFlux * 0.20) * (arousal > 0.6 ? 1 : 0.4) },
    { name: "acoustic", score: clamp((1 - subBass) * 0.35 + clamp(input.dynamicRangeDb / 20) * 0.35 + (lowMid + vocalBand) * 0.30) },
  ];

  const moods = moodCandidates
    .sort((a, b) => b.score - a.score)
    .filter((item) => item.score >= 0.35)
    .slice(0, 3)
    .map((item) => ({
      name: item.name,
      confidence: rounded(clamp(item.score, 0.25, 0.96)),
    }));

  return {
    genres,
    moods,
    valence,
    arousal,
    danceability,
    voiceInstrumental: {
      label: voiceLabel,
      vocalPresence,
      confidence: voiceConfidence,
    },
  };
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
  private halfSecSum = 0;
  private levels: number[] = [];
  private halfSecRms: number[] = [];
  private waveform = new Array<number>(256).fill(0);
  private fftInput = new Float64Array(FFT);
  private chroma = new Array<number>(12).fill(0);
  private barkBands = new Array<number>(12).fill(0);
  private spectralContrast = new Array<number>(6).fill(0);
  private mfccMean = new Array<number>(MFCC_COUNT).fill(0);
  private mfccM2 = new Array<number>(MFCC_COUNT).fill(0);
  private prevLogMag: Float64Array | null = null;
  private spectralFrames = 0;
  private centroidSum = 0;
  private rolloffSum = 0;
  private flatnessSum = 0;
  private fluxSum = 0;
  private lowFluxSum = 0;
  private highFluxSum = 0;
  private frameSamples: number;
  private halfSecSamples: number;
  private fftStride: number;
  private melFilters: Float64Array[];

  constructor(private duration: number, private maxDuration: number, private rate = SAMPLE_RATE) {
    this.frameSamples = Math.max(1, Math.round(this.rate / 20)); // 50ms frames (20 Hz envelope)
    this.halfSecSamples = Math.max(1, Math.round(this.rate / 2)); // 0.5s structural frames
    // Sample up to ~450 spectral frames distributed across the entire track (intro, body, outro)
    const totalSamples = Math.max(FFT, Math.round(this.duration * this.rate));
    this.fftStride = Math.max(FFT * 2, Math.floor(totalSamples / 450 / FFT) * FFT);
    this.melFilters = buildMelFilterbank(this.rate);
  }

  push(chunk: Buffer) {
    const buffer = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const end = buffer.length - (buffer.length % 4);
    for (let i = 0; i < end; i += 4) {
      const sample = buffer.readFloatLE(i);
      if (!Number.isFinite(sample)) throw new Error("Audio decoder produced non-finite samples");
      if (this.count >= this.maxDuration * this.rate) throw new Error(`Track exceeds analysis duration limit (${this.maxDuration}s)`);
      const amplitude = Math.abs(sample);
      if (amplitude >= 0.001) {
        if (this.first < 0) this.first = this.count;
        this.last = this.count;
      }
      this.peak = Math.max(this.peak, amplitude);
      this.sum += sample * sample;
      this.frameSum += sample * sample;
      this.halfSecSum += sample * sample;
      if ((sample >= 0) !== (this.previous >= 0)) this.crossings++;
      this.previous = sample;

      const bin = Math.min(255, Math.floor((this.count / Math.max(1, this.duration * this.rate)) * 256));
      this.waveform[bin] = Math.max(this.waveform[bin]!, Math.min(1, amplitude));

      const offsetInStride = this.count % this.fftStride;
      if (offsetInStride < FFT) {
        this.fftInput[offsetInStride] = sample;
        if (offsetInStride === FFT - 1) this.addSpectrum();
      }

      this.count++;
      if (this.count % this.frameSamples === 0) {
        this.levels.push(Math.sqrt(this.frameSum / this.frameSamples));
        this.frameSum = 0;
      }
      if (this.count % this.halfSecSamples === 0) {
        this.halfSecRms.push(Math.sqrt(this.halfSecSum / this.halfSecSamples));
        this.halfSecSum = 0;
      }
    }
    this.carry = Buffer.from(buffer.subarray(end));
  }

  private addSpectrum() {
    const bins = spectrum(this.fftInput);
    const nBins = bins.length;
    let magSum = 0, weightedFreqSum = 0, powerSum = 0, logPowerSum = 0, validBins = 0;
    const logMag = new Float64Array(nBins);
    let frameFlux = 0, lowFlux = 0, highFlux = 0;

    for (let i = 1; i < nBins; i++) {
      const frequency = (i * this.rate) / FFT;
      const power = bins[i]!;
      const mag = Math.sqrt(power);
      magSum += mag;
      weightedFreqSum += frequency * mag;
      powerSum += power;
      logPowerSum += Math.log(power + 1e-12);
      validBins++;

      const lm = Math.log1p(10 * mag);
      logMag[i] = lm;
      if (this.prevLogMag) {
        const diff = Math.max(0, lm - this.prevLogMag[i]!);
        frameFlux += diff;
        if (frequency <= 200) lowFlux += diff;
        else if (frequency >= 2000) highFlux += diff;
      }

      // 12-band Bark energy
      let barkIdx = BARK_EDGES.findIndex((edge) => frequency <= edge);
      if (barkIdx < 0) barkIdx = 11;
      this.barkBands[Math.min(11, barkIdx)]! += power;

      // HPCP Chroma with local spectral peak emphasis
      if (frequency >= 55 && frequency <= 4000) {
        const prevP = bins[i - 1] ?? 0;
        const nextP = bins[i + 1] ?? 0;
        const peakWeight = power >= prevP && power >= nextP ? 1.35 : 0.65;
        const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
        this.chroma[(midi + 120) % 12]! += power * peakWeight;
      }
    }

    this.prevLogMag = logMag;
    if (powerSum <= 1e-12) return;

    this.spectralFrames++;
    const centroid = magSum > 0 ? weightedFreqSum / magSum : 0;
    this.centroidSum += centroid;

    // 85% Spectral Rolloff
    const rolloffTarget = powerSum * 0.85;
    let cumulative = 0, rolloffHz = 0;
    for (let i = 1; i < nBins; i++) {
      cumulative += bins[i]!;
      if (cumulative >= rolloffTarget) {
        rolloffHz = (i * this.rate) / FFT;
        break;
      }
    }
    this.rolloffSum += rolloffHz;

    // Spectral flatness (geometric mean / arithmetic mean)
    const geoMean = Math.exp(logPowerSum / Math.max(1, validBins));
    const arithMean = powerSum / Math.max(1, validBins);
    this.flatnessSum += clamp(arithMean > 0 ? geoMean / arithMean : 0);

    const normFactor = Math.max(1, validBins);
    this.fluxSum += frameFlux / normFactor;
    this.lowFluxSum += lowFlux / normFactor;
    this.highFluxSum += highFlux / normFactor;

    // 6-band spectral contrast
    for (let c = 0; c < 6; c++) {
      const fLow = CONTRAST_EDGES[c]!, fHigh = CONTRAST_EDGES[c + 1]!;
      const subBins: number[] = [];
      for (let i = 1; i < nBins; i++) {
        const f = (i * this.rate) / FFT;
        if (f >= fLow && f < fHigh) subBins.push(bins[i]!);
      }
      if (subBins.length) {
        subBins.sort((a, b) => a - b);
        const valley = subBins[Math.floor(subBins.length * 0.15)] ?? 1e-12;
        const peak = subBins[Math.floor(subBins.length * 0.85)] ?? 1e-12;
        this.spectralContrast[c]! += clamp(Math.log10((peak + 1e-10) / (valley + 1e-10)) / 4);
      }
    }

    // 13 MFCCs with Welford running mean & variance
    const logMel = this.melFilters.map((weights) => {
      let sum = 0;
      for (let k = 1; k < nBins; k++) sum += weights[k]! * bins[k]!;
      return Math.log(Math.max(1e-10, sum));
    });
    for (let n = 0; n < MFCC_COUNT; n++) {
      const row = DCT_MATRIX[n]!;
      let coeff = 0;
      for (let m = 0; m < MEL_BANDS; m++) coeff += row[m]! * logMel[m]!;
      coeff /= MEL_BANDS;
      const delta = coeff - this.mfccMean[n]!;
      this.mfccMean[n]! += delta / this.spectralFrames;
      const delta2 = coeff - this.mfccMean[n]!;
      this.mfccM2[n]! += delta * delta2;
    }
  }

  private computeStructure(durationSec: number, leadingSilenceSec: number, trailingSilenceSec: number): TrackAnalysisV2["structure"] {
    const buckets = this.halfSecRms.length ? this.halfSecRms : [Math.sqrt(this.sum / Math.max(1, this.count))];
    const toDb = (r: number) => rounded(r > 1e-5 ? clamp(20 * Math.log10(r), -96, 6) : -96);
    const fadeInContourDb = buckets.slice(0, 30).map(toDb);
    const fadeOutContourDb = buckets.slice(-30).map(toDb);

    const active = buckets.filter((r) => r >= 0.002).sort((a, b) => a - b);
    const medianRms = active.length ? active[Math.floor(active.length * 0.5)]! : 0;
    const peak90 = active.length ? active[Math.floor(active.length * 0.9)]! : 0;

    let introEndSec = leadingSilenceSec;
    if (medianRms > 0) {
      const maxIntroBucket = Math.min(buckets.length - 1, Math.ceil(Math.min(durationSec * 0.35, 45) * 2));
      for (let i = Math.floor(leadingSilenceSec * 2); i <= maxIntroBucket; i++) {
        if ((buckets[i] ?? 0) >= medianRms * 0.6) {
          introEndSec = i * 0.5;
          break;
        }
      }
    }

    const activeEndSec = Math.max(introEndSec, durationSec - trailingSilenceSec);
    let outroStartSec = activeEndSec;
    if (medianRms > 0) {
      const minOutroBucket = Math.max(Math.ceil(introEndSec * 2), Math.floor(Math.max(durationSec * 0.65, durationSec - 45) * 2));
      for (let i = Math.min(buckets.length - 1, Math.floor(activeEndSec * 2)); i >= minOutroBucket; i--) {
        if ((buckets[i] ?? 0) >= medianRms * 0.55) {
          outroStartSec = Math.min(durationSec, (i + 1) * 0.5);
          break;
        }
      }
    }

    let firstPeakSec = introEndSec;
    if (peak90 > 0) {
      for (let i = Math.floor(introEndSec * 2); i < buckets.length; i++) {
        if ((buckets[i] ?? 0) >= peak90 * 0.85) {
          firstPeakSec = i * 0.5;
          break;
        }
      }
    }

    return {
      introEndSec: rounded(clamp(introEndSec, 0, durationSec)),
      outroStartSec: rounded(clamp(outroStartSec, introEndSec, durationSec)),
      firstPeakSec: rounded(clamp(firstPeakSec, 0, durationSec)),
      fadeInContourDb: fadeInContourDb.length ? fadeInContourDb : [-96],
      fadeOutContourDb: fadeOutContourDb.length ? fadeOutContourDb : [-96],
    };
  }

  private computeSyllabicModulation() {
    if (this.levels.length < 20) return 0;
    // Measure 3-6 Hz envelope modulation (lag 3..6 frames at 20 Hz envelope rate) relative to mean level.
    const mean = this.levels.reduce((a, b) => a + b, 0) / this.levels.length;
    if (mean < 1e-4) return 0;
    let modEnergy = 0;
    for (let i = 2; i < this.levels.length; i++) {
      const bandPass = this.levels[i]! - 0.5 * (this.levels[i - 1]! + this.levels[i - 2]!);
      modEnergy += bandPass * bandPass;
    }
    const rmsMod = Math.sqrt(modEnergy / (this.levels.length - 2));
    return clamp(rmsMod / (mean * 1.5));
  }

  finish() {
    if (this.carry.length || !this.count) throw new Error("Audio decoder returned empty or incomplete audio");
    if (this.halfSecSum > 0 && !this.halfSecRms.length) {
      this.halfSecRms.push(Math.sqrt(this.halfSecSum / this.count));
    }
    const durationSec = this.count / this.rate;
    const rms = Math.sqrt(this.sum / this.count);
    const dynamicRangeDb = rms > 0 ? Math.max(0, 20 * Math.log10(this.peak / rms)) : 0;
    const crestFactorDb = rounded(dynamicRangeDb);
    const leadingSilenceSec = rounded(this.first < 0 ? durationSec : this.first / this.rate);
    const trailingSilenceSec = rounded(this.last < 0 ? durationSec : (this.count - 1 - this.last) / this.rate);

    const sf = Math.max(1, this.spectralFrames);
    const spectralCentroidHz = rounded(this.centroidSum / sf);
    const spectralRolloffHz = rounded(this.rolloffSum / sf);
    const spectralFlatness = rounded(clamp(this.flatnessSum / sf));
    const spectralFlux = rounded(Math.max(0, this.fluxSum / sf));
    const zeroCrossingRate = rounded(clamp(this.crossings / this.count));

    const tempo = estimateTempo(this.levels);
    const key = estimateKey(this.chroma);
    const structure = this.computeStructure(durationSec, leadingSilenceSec, trailingSilenceSec);

    const mfccStd = this.mfccM2.map((m2) => Math.sqrt(m2 / sf));
    const contrast = this.spectralContrast.map((c) => clamp(c / sf));
    const activeFrameRatio = this.levels.length
      ? this.levels.filter((l) => l >= rms * 0.25 && l >= 0.002).length / this.levels.length
      : 0;
    const syllabicModulation = this.computeSyllabicModulation();

    const classification = classifyAudioFeatures({
      rms,
      peak: this.peak,
      dynamicRangeDb,
      barkBands: this.barkBands,
      spectralCentroidHz,
      spectralRolloffHz,
      spectralFlatness,
      spectralFlux,
      zeroCrossingRate,
      mfccMean: this.mfccMean,
      mfccStd,
      spectralContrast: contrast,
      chroma: this.chroma,
      tempo,
      key,
      activeFrameRatio,
      syllabicModulation,
      lowBandFlux: this.lowFluxSum / sf,
      highBandFlux: this.highFluxSum / sf,
    });

    // 64-dimensional normalized feature vector (audio-embedding-v2):
    // [0..11]: 12 chroma, [12..23]: 12 Bark bands, [24..36]: 13 MFCC means (scaled),
    // [37..49]: 13 MFCC stds (scaled), [50..55]: 6 spectral contrast, [56..63]: 8 rhythm/dynamic/semantic descriptors
    const normMfccMean = this.mfccMean.map((v) => clamp((v + 15) / 30));
    const normMfccStd = mfccStd.map((v) => clamp(v / 5));
    const vector = [
      ...normalize(this.chroma),
      ...normalize(this.barkBands),
      ...normMfccMean,
      ...normMfccStd,
      ...contrast,
      tempo.bpm ? clamp(tempo.bpm / 220) : 0,
      tempo.tempoStability,
      classification.danceability,
      classification.valence,
      classification.arousal,
      classification.voiceInstrumental.vocalPresence,
      clamp(rms),
      clamp(dynamicRangeDb / 40),
    ].map(rounded);

    // Estimate short-term max loudness from 3-second (6 half-sec buckets) sliding window
    let maxShortTermRms = 0;
    for (let i = 0; i < this.halfSecRms.length; i++) {
      const slice = this.halfSecRms.slice(i, i + 6);
      const stRms = Math.sqrt(slice.reduce((sum, v) => sum + v * v, 0) / slice.length);
      if (stRms > maxShortTermRms) maxShortTermRms = stRms;
    }
    const shortTermMaxLufs = maxShortTermRms > 1e-4 ? rounded(clamp(-0.691 + 20 * Math.log10(maxShortTermRms), -70, 6)) : null;

    return {
      durationSec: rounded(durationSec),
      leadingSilenceSec,
      trailingSilenceSec,
      crestFactorDb: rms > 1e-4 ? crestFactorDb : null,
      shortTermMaxLufs,
      energy: {
        rms: rounded(rms),
        peak: rounded(this.peak),
        dynamicRangeDb: rounded(dynamicRangeDb),
        spectralCentroidHz,
        spectralRolloffHz,
        spectralFlux,
        spectralFlatness,
        zeroCrossingRate,
      },
      waveform: this.waveform.map(rounded),
      tempo,
      key,
      structure,
      classification,
      similarity: {
        method: "audio-embedding-v2" as const,
        vector,
        confidence: rms > 0.0001 ? 0.78 : 0,
      },
    };
  }
}

/** Preserve every channel's envelope: phase-inverted stereo must never look like silence. */
export class MultichannelDescriptors {
  private carry = Buffer.alloc(0);
  private analyzers: AudioDescriptors[];
  constructor(private channels: number, duration: number, maxDuration: number, rate = SAMPLE_RATE) {
    if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw new Error("Audio channel count exceeds analysis resource limit (8)");
    this.analyzers = Array.from({ length: channels }, () => new AudioDescriptors(duration, maxDuration, rate));
  }
  push(chunk: Buffer) {
    const buffer = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const frameBytes = 4 * this.channels, end = buffer.length - (buffer.length % frameBytes);
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
    vector[62] = rounded(clamp(rms));
    vector[63] = rounded(clamp(dynamicRangeDb / 40));
    return {
      ...representative,
      leadingSilenceSec: Math.min(...channels.map((item) => item.leadingSilenceSec)),
      trailingSilenceSec: Math.min(...channels.map((item) => item.trailingSilenceSec)),
      crestFactorDb: rms > 1e-4 ? rounded(dynamicRangeDb) : null,
      energy: {
        ...representative.energy,
        rms: rounded(rms),
        peak,
        dynamicRangeDb: rounded(dynamicRangeDb),
      },
      waveform: representative.waveform.map((_, bin) => Math.max(...channels.map((item) => item.waveform[bin]!))),
      similarity: { ...representative.similarity, vector },
    };
  }
}
