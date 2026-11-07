import { useEffect, useState } from "react";
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, Text, View } from "react-native";
import type { TrackAnalysisResult } from "@mint/client";
import { useApi } from "../../api";
import { usePlayer } from "../../playback/PlayerProvider";
import { TrackAnalysisRequest, type AnalysisState } from "../../playback/analysis-request";
import { Button } from "../../components/ui/primitives";
import { colors } from "../../theme/tokens";

const value = (number: number | null | undefined, unit = "") =>
  number === null || number === undefined ? "Not measured" : `${number.toFixed(2)}${unit}`;

function Graph({ title, values, unit = "", min = 0, max }: {
  title: string; values: (number | null)[]; unit?: string; min?: number; max?: number;
}) {
  const measured = values.filter((item): item is number => item !== null && Number.isFinite(item));
  const upper = max ?? Math.max(min + 1, ...measured);
  const current = values.at(-1);
  return <View style={s.graph} accessible accessibilityLabel={`${title}. Latest ${value(current, unit)}. Scale ${min.toFixed(1)} to ${upper.toFixed(1)}${unit}. ${measured.length} measured samples.`}>
    <Text style={s.label}>{title}</Text>
    <Text style={s.secondary}>{value(current, unit)} · scale {min.toFixed(1)}–{upper.toFixed(1)}{unit}</Text>
    {measured.length ? <View style={s.plot} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {values.map((item, index) => <View key={index} style={[s.bar, {
        height: item === null ? 0 : Math.max(1, Math.min(1, Math.max(0, (item - min) / (upper - min))) * 48),
        opacity: item === null ? 0 : .85,
      }]} />)}
    </View> : <Text style={s.secondary}>Waiting for measured samples</Text>}
  </View>;
}

function AnalysisGraphs({ result }: { result: TrackAnalysisResult }) {
  // Each bin is the maximum of existing measured envelope samples, not invented PCM.
  const envelope: number[] = [];
  const step = Math.ceil(result.waveform.length / 64);
  for (let index = 0; index < result.waveform.length; index += step) envelope.push(Math.max(...result.waveform.slice(index, index + step)));
  return <View style={s.group}>
    <Text style={s.label}>Measured on server · {result.algorithm}</Text>
    <Text style={s.secondary}>{result.measuredAt} · analyzed duration {value(result.durationSec, " s")}</Text>
    <Graph title="Track amplitude envelope · start → end" values={envelope} max={1} />
    <Text style={s.secondary}>Offline analysis summary, not a live waveform or equalizer.</Text>
    <Graph title="Integrated loudness" values={[result.integratedLufs]} min={-120} max={20} unit=" LUFS" />
    <Graph title="True peak" values={[result.truePeakDbtp]} min={-150} max={30} unit=" dBTP" />
    <Text style={s.secondary}>Integrated loudness {value(result.integratedLufs, " LUFS")} · true peak {value(result.truePeakDbtp, " dBTP")}</Text>
    <Text style={s.secondary}>RMS {value(result.energy.rms)} · peak {value(result.energy.peak)} · dynamic range {value(result.energy.dynamicRangeDb, " dB")}</Text>
    <Text style={s.secondary}>Loudness range {value(result.lraLu, " LU")} · crest factor {value(result.crestFactorDb, " dB")}</Text>
    <Text style={s.secondary}>Tempo {value(result.tempo.bpm, " BPM")} · confidence {value(result.tempo.confidence * 100, "%")}</Text>
    <Text style={s.secondary}>Key {result.key.name ?? "Not measured"} · confidence {value(result.key.confidence * 100, "%")}</Text>
    <Text style={s.secondary}>Leading silence {value(result.leadingSilenceSec, " s")} · trailing silence {value(result.trailingSilenceSec, " s")}</Text>
    <Graph title="Tempo / key confidence · in that order" values={[result.tempo.confidence, result.key.confidence]} max={1} />
    <Graph title="Spectral centroid / rolloff · in that order" values={[result.energy.spectralCentroidHz ?? null, result.energy.spectralRolloffHz ?? null]} unit=" Hz" />
    <Text style={s.secondary}>Spectral centroid {value(result.energy.spectralCentroidHz, " Hz")} · rolloff {value(result.energy.spectralRolloffHz, " Hz")}</Text>
    <Text style={s.secondary}>Spectral flux {value(result.energy.spectralFlux)} · flatness {value(result.energy.spectralFlatness)} · zero-crossing rate {value(result.energy.zeroCrossingRate)}</Text>
    {result.structure ? <>
      <Graph title="Measured fade-in contour · start → end" values={result.structure.fadeInContourDb} min={-96} max={6} unit=" dB" />
      <Graph title="Measured fade-out contour · start → end" values={result.structure.fadeOutContourDb} min={-96} max={6} unit=" dB" />
      <Text style={s.secondary}>Intro end {value(result.structure.introEndSec, " s")} · outro start {value(result.structure.outroStartSec, " s")} · first peak {value(result.structure.firstPeakSec, " s")}</Text>
    </> : null}
    {result.classification ? <>
      <Graph title="Valence / arousal / danceability estimates" values={[result.classification.valence, result.classification.arousal, result.classification.danceability]} max={1} />
      <Text style={s.secondary}>Valence {value(result.classification.valence)} · arousal {value(result.classification.arousal)} · danceability {value(result.classification.danceability)}</Text>
      <Text style={s.secondary}>{[...result.classification.genres, ...result.classification.moods].map((item) => `${item.name} (${Math.round(item.confidence * 100)}%)`).join(" · ") || "No classification available"}</Text>
    </> : null}
  </View>;
}

function EnabledStats() {
  const { diagnostics, state } = usePlayer();
  const api = useApi();
  const id = state.track?.id;
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!api || !id) return;
    const request = new TrackAnalysisRequest(setAnalysis);
    request.load((signal) => api.trackAnalysis(id, signal));
    return () => request.cancel();
  }, [api, id, retry]);
  const samples = diagnostics.samples;
  return <LinearGradient colors={[colors.elevated, colors.surface]} style={s.panel}>
    <Text accessibilityRole="header" style={s.heading}>Stats for nerds</Text>
    <Text style={s.secondary}>Device-local trace · up to 60 samples at 1 Hz, oldest → newest. No uploads. Status cadence is not frame rate.</Text>
    <Text style={s.secondary}>Source: {diagnostics.source ?? "Not measured for this loaded source"} · load wait {value(diagnostics.loadLatencyMs, " ms")}</Text>
    <Text style={s.secondary}>Buffering transitions: {diagnostics.bufferingTransitions} (observed, not a stall diagnosis)</Text>
    <Graph title="Playback position" values={samples.map((item) => item.positionSec)} unit=" s" />
    <Text style={s.secondary}>Native reported duration {value(samples.at(-1)?.durationSec, " s")}</Text>
    <Graph title="Buffering · 1 = buffering" values={samples.map((item) => Number(item.buffering))} max={1} />
    <Graph title="Loading · 1 = waiting" values={samples.map((item) => Number(item.loading))} max={1} />
    <Graph title="Native loaded · 1 = loaded" values={samples.map((item) => Number(item.loaded))} max={1} />
    <Graph title="Playing · 1 = playing" values={samples.map((item) => Number(item.playing))} max={1} />
    <Graph title="Queue preparing · 1 = preparing" values={samples.map((item) => Number(item.queuePreparing))} max={1} />
    <Graph title="Hydrated queue entries" values={samples.map((item) => item.queueLoaded)} />
    <Graph title="Queue total" values={samples.map((item) => item.queueTotal)} />
    <Graph title="Native source count" values={samples.map((item) => item.nativeTrackCount)} />
    <Graph title="JS-observed native status interval" values={samples.map((item) => item.statusIntervalMs)} unit=" ms" />
    <Graph title="Queue API response latency · recent requests" values={diagnostics.events.filter((item) => item.kind !== "native error").map((item) => item.latencyMs)} unit=" ms" />
    {diagnostics.events.map((event, index) => <Text key={index} style={s.secondary}>
      {event.elapsedSec.toFixed(1)} s · {event.kind} · {event.latencyMs === null ? "" : `${Math.round(event.latencyMs)} ms · `}
      HTTP {event.httpStatus === null ? "not exposed" : event.httpStatus === 0 ? "no response (network)" : event.httpStatus}
      {event.kind === "native error" ? ` · native code ${event.nativeCode ?? "not exposed"}` : ""}
    </Text>)}
    <Text style={s.secondary}>Buffer depth, network throughput, decoder codec, live bitrate, UI/JS FPS and live DSP are not measured by this player.</Text>
    <Text accessibilityRole="header" style={s.heading}>Track analysis</Text>
    {!id ? <Text style={s.secondary}>Choose a song to inspect existing analysis.</Text> :
      analysis.status === "loading" ? <Text style={s.secondary}>Loading existing measured analysis…</Text> :
      analysis.status === "error" ? <><Text style={s.secondary}>Analysis unavailable. Playback is unchanged.</Text><Button quiet label="Retry analysis" onPress={() => setRetry((current) => current + 1)} /></> :
      <><Text style={s.secondary}>Status: {analysis.data.status}{analysis.data.upgrading ? " · displaying previous measurements while upgrading" : ""}</Text>
        {analysis.data.result ? <AnalysisGraphs result={analysis.data.result} /> : <Text style={s.secondary}>No completed measurements are available. This view does not schedule analysis.</Text>}
        <Button quiet label="Refresh analysis" onPress={() => setRetry((current) => current + 1)} /></>}
  </LinearGradient>;
}

export function StatsForNerds() {
  const { diagnosticsEnabled, state } = usePlayer();
  return diagnosticsEnabled ? <EnabledStats key={state.track?.id ?? "empty"} /> : null;
}

const s = StyleSheet.create({
  panel: { borderRadius: 18, padding: 20, gap: 14, marginTop: 24 },
  heading: { color: colors.text, fontSize: 20, fontWeight: "700" },
  label: { color: colors.text, fontSize: 14, fontWeight: "600" },
  secondary: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  group: { gap: 12 }, graph: { gap: 4 },
  plot: { height: 48, flexDirection: "row", alignItems: "flex-end", gap: 1 },
  bar: { flex: 1, backgroundColor: colors.action },
});
