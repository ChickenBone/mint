import { z } from "zod";

const finite = z.number().finite();
const confidence = finite.min(0).max(1);
// Consumer measurements only: no media fingerprint, worker notes or embedding.
export const trackAnalysisResultSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  algorithm: z.enum(["mint-dsp-v1", "mint-dsp-v2"]),
  measuredAt: z.string().datetime(),
  durationSec: finite.positive(),
  integratedLufs: finite.min(-120).max(20).nullable(),
  truePeakDbtp: finite.min(-150).max(30).nullable(),
  lraLu: finite.min(0).max(100).nullable().optional(),
  crestFactorDb: finite.min(0).max(100).nullable().optional(),
  leadingSilenceSec: finite.nonnegative(),
  trailingSilenceSec: finite.nonnegative(),
  energy: z.object({
    rms: finite.nonnegative(), peak: finite.nonnegative(), dynamicRangeDb: finite.nonnegative(),
    spectralCentroidHz: finite.nonnegative().optional(), spectralRolloffHz: finite.nonnegative().optional(),
    spectralFlux: finite.nonnegative().optional(), spectralFlatness: confidence.optional(),
    zeroCrossingRate: confidence.optional(),
  }),
  waveform: z.array(confidence).min(1).max(256),
  tempo: z.object({ bpm: finite.min(40).max(220).nullable(), confidence }),
  key: z.object({ name: z.string().max(20).nullable(), confidence }),
  structure: z.object({
    introEndSec: finite.nonnegative(), outroStartSec: finite.nonnegative(), firstPeakSec: finite.nonnegative(),
    fadeInContourDb: z.array(finite.min(-96).max(6)).min(1).max(60),
    fadeOutContourDb: z.array(finite.min(-96).max(6)).min(1).max(60),
  }).optional(),
  classification: z.object({
    genres: z.array(z.object({ name: z.string().max(60), confidence })).max(4),
    moods: z.array(z.object({ name: z.string().max(60), confidence })).max(4),
    valence: confidence, arousal: confidence, danceability: confidence,
  }).optional(),
});
export const trackAnalysisResponseSchema = z.object({
  status: z.enum(["missing", "pending", "running", "complete", "failed", "cancelled"]),
  version: finite.int().nullable(),
  upgrading: z.boolean(),
  result: trackAnalysisResultSchema.nullable(),
});
export type TrackAnalysisResult = z.infer<typeof trackAnalysisResultSchema>;
export type TrackAnalysisResponse = z.infer<typeof trackAnalysisResponseSchema>;
