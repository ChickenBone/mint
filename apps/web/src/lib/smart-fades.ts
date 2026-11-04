import type { TrackAnalysis } from "@mint/core/analysis";
import type { DspSettings, PlayerItem } from "./player-protocol";

export function normalizationGain(analysis: TrackAnalysis | null | undefined, targetLufs: number): number {
  if (!analysis || analysis.integratedLufs === null || analysis.truePeakDbtp === null) return 0;
  return Math.max(-24, Math.min(12, targetLufs - analysis.integratedLufs, -1.5 - analysis.truePeakDbtp));
}

export function smartTransition(input: {
  from: PlayerItem; to: PlayerItem; outgoing?: TrackAnalysis | null; incoming?: TrackAnalysis | null;
  settings: DspSettings; shuffled: boolean; outgoingDuration: number;
}) {
  const { from, to, outgoing, incoming, settings } = input;
  const none = (reason: string) => ({ seconds: 0, skipIntro: 0, endAt: input.outgoingDuration, reason });
  if (settings.fadeMode === "off" || !settings.crossfade) return none("Transitions off");
  if (settings.albumSafe && !input.shuffled && from.albumId && from.albumId === to.albumId && from.album) {
    return none("Album-safe: preserving the original track boundary");
  }
  if (settings.fadeMode === "fixed") return { seconds: settings.crossfade, skipIntro: 0, endAt: input.outgoingDuration, reason: "Fixed equal-power crossfade" };
  if (!outgoing || !incoming) return { seconds: Math.min(3, settings.crossfade), skipIntro: 0, endAt: input.outgoingDuration, reason: "Analysis unavailable: short fixed fallback" };
  const endAt = Math.max(input.outgoingDuration / 2, input.outgoingDuration - outgoing.trailingSilenceSec);
  const skipIntro = Math.min(incoming.leadingSilenceSec, incoming.durationSec / 4, 15);
  const outTail = outgoing.waveform.slice(-Math.max(1, Math.ceil(outgoing.waveform.length * Math.min(settings.crossfade, endAt) / outgoing.durationSec)));
  const inHead = incoming.waveform.slice(0, Math.max(1, Math.ceil(incoming.waveform.length * settings.crossfade / incoming.durationSec)));
  const outEnergy = outTail.reduce((sum, value) => sum + value, 0) / outTail.length;
  const inEnergy = inHead.reduce((sum, value) => sum + value, 0) / inHead.length;
  const density = Math.max(outEnergy, inEnergy);
  const adaptive = density > .65 ? settings.crossfade * .4 : density > .35 ? settings.crossfade * .7 : settings.crossfade;
  const seconds = Math.max(.25, Math.min(adaptive, endAt / 4, (incoming.durationSec - skipIntro) / 4));
  return { seconds, skipIntro, endAt, reason: `Smart Fade · ${seconds.toFixed(1)}s · ${density > .65 ? "dense boundary, shorter overlap" : "audio-energy matched"}${outgoing.trailingSilenceSec > .1 || skipIntro > .1 ? " · silence trimmed" : ""}` };
}
