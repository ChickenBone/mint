"use client";

import { DEFAULT_ANALYSIS_CONTROLS, type AnalysisControls } from "@mint/core/analysis";
import { useCallback, useEffect, useState } from "react";

interface Diagnostics {
  total: number; covered: number; statuses: Record<string, number>; controls: AnalysisControls; notes: string[];
  workers: { id: string; mode: string; online: boolean; error: string | null }[];
  recent: { trackId: string; title: string; artist: string; status: string; attempts: number; error: string | null }[];
}
const button = "min-h-11 rounded-lg border border-line px-4 py-2 text-sm font-semibold hover:bg-hover focus-visible:outline-2 focus-visible:outline-mint disabled:opacity-50";
const fields = [
  ["concurrency", "Concurrent files", 1, 4],
  ["intervalSec", "Seconds between new work", 5, 3600],
  ["maxDurationSec", "Longest track (seconds)", 10, 7200],
  ["timeoutSec", "Per-file time budget (seconds)", 10, 900],
  ["startHourUtc", "Schedule starts (UTC hour)", 0, 23],
  ["endHourUtc", "Schedule ends (UTC hour)", 0, 24],
] as const;

export function AnalysisPanel() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [controls, setControls] = useState<AnalysisControls>(DEFAULT_ANALYSIS_CONTROLS);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/player/analysis", { cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Analysis diagnostics could not load.");
      setData(body);
      setControls((old) => dirty ? old : body.controls);
      setError("");
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "Analysis diagnostics could not load.");
    }
  }, [dirty]);
  useEffect(() => {
    const controller = new AbortController();
    const initial = setTimeout(() => void load(controller.signal), 0);
    const timer = setInterval(() => void load(controller.signal), 10_000);
    return () => { controller.abort(); clearTimeout(initial); clearInterval(timer); };
  }, [load]);
  async function change(body: unknown, trackId?: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/player/analysis${trackId ? `/${trackId}` : ""}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Analysis change failed.");
      if (result.controls) { setControls(result.controls); setDirty(false); setNotice("Resource controls saved. Running work responds within two seconds."); }
      else if (result.cancelled !== undefined) setNotice(`${result.cancelled} jobs cancelled. Originals are unchanged.`);
      else setNotice(`${result.queued ?? 0} files queued${result.batchLimit ? ` (up to ${result.batchLimit} per request)` : ""}. Progress resumes from the persistent queue.`);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Analysis change failed."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-10">
    {error && <p role="alert" className="text-danger">{error} <button type="button" className="underline" onClick={() => void load()}>Try again</button></p>}
    <p role="status" aria-live="polite" className="text-sm text-mint">{notice}</p>
    {!data ? <p className="text-muted">Loading measured-audio coverage…</p> : <>
      <section aria-labelledby="analysis-coverage">
        <h2 id="analysis-coverage" className="text-xl font-bold">Measured audio</h2>
        <p className="mt-2 text-muted"><strong className="text-fg tabular">{data.covered} of {data.total}</strong> playable tracks analyzed.</p>
        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {["pending", "running", "complete", "failed", "cancelled"].map((status) => <div key={status} className="flex gap-2"><dt className="capitalize text-muted">{status}</dt><dd className="tabular">{data.statuses[status] ?? 0}</dd></div>)}
        </dl>
        <p className="mt-4 text-sm text-muted">{data.workers.some((worker) => worker.online) ? `${data.workers.filter((worker) => worker.online).length} analysis worker(s) connected.` : "No analysis worker has reported in the last minute. Check the NAS worker and database connection."}</p>
        {data.workers.map((worker) => worker.error && <p key={worker.id} className="mt-2 text-sm text-warn">{worker.mode} worker: {worker.error}</p>)}
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className={`${button} bg-mint text-mint-ink hover:bg-mint-strong`} disabled={busy} onClick={() => void change({ action: "backfill" })}>Analyze missing files</button>
          <button type="button" className={button} disabled={busy} onClick={() => void change({ action: "retry-failed" })}>Retry failed</button>
          <button type="button" className={button} disabled={busy} onClick={() => void change({ action: "refresh" })}>Refresh measurements</button>
          <button type="button" className={`${button} text-danger`} disabled={busy} onClick={() => { if (window.confirm("Cancel all pending and running audio analysis? Originals and completed measurements are kept.")) void change({ action: "cancel-all" }); }}>Cancel pending and running</button>
        </div>
      </section>
      <section aria-labelledby="analysis-resources">
        <h2 id="analysis-resources" className="text-xl font-bold">Schedule and resource limits</h2>
        <p className="mt-2 max-w-prose text-sm text-muted">Limits apply across NAS and optional remote workers. Start and end hours can cross midnight; equal hours run all day. Pausing keeps the queue and completed measurements.</p>
        <form className="mt-5 max-w-3xl" onSubmit={(event) => { event.preventDefault(); void change({ action: "settings", controls }); }}>
          <fieldset disabled={busy} className="space-y-5">
            <legend className="sr-only">Audio analysis controls</legend>
            <div className="flex flex-wrap gap-6">
              <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={controls.enabled} onChange={(event) => { setDirty(true); setControls({ ...controls, enabled: event.target.checked }); }} />Enable analysis</label>
              <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={controls.paused} onChange={(event) => { setDirty(true); setControls({ ...controls, paused: event.target.checked }); }} />Pause analysis</label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {fields.map(([key, label, min, max]) => <label key={key} className="flex flex-col gap-2 text-sm"><span>{label}</span><input type="number" min={min} max={max} step={1} required value={controls[key]} onChange={(event) => { setDirty(true); setControls({ ...controls, [key]: Number(event.target.value) }); }} className="min-h-11 rounded-lg border border-line bg-elevated px-3 py-2 tabular focus-visible:outline-2 focus-visible:outline-mint" /></label>)}
            </div>
            <button type="submit" className={`${button} bg-mint text-mint-ink hover:bg-mint-strong`} disabled={!dirty || busy}>{busy ? "Saving…" : "Save resource controls"}</button>
          </fieldset>
        </form>
      </section>
      <section aria-labelledby="analysis-recent">
        <h2 id="analysis-recent" className="text-xl font-bold">Recent analysis jobs</h2>
        {!data.recent.length ? <p className="mt-3 text-muted">No files analyzed yet. Add playable music, then analyze missing files.</p> : <ul className="mt-4 divide-y divide-line">
          {data.recent.map((track) => <li key={track.trackId} className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="min-w-0 flex-1"><p className="break-words font-semibold">{track.title}</p><p className="break-words text-sm text-muted">{track.artist} · {track.status} · {track.attempts} attempts</p>{track.error && <p className="mt-2 max-w-prose break-words text-sm text-warn">{track.error}</p>}</div>
            {["failed", "cancelled"].includes(track.status) && <button type="button" className={button} disabled={busy} aria-label={`Retry analysis for ${track.title}`} onClick={() => void change({ action: "retry" }, track.trackId)}>Retry</button>}
            {["pending", "running"].includes(track.status) && <button type="button" className={button} disabled={busy} aria-label={`Cancel analysis for ${track.title}`} onClick={() => void change({ action: "cancel" }, track.trackId)}>Cancel</button>}
          </li>)}
        </ul>}
      </section>
      <aside className="max-w-prose border-t border-line pt-5 text-sm text-muted"><h2 className="font-semibold text-fg">What Mint measures</h2><ul className="mt-3 list-disc space-y-2 pl-5">{data.notes.map((note) => <li key={note}>{note}</li>)}</ul></aside>
    </>}
  </div>;
}
