import { z } from "zod";

export const matchingControlsSchema = z.object({
  enabled: z.boolean(),
});

export type MatchingControls = z.infer<typeof matchingControlsSchema>;

export const matchingViewSchema = matchingControlsSchema.extend({
  keyConfigured: z.boolean(),
  keyHint: z.string().nullable(),
});

export type MatchingView = z.infer<typeof matchingViewSchema>;

export const DEFAULT_MATCHING_CONTROLS: MatchingControls = {
  enabled: false,
};

export const openaiApiKeySchema = z.string().trim().regex(/^sk-[A-Za-z0-9_-]{16,220}$/);

export function openAiKeyHint(apiKey: string): string {
  return apiKey.slice(-4);
}

/** What Decisions should return: the song itself, not a music video or alternate version. */
export const CLEAN_RECORDING_INSTRUCTIONS = [
  "Choose the clean studio audio for this exact song: the recording a listener would play, not a video.",
  "Prefer a YouTube Topic channel, then a title marked Official Audio. Those are the song itself.",
  "Do not choose a music video when clean studio audio is available. A VEVO upload is a music video unless its title says Official Audio.",
  "Music videos run longer than the song. When durations differ, choose the clean audio closest to the song.",
  "A collaboration is often filed under only the first artist's Topic channel. That is still the clean recording when the title matches.",
  "Reject live, remix, cover, karaoke, instrumental, acoustic, demo, sped-up, slowed, edit, visualizer, and lyrics versions.",
  "If no Topic or Official Audio choice is available, choose the official artist music video closest to the song's duration.",
  "Choose none only when every choice is a lyric video, remix, cover, live performance, or a different song.",
].join(" ");

/** A Topic "Preview" is a clip, not the studio recording. */
export function isPreviewUpload(title: string) {
  const normalized = title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return /(?:^|[^a-z0-9])preview(?:[^a-z0-9]|$)/.test(normalized);
}

export function recordingUploadKind(title: string, channel: string) {
  const normalizedTitle = title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const normalizedChannel = channel.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  if (normalizedChannel.includes("topic") || normalizedTitle.includes("official audio")) return "clean studio audio";
  if (normalizedChannel.endsWith("vevo") || normalizedTitle.includes("official video") || normalizedTitle.includes("official music video")) return "music video";
  return "upload";
}
