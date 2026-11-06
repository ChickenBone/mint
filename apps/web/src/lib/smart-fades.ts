import type { TrackAnalysis } from "@mint/core/analysis";
import type { DspSettings, PlayerItem } from "./player-protocol";

export interface NormalizationOptions {
  mode?: "track" | "album" | "auto";
  sameAlbumSequence?: boolean;
  albumGainDb?: number | null;
}

export function normalizationGain(
  analysis: TrackAnalysis | null | undefined,
  targetLufs: number,
  options?: NormalizationOptions,
): number {
  if (!analysis || analysis.integratedLufs === null || analysis.truePeakDbtp === null) return 0;
  const mode = options?.mode ?? "track";
  const headroomLimit = -1.5 - analysis.truePeakDbtp;
  if ((mode === "album" || (mode === "auto" && options?.sameAlbumSequence)) && options?.albumGainDb !== undefined && options.albumGainDb !== null) {
    return Math.max(-24, Math.min(12, options.albumGainDb, headroomLimit));
  }
  let desiredGain = targetLufs - analysis.integratedLufs;
  if (mode === "album" || (mode === "auto" && options?.sameAlbumSequence)) {
    // Preserve relative album dynamics when playing an album in order by avoiding aggressive upward boosts on quiet interludes.
    if (desiredGain > 3) desiredGain = 3;
  }
  if (analysis.version === 2 && analysis.lraLu !== null && analysis.lraLu > 12 && desiredGain > 0) {
    const lraCap = Math.max(2, 12 - (analysis.lraLu - 12) * 0.5);
    desiredGain = Math.min(desiredGain, lraCap);
  }
  return Math.max(-24, Math.min(12, desiredGain, headroomLimit));
}

export function camelotCompatibility(
  outgoingKey?: { name: string | null; camelot?: string | null; confidence: number } | null,
  incomingKey?: { name: string | null; camelot?: string | null; confidence: number } | null,
): { match: "exact" | "relative" | "adjacent" | "compatible" | "clash" | "unknown"; score: number; label: string | null } {
  if (!outgoingKey || !incomingKey || outgoingKey.confidence < 0.25 || incomingKey.confidence < 0.25) {
    return { match: "unknown", score: 0.6, label: null };
  }
  const c1 = outgoingKey.camelot ? /^(\d{1,2})([AB])$/.exec(outgoingKey.camelot) : null;
  const c2 = incomingKey.camelot ? /^(\d{1,2})([AB])$/.exec(incomingKey.camelot) : null;
  if (c1 && c2) {
    const n1 = Number(c1[1]), l1 = c1[2]!, n2 = Number(c2[1]), l2 = c2[2]!;
    const pair = `${outgoingKey.camelot} → ${incomingKey.camelot}`;
    if (n1 === n2 && l1 === l2) return { match: "exact", score: 1.0, label: `${pair} harmonic match` };
    if (n1 === n2 && l1 !== l2) return { match: "relative", score: 0.92, label: `${pair} relative key` };
    const wheelDist = Math.min(Math.abs(n1 - n2), 12 - Math.abs(n1 - n2));
    if (wheelDist === 1 && l1 === l2) return { match: "adjacent", score: 0.86, label: `${pair} harmonic fifth` };
    if ((wheelDist === 1 && l1 !== l2) || (wheelDist === 2 && l1 === l2)) return { match: "compatible", score: 0.68, label: pair };
    return { match: "clash", score: 0.3, label: `${pair} key contrast` };
  }
  if (outgoingKey.name && incomingKey.name) {
    if (outgoingKey.name === incomingKey.name) return { match: "exact", score: 1.0, label: `${outgoingKey.name} match` };
    return { match: "clash", score: 0.45, label: `${outgoingKey.name} → ${incomingKey.name}` };
  }
  return { match: "unknown", score: 0.6, label: null };
}

function tempoCompatibility(
  outTempo: TrackAnalysis["tempo"],
  inTempo: TrackAnalysis["tempo"],
): { matched: boolean; bpm: number | null; beatSec: number | null } {
  if (!outTempo.bpm || !inTempo.bpm || outTempo.confidence < 0.35 || inTempo.confidence < 0.35) {
    return { matched: false, bpm: null, beatSec: null };
  }
  const ratio = outTempo.bpm / inTempo.bpm;
  const closeDirect = Math.abs(ratio - 1) <= 0.06;
  const closeHalf = Math.abs(ratio - 0.5) <= 0.04;
  const closeDouble = Math.abs(ratio - 2.0) <= 0.08;
  if (!closeDirect && !closeHalf && !closeDouble) {
    return { matched: false, bpm: null, beatSec: null };
  }
  const referenceBpm = Math.round((outTempo.bpm + (closeHalf ? inTempo.bpm * 0.5 : closeDouble ? inTempo.bpm * 2 : inTempo.bpm)) / 2);
  const beatSec = 60 / Math.max(40, Math.min(240, referenceBpm));
  return { matched: true, bpm: referenceBpm, beatSec };
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

  let endAt = Math.max(input.outgoingDuration / 2, input.outgoingDuration - outgoing.trailingSilenceSec);
  let skipIntro = Math.min(incoming.leadingSilenceSec, incoming.durationSec / 4, 15);

  if (outgoing.version === 2) {
    const contour = outgoing.structure.fadeOutContourDb;
    const windowSec = Math.min(30, outgoing.durationSec / 2);
    const crossIdx = contour.findIndex((db) => db <= -15);
    if (crossIdx >= 0 && windowSec > 0) {
      const contourCrossSec = outgoing.durationSec - windowSec + ((crossIdx + 1) / contour.length) * windowSec;
      endAt = Math.max(input.outgoingDuration * 0.55, Math.min(endAt, contourCrossSec));
    } else if (outgoing.structure.outroStartSec < endAt) {
      endAt = Math.max(input.outgoingDuration * 0.65, Math.min(endAt, outgoing.structure.outroStartSec + settings.crossfade));
    }
  }

  if (incoming.version === 2) {
    const contour = incoming.structure.fadeInContourDb;
    const windowSec = Math.min(30, incoming.durationSec / 2);
    const readyIdx = contour.findIndex((db) => db >= -18);
    if (readyIdx > 0 && windowSec > 0) {
      const contourIntroSec = (readyIdx / contour.length) * windowSec;
      skipIntro = Math.min(incoming.durationSec / 4, 15, Math.max(skipIntro, Math.min(incoming.structure.introEndSec, contourIntroSec)));
    }
  }

  const outTail = outgoing.waveform.slice(-Math.max(1, Math.ceil(outgoing.waveform.length * Math.min(settings.crossfade, endAt) / outgoing.durationSec)));
  const inHead = incoming.waveform.slice(0, Math.max(1, Math.ceil(incoming.waveform.length * settings.crossfade / incoming.durationSec)));
  const outEnergy = outTail.reduce((sum, value) => sum + value, 0) / outTail.length;
  const inEnergy = inHead.reduce((sum, value) => sum + value, 0) / inHead.length;
  const density = Math.max(outEnergy, inEnergy);

  let adaptive = density > 0.65 ? settings.crossfade * 0.4 : density > 0.35 ? settings.crossfade * 0.7 : settings.crossfade;
  if (outgoing.version === 1 || incoming.version === 1) {
    const seconds = Math.max(0.25, Math.min(adaptive, endAt / 4, (incoming.durationSec - skipIntro) / 4));
    return {
      seconds,
      skipIntro,
      endAt,
      reason: `Smart Fade · ${seconds.toFixed(1)}s · ${density > 0.65 ? "dense boundary, shorter overlap" : "audio-energy matched"}${outgoing.trailingSilenceSec > 0.1 || skipIntro > 0.1 ? " · silence trimmed" : ""}`,
    };
  }

  const harmonic = camelotCompatibility(outgoing.key, incoming.key);
  const tempo = tempoCompatibility(outgoing.tempo, incoming.tempo);
  const outVocal = outgoing.classification.voiceInstrumental.label === "vocal" && outgoing.classification.voiceInstrumental.vocalPresence > 0.55;
  const inVocal = incoming.classification.voiceInstrumental.label === "vocal" && incoming.classification.voiceInstrumental.vocalPresence > 0.55;
  const vocalClash = outVocal && inVocal && density > 0.32;

  if (vocalClash) {
    adaptive = Math.min(adaptive, settings.crossfade * 0.42);
  } else if (density <= 0.65 && (harmonic.match === "exact" || harmonic.match === "relative" || harmonic.match === "adjacent")) {
    adaptive = Math.min(settings.crossfade, adaptive * 1.25);
  } else if (harmonic.match === "clash") {
    adaptive = adaptive * 0.6;
  }

  let matchedBeats: number | null = null;
  if (tempo.matched && tempo.beatSec && outgoing.tempo.firstDownbeatSec !== null && incoming.tempo.firstDownbeatSec !== null) {
    const candidates = [4, 8, 16];
    let bestBeats = 4;
    let bestDiff = Infinity;
    for (const beats of candidates) {
      const dur = beats * tempo.beatSec;
      if (dur <= settings.crossfade * 1.15) {
        const diff = Math.abs(dur - adaptive);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestBeats = beats;
        }
      }
    }
    const phraseSec = bestBeats * tempo.beatSec;
    if (!vocalClash && phraseSec >= 0.5 && phraseSec <= settings.crossfade * 1.15) {
      adaptive = Math.min(settings.crossfade, phraseSec);
      matchedBeats = bestBeats;
    }
    if (incoming.tempo.firstDownbeatSec >= skipIntro && incoming.tempo.firstDownbeatSec - skipIntro <= 2.0) {
      skipIntro = Math.min(incoming.durationSec / 4, 15, incoming.tempo.firstDownbeatSec);
    }
  }

  const seconds = Math.max(0.25, Math.min(adaptive, endAt / 4, (incoming.durationSec - skipIntro) / 4));
  const details: string[] = [`Smart Fade · ${seconds.toFixed(1)}s${matchedBeats ? ` (${matchedBeats} beats)` : ""}`];
  if (tempo.matched && tempo.bpm) details.push(`${tempo.bpm} BPM`);
  if (vocalClash) details.push("vocal boundary protected");
  else if (harmonic.label) details.push(harmonic.label);
  else details.push(density > 0.65 ? "dense boundary, shorter overlap" : "audio-energy matched");
  if (outgoing.trailingSilenceSec > 0.1 || skipIntro > 0.1) details.push("silence trimmed");

  return { seconds, skipIntro, endAt, reason: details.join(" · ") };
}
