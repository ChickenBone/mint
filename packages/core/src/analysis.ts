import { z } from "zod";

export const ANALYSIS_VERSION = 1;
export const ANALYSIS_ALGORITHM = "mint-dsp-v1";
const finite = z.number().finite();
const confidence = finite.min(0).max(1);
export const analysisSchema = z.object({
  version: z.literal(ANALYSIS_VERSION),
  algorithm: z.literal(ANALYSIS_ALGORITHM),
  fingerprint: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: finite.int().positive(), mtimeMs: finite.nonnegative() }),
  measuredAt: z.string().datetime(),
  durationSec: finite.positive(),
  integratedLufs: finite.min(-120).max(20).nullable(),
  truePeakDbtp: finite.min(-150).max(30).nullable(),
  leadingSilenceSec: finite.nonnegative(),
  trailingSilenceSec: finite.nonnegative(),
  energy: z.object({ rms: finite.nonnegative(), peak: finite.nonnegative(), dynamicRangeDb: finite.nonnegative() }),
  waveform: z.array(finite.min(0).max(1)).min(1).max(256),
  tempo: z.object({ bpm: finite.min(40).max(220).nullable(), confidence }),
  key: z.object({ name: z.string().max(20).nullable(), confidence }),
  similarity: z.object({ method: z.literal("audio-descriptors-v1"), vector: z.array(finite).length(25), confidence }),
  provenance: z.object({ engine: z.literal("ffmpeg+mint-dsp"), sampleRate: z.literal(8000), notes: z.array(z.string().max(300)).max(12) }),
});
export type TrackAnalysis = z.infer<typeof analysisSchema>;
export const analysisStatusSchema = z.enum(["pending", "running", "complete", "failed", "cancelled"]);
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;

export const analysisControlsSchema = z.object({
  enabled: z.boolean(),
  paused: z.boolean(),
  concurrency: z.number().int().min(1).max(4),
  maxDurationSec: z.number().int().min(10).max(7200),
  timeoutSec: z.number().int().min(10).max(900),
  intervalSec: z.number().int().min(5).max(3600),
  startHourUtc: z.number().int().min(0).max(23),
  endHourUtc: z.number().int().min(0).max(24),
});
export type AnalysisControls = z.infer<typeof analysisControlsSchema>;
export const DEFAULT_ANALYSIS_CONTROLS: AnalysisControls = {
  enabled: true, paused: false, concurrency: 1, maxDurationSec: 3600,
  timeoutSec: 300, intervalSec: 30, startHourUtc: 0, endHourUtc: 24,
};

export function withinAnalysisWindow(hour: number, start: number, end: number) {
  return start === end || (start < end ? hour >= start && hour < end : hour >= start || hour < end);
}

/** Audio descriptors, not neural embeddings. Lower means closer; incomparable versions are rejected. */
export function analysisDistance(a: TrackAnalysis, b: TrackAnalysis): number | null {
  if (a.version !== b.version || a.algorithm !== b.algorithm ||
      a.similarity.method !== b.similarity.method || a.similarity.vector.length !== b.similarity.vector.length) return null;
  return Math.sqrt(a.similarity.vector.reduce((sum, value, i) => sum + (value - b.similarity.vector[i]!) ** 2, 0) / a.similarity.vector.length);
}
