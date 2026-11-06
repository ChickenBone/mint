"use client";

import { DEFAULT_ANALYSIS_CONTROLS, type AnalysisControls } from "@mint/core/analysis";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatCount } from "@/lib/format";

interface WorkerRow {
  id: string;
  mode: string;
  online: boolean;
  error: string | null;
  completedCount?: number;
  failedCount?: number;
  avgDurationMs?: number | null;
  activeTrackId?: string | null;
  engineVersion?: string;
  capabilities?: string[];
  lastError?: string | null;
}

interface Diagnostics {
  version?: number;
  total: number;
  covered: number;
  v2Covered?: number;
  v1Covered?: number;
  statuses: Record<string, number>;
  controls: AnalysisControls;
  notes: string[];
  workers: WorkerRow[];
  recent: { trackId: string; title: string; artist: string; status: string; attempts: number; error: string | null; version?: number }[];
  backfill: { mode: "missing" | "upgrade-v1" | "all"; status: "queuing" | "queued" | "cancelled"; total: number; scanned: number; queued: number } | null;
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
  const [confirmAction, setConfirmAction] = useState<"reprocess-all" | "cancel-all" | null>(null);
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
      else if (result.backfill) setNotice("Full-library scan started. Queueing resumes across restarts; processing follows your saved resource controls.");
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
        <p className="mt-2 text-muted">
          <strong className="text-fg tabular">{formatCount(data.covered)} of {formatCount(data.total)}</strong> playable tracks analyzed
          {data.v2Covered !== undefined && <span className="ml-2 text-sm tabular">({formatCount(data.v2Covered)} v2 · {formatCount(data.v1Covered ?? 0)} legacy v1)</span>}.
        </p>
        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {["pending", "running", "complete", "failed", "cancelled"].map((status) => <div key={status} className="flex gap-2"><dt className="capitalize text-muted">{status}</dt><dd className="tabular">{formatCount(data.statuses[status] ?? 0)}</dd></div>)}
        </dl>
        <p className="mt-4 text-sm text-muted">{data.workers.some((worker) => worker.online && worker.mode !== "coordinator") ? `${data.workers.filter((worker) => worker.online && worker.mode !== "coordinator").length} analysis worker(s) connected.` : "No audio processor has reported in the last minute. In remote-only mode, connect a separate mint-analysis container over your private/VPN network."}</p>
        {data.workers.some((worker) => worker.online && worker.mode === "coordinator") && <p className="mt-2 text-sm text-muted">NAS coordinator connected. Audio processing is offloaded; the NAS still sends leased audio files.</p>}
        {(!data.controls.enabled || data.controls.paused) && <p className="mt-3 max-w-prose text-sm text-warn">{!data.controls.enabled ? "Analysis is disabled." : "Processing is paused."} You can build the queue now; enable and unpause analysis in resource controls below to start processing.</p>}
        {data.workers.map((worker) => (worker.error || worker.lastError) && <p key={worker.id} className="mt-2 text-sm text-warn">{worker.mode} worker ({worker.id.slice(0, 16)}): {worker.error ?? worker.lastError}</p>)}
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className={`${button} bg-mint text-mint-ink hover:bg-mint-strong`} disabled={busy || data.backfill?.status === "queuing"} onClick={() => void change({ action: "process-all" })}>Analyze all missing files</button>
          <button type="button" className={button} disabled={busy || data.backfill?.status === "queuing"} onClick={() => void change({ action: "upgrade-v1" })}>Upgrade v1 tracks to v2{data.v1Covered ? ` (${formatCount(data.v1Covered)})` : ""}</button>
          <button type="button" className={button} disabled={busy || data.backfill?.status === "queuing"} onClick={() => setConfirmAction("reprocess-all")}>Reprocess entire library</button>
          <button type="button" className={button} disabled={busy} onClick={() => void change({ action: "retry-failed" })}>Retry failed</button>
          <button type="button" className={`${button} text-danger`} disabled={busy} onClick={() => setConfirmAction("cancel-all")}>Cancel pending and running</button>
        </div>
        <ConfirmDialog
          open={confirmAction === "reprocess-all"}
          onClose={() => setConfirmAction(null)}
          title="Reprocess entire library?"
          description={`Reprocess the entire playable library (${formatCount(data.total)} tracks), including completed, failed and cancelled files? Active and already pending jobs are kept. Originals are unchanged; saved resource limits still apply.`}
          confirmLabel="Reprocess library"
          tone="primary"
          busy={busy}
          onConfirm={async () => {
            setConfirmAction(null);
            await change({ action: "reprocess-all" });
          }}
        />
        <ConfirmDialog
          open={confirmAction === "cancel-all"}
          onClose={() => setConfirmAction(null)}
          title="Cancel pending and running analysis?"
          description="Cancel all pending and running audio analysis? Originals and completed measurements are kept."
          confirmLabel="Cancel analysis"
          tone="danger"
          busy={busy}
          onConfirm={async () => {
            setConfirmAction(null);
            await change({ action: "cancel-all" });
          }}
        />
        {data.backfill && <div className="mt-5 max-w-prose space-y-2 text-sm" role="status" aria-live="polite">
          <p className="font-semibold">{data.backfill.status === "queuing" ? "Building the persistent queue" : data.backfill.status === "cancelled" ? "Library scan cancelled" : "Library scan finished"}</p>
          <p className="text-muted">{formatCount(data.backfill.scanned)} of {formatCount(data.backfill.total)} tracks checked; {formatCount(data.backfill.queued)} jobs added. {data.backfill.status === "queued" ? "Queueing is complete, not necessarily processing. Follow job totals above." : "Active and already pending jobs are not duplicated."}</p>
        </div>}
        <p className="mt-4 max-w-prose text-sm text-muted">Full-library scans add files in resumable batches of 500, with no total-library cap. Reprocessing also retries failed and cancelled files. Processing still respects enable, pause, UTC hours, duration and time budgets; no work is forced past these limits.</p>
      </section>
      <section aria-labelledby="analysis-execution-mode" className="rounded-xl border border-line bg-surface p-5">
        <h2 id="analysis-execution-mode" className="text-xl font-bold">Execution &amp; worker offloading</h2>
        <p className="mt-2 max-w-prose text-sm text-muted">Choose where audio decoding and DSP analysis run. Switching to remote-only offloads all CPU work from the NAS within two seconds without editing <code className="font-mono">.env</code> or recreating containers.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Execution mode">
          {([
            ["remote-only", "Offload all to external worker", "NAS acts strictly as coordinator; zero local audio decoding."],
            ["prefer-remote", "Prefer external worker", "External worker claims leases when online; NAS falls back if none connected."],
            ["hybrid", "Hybrid (NAS + external)", "Both local NAS and external workers process files up to global concurrency."],
          ] as const).map(([modeValue, title, summary]) => {
            const selected = (controls.executionMode ?? "hybrid") === modeValue;
            return <label key={modeValue} className={`flex min-h-11 cursor-pointer flex-col justify-between rounded-lg border p-3.5 text-sm transition-colors ${selected ? "border-mint bg-elevated" : "border-line hover:bg-hover"}`}>
              <span className="flex items-center gap-2.5 font-semibold">
                <input
                  type="radio"
                  name="executionMode"
                  value={modeValue}
                  checked={selected}
                  disabled={busy}
                  onChange={() => {
                    const updated = { ...controls, executionMode: modeValue };
                    setControls(updated);
                    void change({ action: "settings", controls: updated });
                  }}
                  className="size-4 accent-mint"
                />
                {title}
              </span>
              <span className="mt-2 block text-xs leading-relaxed text-muted">{summary}</span>
            </label>;
          })}
        </div>
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Connected workers &amp; throughput</h3>
          {!data.workers.length ? (
            <p className="mt-2 text-sm text-muted">No analysis workers have reported in the last 24 hours.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-elevated px-4">
              {data.workers.map((worker) => (
                <li key={worker.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      <span className={`mr-2 inline-block size-2 rounded-full ${worker.online ? "bg-mint" : "bg-faint"}`} aria-hidden />
                      {worker.id} <span className="ml-1 rounded bg-surface px-2 py-0.5 text-xs font-normal text-muted">{worker.mode}</span>
                      {worker.engineVersion && <span className="ml-2 text-xs text-muted">{worker.engineVersion}</span>}
                    </p>
                    <p className="mt-1 text-xs text-muted tabular">
                      {worker.online ? "Online" : "Offline"}
                      {" · "}{formatCount(worker.completedCount ?? 0)} completed
                      {" · "}{formatCount(worker.failedCount ?? 0)} failed
                      {worker.avgDurationMs ? ` · avg ${(worker.avgDurationMs / 1000).toFixed(1)}s/track` : ""}
                      {worker.activeTrackId ? ` · active track ${worker.activeTrackId.slice(0, 8)}…` : " · idle"}
                    </p>
                    {worker.lastError && <p className="mt-1 text-xs text-warn">Last error: {worker.lastError}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <section aria-labelledby="analysis-offload">
        <h2 id="analysis-offload" className="text-xl font-bold">Connect a powerful analysis machine</h2>
        <ol className="mt-4 max-w-prose list-decimal space-y-3 pl-5 text-sm text-muted">
          <li>On the NAS pipeline worker, set a separate random <code className="break-all font-mono">ANALYSIS_WORKER_TOKEN</code> of at least 32 characters, then select <strong>Offload all to external worker</strong> above (or set <code className="font-mono">ANALYSIS_REMOTE_ONLY=true</code> in <code className="font-mono">.env</code>).</li>
          <li>Use the repository&apos;s <code className="font-mono">docker-compose.analysis.yml</code> on the other machine. Set the same analysis token and <code className="break-all font-mono">ANALYSIS_SERVER_URL=http://NAS-VPN-IP:8080</code> in its .env. The address must reach the pipeline worker on your private network. Do not expose port 8080 publicly or use a volunteer token.</li>
          <li>For parallel processing, set <code className="font-mono">ANALYSIS_CONCURRENCY</code> from 1 to 4 on that machine and increase its CPU/memory allocation. Match “Concurrent files” below to the capacity you want across all machines. Run <code className="font-mono">docker compose pull &amp;&amp; docker compose up -d</code>, wait for a processor to connect, then choose a full-library action above.</li>
        </ol>
        <p className="mt-4 text-sm"><a className="inline-flex min-h-11 items-center underline hover:text-mint" href="https://github.com/ChickenBone/mint/blob/main/docker-compose.analysis.yml" target="_blank" rel="noreferrer">Analysis Compose template</a><span className="mx-3 text-faint" aria-hidden>·</span><a className="inline-flex min-h-11 items-center underline hover:text-mint" href="https://github.com/ChickenBone/mint/blob/main/docs/self-hosting.md#optional-separate-analysis-machine" target="_blank" rel="noreferrer">Private-network setup instructions</a></p>
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
