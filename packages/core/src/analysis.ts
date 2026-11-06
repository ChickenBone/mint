import { z } from "zod";

export const ANALYSIS_V1_VERSION = 1;
export const ANALYSIS_V1_ALGORITHM = "mint-dsp-v1";
export const ANALYSIS_VERSION = 2;
export const ANALYSIS_ALGORITHM = "mint-dsp-v2";

const finite = z.number().finite();
const confidence = finite.min(0).max(1);

export const CANONICAL_GENRES = [
  "Electronic",
  "Rock",
  "Pop",
  "Hip-Hop",
  "R&B",
  "Jazz",
  "Classical",
  "Folk & Country",
  "Metal",
  "Ambient",
  "Latin",
  "Reggae & Dub",
  "Blues",
  "Experimental",
] as const;

export const ANALYSIS_MOODS = [
  "energetic",
  "chill",
  "dark",
  "uplifting",
  "melancholic",
  "aggressive",
  "acoustic",
  "party",
  "focus",
] as const;

export const analysisMoodSchema = z.enum(ANALYSIS_MOODS);
export type AnalysisMood = z.infer<typeof analysisMoodSchema>;

export const analysisVocalTypeSchema = z.enum(["vocal", "instrumental", "spoken-word"]);
export type AnalysisVocalType = z.infer<typeof analysisVocalTypeSchema>;

export const analysisExecutionModeSchema = z.enum(["remote-only", "prefer-remote", "hybrid"]);
export type AnalysisExecutionMode = z.infer<typeof analysisExecutionModeSchema>;

const fingerprintSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: finite.int().positive(),
  mtimeMs: finite.nonnegative(),
});

export const analysisV1Schema = z.object({
  version: z.literal(ANALYSIS_V1_VERSION),
  algorithm: z.literal(ANALYSIS_V1_ALGORITHM),
  fingerprint: fingerprintSchema,
  measuredAt: z.string().datetime(),
  durationSec: finite.positive(),
  integratedLufs: finite.min(-120).max(20).nullable(),
  truePeakDbtp: finite.min(-150).max(30).nullable(),
  leadingSilenceSec: finite.nonnegative(),
  trailingSilenceSec: finite.nonnegative(),
  energy: z.object({
    rms: finite.nonnegative(),
    peak: finite.nonnegative(),
    dynamicRangeDb: finite.nonnegative(),
  }),
  waveform: z.array(finite.min(0).max(1)).min(1).max(256),
  tempo: z.object({
    bpm: finite.min(40).max(220).nullable(),
    confidence,
  }),
  key: z.object({
    name: z.string().max(20).nullable(),
    confidence,
  }),
  similarity: z.object({
    method: z.literal("audio-descriptors-v1"),
    vector: z.array(finite).length(25),
    confidence,
  }),
  provenance: z.object({
    engine: z.literal("ffmpeg+mint-dsp"),
    sampleRate: z.literal(8000),
    notes: z.array(z.string().max(300)).max(12),
  }),
});
export type TrackAnalysisV1 = z.infer<typeof analysisV1Schema>;

export const analysisV2Schema = z.object({
  version: z.literal(ANALYSIS_VERSION),
  algorithm: z.literal(ANALYSIS_ALGORITHM),
  fingerprint: fingerprintSchema,
  measuredAt: z.string().datetime(),
  durationSec: finite.positive(),
  integratedLufs: finite.min(-120).max(20).nullable(),
  truePeakDbtp: finite.min(-150).max(30).nullable(),
  lraLu: finite.min(0).max(100).nullable().default(null),
  shortTermMaxLufs: finite.min(-120).max(20).nullable().default(null),
  crestFactorDb: finite.min(0).max(100).nullable().default(null),
  leadingSilenceSec: finite.nonnegative(),
  trailingSilenceSec: finite.nonnegative(),
  energy: z.object({
    rms: finite.nonnegative(),
    peak: finite.nonnegative(),
    dynamicRangeDb: finite.nonnegative(),
    spectralCentroidHz: finite.nonnegative().optional(),
    spectralRolloffHz: finite.nonnegative().optional(),
    spectralFlux: finite.nonnegative().optional(),
    spectralFlatness: finite.min(0).max(1).optional(),
    zeroCrossingRate: finite.min(0).max(1).optional(),
  }),
  waveform: z.array(finite.min(0).max(1)).min(1).max(256),
  tempo: z.object({
    bpm: finite.min(40).max(220).nullable(),
    confidence,
    tempoStability: confidence.default(0),
    firstDownbeatSec: finite.nonnegative().nullable().default(0),
    beatIntervalSec: finite.nonnegative().nullable().default(null),
    timeSignature: z.enum(["4/4", "3/4", "6/8"]).default("4/4"),
  }),
  key: z.object({
    name: z.string().max(20).nullable(),
    camelot: z.string().regex(/^(?:[1-9]|1[0-2])[AB]$/).nullable().default(null),
    openKey: z.string().regex(/^(?:[1-9]|1[0-2])[dm]$/).nullable().default(null),
    scale: z.enum(["major", "minor"]).nullable().default(null),
    confidence,
  }),
  structure: z.object({
    introEndSec: finite.nonnegative(),
    outroStartSec: finite.nonnegative(),
    firstPeakSec: finite.nonnegative(),
    fadeInContourDb: z.array(finite.min(-96).max(6)).min(1).max(60),
    fadeOutContourDb: z.array(finite.min(-96).max(6)).min(1).max(60),
  }),
  classification: z.object({
    genres: z.array(z.object({
      name: z.string().min(1).max(60),
      subgenre: z.string().min(1).max(60).optional(),
      confidence,
    })).max(4),
    moods: z.array(z.object({
      name: analysisMoodSchema,
      confidence,
    })).max(4),
    valence: confidence,
    arousal: confidence,
    danceability: confidence,
    voiceInstrumental: z.object({
      label: analysisVocalTypeSchema,
      vocalPresence: confidence,
      confidence,
    }),
  }),
  similarity: z.object({
    method: z.literal("audio-embedding-v2"),
    vector: z.array(finite).length(64),
    confidence,
  }),
  provenance: z.object({
    engine: z.string().min(1).max(120),
    sampleRate: z.union([z.literal(16000), z.literal(22050)]),
    notes: z.array(z.string().max(300)).max(16),
  }),
});
export type TrackAnalysisV2 = z.infer<typeof analysisV2Schema>;

export const analysisSchema = z.discriminatedUnion("version", [analysisV1Schema, analysisV2Schema]);
export type TrackAnalysis = z.infer<typeof analysisSchema>;

export const analysisStatusSchema = z.enum(["pending", "running", "complete", "failed", "cancelled"]);
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;

export function defaultExecutionMode(): AnalysisExecutionMode {
  return process.env.ANALYSIS_REMOTE_ONLY === "true" ? "remote-only" : "hybrid";
}

export const analysisControlsSchema = z.object({
  enabled: z.boolean(),
  paused: z.boolean(),
  executionMode: analysisExecutionModeSchema.default(() => defaultExecutionMode()),
  concurrency: z.number().int().min(1).max(4),
  maxDurationSec: z.number().int().min(10).max(7200),
  timeoutSec: z.number().int().min(10).max(900),
  intervalSec: z.number().int().min(5).max(3600),
  startHourUtc: z.number().int().min(0).max(23),
  endHourUtc: z.number().int().min(0).max(24),
});
export type AnalysisControls = z.infer<typeof analysisControlsSchema>;
export const DEFAULT_ANALYSIS_CONTROLS: AnalysisControls = {
  enabled: true,
  paused: false,
  executionMode: defaultExecutionMode(),
  concurrency: 1,
  maxDurationSec: 3600,
  timeoutSec: 300,
  intervalSec: 30,
  startHourUtc: 0,
  endHourUtc: 24,
};

export function withinAnalysisWindow(hour: number, start: number, end: number) {
  return start === end || (start < end ? hour >= start && hour < end : hour >= start || hour < end);
}

function fallbackFeatureProjection(item: TrackAnalysis): number[] {
  const chroma = item.similarity.vector.slice(0, 12);
  const rms = Math.min(1, Math.max(0, item.energy.rms));
  const dynamic = Math.min(1, Math.max(0, item.energy.dynamicRangeDb / 40));
  const tempo = item.tempo.bpm ? Math.min(1, Math.max(0, item.tempo.bpm / 220)) : 0;
  const peak = Math.min(1, Math.max(0, item.energy.peak));
  return [...chroma, rms, dynamic, tempo, peak];
}

/** Audio descriptors / embeddings. Lower means closer; invalid vectors are rejected, and mixed v1/v2 compare via shared projection. */
export function analysisDistance(a: TrackAnalysis, b: TrackAnalysis): number | null {
  const validA = (a.version === 1 && a.algorithm === "mint-dsp-v1" && a.similarity.method === "audio-descriptors-v1" && a.similarity.vector.length === 25) ||
    (a.version === 2 && a.algorithm === "mint-dsp-v2" && a.similarity.method === "audio-embedding-v2" && a.similarity.vector.length === 64);
  const validB = (b.version === 1 && b.algorithm === "mint-dsp-v1" && b.similarity.method === "audio-descriptors-v1" && b.similarity.vector.length === 25) ||
    (b.version === 2 && b.algorithm === "mint-dsp-v2" && b.similarity.method === "audio-embedding-v2" && b.similarity.vector.length === 64);
  if (!validA || !validB) return null;

  if (a.version === b.version) {
    const vecA = a.similarity.vector;
    const vecB = b.similarity.vector;
    const euclidean = Math.sqrt(vecA.reduce((sum, value, i) => sum + (value - vecB[i]!) ** 2, 0) / vecA.length);
    if (a.version === 1) return euclidean;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i]! * vecB[i]!;
      normA += vecA[i]! * vecA[i]!;
      normB += vecB[i]! * vecB[i]!;
    }
    const denom = Math.sqrt(normA * normB);
    const cosineDist = denom > 1e-9 ? Math.max(0, 1 - dot / denom) : 1;
    return Number((0.6 * euclidean + 0.4 * Math.sqrt(cosineDist)).toFixed(6));
  }

  const projA = fallbackFeatureProjection(a);
  const projB = fallbackFeatureProjection(b);
  const base = Math.sqrt(projA.reduce((sum, value, i) => sum + (value - projB[i]!) ** 2, 0) / projA.length);
  return Number((base + 0.04).toFixed(6));
}
