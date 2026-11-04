"use client";
import { useEffect, useState } from "react";
import { analysisSchema, type TrackAnalysis as Analysis } from "@mint/core/analysis";
import type { PlayerCommand, PlayerState } from "@/lib/player-protocol";

export function TrackAnalysis({ state, command }: { state: PlayerState; command: (command: PlayerCommand) => void }) {
  const id = state.track?.id;
  return id ? <AnalysisDetail key={id} id={id} state={state} command={command} /> : null;
}
function AnalysisDetail({ id, state, command }: { id: string; state: PlayerState; command: (command: PlayerCommand) => void }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [metadata, setMetadata] = useState<{ codec?: string; existingCodec?: string; year?: number; source?: string } | null>(null);
  const [status, setStatus] = useState("Loading track information…");
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      fetch(`/api/player/analysis/${id}`, { cache: "no-store", signal: abort.signal }),
      fetch(`/api/player/info/${id}`, { cache: "no-store", signal: abort.signal }),
    ]).then(async ([analysis, info]) => {
      if (!analysis.ok || !info.ok) throw new Error("Track information is unavailable. Reopen this panel to retry.");
      const [body, metadata] = await Promise.all([analysis.json(), info.json()]);
      if (abort.signal.aborted) return;
      setAnalysis(body.result ? analysisSchema.parse(body.result) : null); setMetadata(metadata.track);
      setStatus(body.result ? "" : `Mint analysis ${body.status ?? "not yet available"}. Ask the operator to check Analysis diagnostics.`);
    }).catch((error: unknown) => { if (!abort.signal.aborted) setStatus(error instanceof Error ? error.message : "Track information unavailable."); });
    return () => abort.abort();
  }, [id]);
  return <section aria-label="Track information" className="space-y-4 border-t border-line pt-5">
    <h3 className="font-semibold">Inside this recording</h3>
    {metadata && <p className="text-xs text-muted">{[metadata.codec ?? metadata.existingCodec, metadata.year, metadata.source].filter(Boolean).join(" · ")}</p>}
    {status && <p role="status" className="text-xs leading-relaxed text-muted">{status}</p>}
    {analysis && <>
      <div className="relative flex h-16 items-end gap-px rounded focus-within:ring-2 focus-within:ring-mint" aria-label="Measured audio waveform">
        {analysis.waveform.map((value, index) => <span aria-hidden key={index} className={`min-w-0 flex-1 rounded-t-sm ${index / analysis.waveform.length <= state.time / (analysis.durationSec * 1000) ? "bg-mint" : "bg-faint"}`} style={{ height: `${Math.max(4, value * 100)}%` }} />)}
        <input aria-label="Waveform seek" type="range" min="0" max={Math.round(analysis.durationSec * 1000)} value={Math.min(state.time, Math.round(analysis.durationSec * 1000))}
          onChange={(event) => command({ action: "seek", value: Number(event.target.value) })} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        <div><dt className="text-muted">Loudness</dt><dd className="mt-1">{analysis.integratedLufs?.toFixed(1) ?? "Unavailable"} LUFS</dd></div>
        <div><dt className="text-muted">True peak</dt><dd className="mt-1">{analysis.truePeakDbtp?.toFixed(1) ?? "Unavailable"} dBTP</dd></div>
        <div><dt className="text-muted">Tempo estimate</dt><dd className="mt-1">{analysis.tempo.bpm?.toFixed(0) ?? "Uncertain"} BPM · {Math.round(analysis.tempo.confidence * 100)}%</dd></div>
        <div><dt className="text-muted">Key estimate</dt><dd className="mt-1">{analysis.key.name ?? "Uncertain"} · {Math.round(analysis.key.confidence * 100)}%</dd></div>
      </dl>
      <p className="text-xs leading-relaxed text-muted">Measured by {analysis.algorithm}. Tempo and key are estimates, not DJ beat-grid guarantees. Analysis v{analysis.version} · {new Date(analysis.measuredAt).toLocaleDateString()}.</p>
    </>}
  </section>;
}
