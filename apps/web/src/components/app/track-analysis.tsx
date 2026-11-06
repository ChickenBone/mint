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
      {analysis.version === 2 && (analysis.classification.genres.length > 0 || analysis.classification.moods.length > 0) && (
        <div className="space-y-2">
          {analysis.classification.genres.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" aria-label="Detected genres">
              {analysis.classification.genres.map((genre) => (
                <span key={`${genre.name}-${genre.subgenre ?? ""}`} className="rounded-full border border-line bg-elevated px-2.5 py-0.5 text-xs font-semibold text-fg">
                  {genre.name}{genre.subgenre ? ` · ${genre.subgenre}` : ""}
                </span>
              ))}
              <span className="rounded-full bg-elevated px-2.5 py-0.5 text-xs text-muted capitalize">
                {analysis.classification.voiceInstrumental.label.replace("-", " ")}
              </span>
            </div>
          )}
          {analysis.classification.moods.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" aria-label="Detected moods">
              {analysis.classification.moods.map((mood) => (
                <span key={mood.name} className="rounded-full bg-surface px-2.5 py-0.5 text-xs capitalize text-muted">
                  {mood.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="relative flex h-16 items-end gap-px rounded focus-within:ring-2 focus-within:ring-mint" aria-label="Measured audio waveform">
        {analysis.waveform.map((value, index) => <span aria-hidden key={index} className={`min-w-0 flex-1 rounded-t-sm ${index / analysis.waveform.length <= state.time / (analysis.durationSec * 1000) ? "bg-mint" : "bg-faint"}`} style={{ height: `${Math.max(4, value * 100)}%` }} />)}
        {analysis.version === 2 && analysis.structure.introEndSec > 0.2 && analysis.durationSec > 0 && (
          <span
            aria-hidden
            title={`Intro ends at ${analysis.structure.introEndSec.toFixed(1)}s`}
            className="pointer-events-none absolute inset-y-0 w-px bg-mint/60"
            style={{ left: `${Math.min(98, Math.max(1, (analysis.structure.introEndSec / analysis.durationSec) * 100))}%` }}
          />
        )}
        {analysis.version === 2 && analysis.structure.outroStartSec < analysis.durationSec - 0.2 && analysis.durationSec > 0 && (
          <span
            aria-hidden
            title={`Outro starts at ${analysis.structure.outroStartSec.toFixed(1)}s`}
            className="pointer-events-none absolute inset-y-0 w-px bg-mint/60"
            style={{ left: `${Math.min(99, Math.max(2, (analysis.structure.outroStartSec / analysis.durationSec) * 100))}%` }}
          />
        )}
        <input aria-label="Waveform seek" type="range" min="0" max={Math.round(analysis.durationSec * 1000)} value={Math.min(state.time, Math.round(analysis.durationSec * 1000))}
          onChange={(event) => command({ action: "seek", value: Number(event.target.value) })} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs tabular">
        <div><dt className="text-muted">Loudness</dt><dd className="mt-1">{analysis.integratedLufs?.toFixed(1) ?? "Unavailable"} LUFS</dd></div>
        <div><dt className="text-muted">True peak</dt><dd className="mt-1">{analysis.truePeakDbtp?.toFixed(1) ?? "Unavailable"} dBTP</dd></div>
        {analysis.version === 2 && (
          <>
            <div><dt className="text-muted">Loudness range</dt><dd className="mt-1">{analysis.lraLu !== null ? `${analysis.lraLu.toFixed(1)} LU` : "Unavailable"}</dd></div>
            <div><dt className="text-muted">Crest factor</dt><dd className="mt-1">{analysis.crestFactorDb !== null ? `${analysis.crestFactorDb.toFixed(1)} dB` : "Unavailable"}</dd></div>
          </>
        )}
        <div>
          <dt className="text-muted">Tempo estimate</dt>
          <dd className="mt-1">
            {analysis.tempo.bpm?.toFixed(0) ?? "Uncertain"} BPM · {Math.round(analysis.tempo.confidence * 100)}%
            {analysis.version === 2 && analysis.tempo.bpm ? ` · ${Math.round(analysis.tempo.tempoStability * 100)}% steady` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Key estimate</dt>
          <dd className="mt-1">
            {analysis.key.name ?? "Uncertain"}
            {analysis.version === 2 && analysis.key.camelot ? ` · ${analysis.key.camelot}` : ""}
            {" · "}{Math.round(analysis.key.confidence * 100)}%
          </dd>
        </div>
        {analysis.version === 2 && (
          <>
            <div><dt className="text-muted">Danceability</dt><dd className="mt-1">{Math.round(analysis.classification.danceability * 100)}%</dd></div>
            <div><dt className="text-muted">Vocal presence</dt><dd className="mt-1 capitalize">{analysis.classification.voiceInstrumental.label.replace("-", " ")} · {Math.round(analysis.classification.voiceInstrumental.vocalPresence * 100)}%</dd></div>
          </>
        )}
      </dl>
      <p className="text-xs leading-relaxed text-muted">Measured by {analysis.algorithm}. Tempo, key, and sonic tags are acoustic estimates. Analysis v{analysis.version} · {new Date(analysis.measuredAt).toLocaleDateString()}.</p>
    </>}
  </section>;
}
