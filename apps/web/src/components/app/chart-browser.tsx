"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Check, ChevronLeft, ChevronRight, ExternalLink, Loader2, Play, RefreshCw, X } from "lucide-react";
import { CHARTS, chartRequestEffect, compatibleChartRecording, type ChartPage, type ChartRequestOutcome, type ChartRow } from "@/lib/charts";
import type { RequestRecording } from "@/lib/music-requests";
import { formatDuration } from "@/lib/format";
import { Artwork } from "@/components/artwork";
import { useRealtime } from "@/components/realtime";
import { ReportIssueButton } from "@/components/app/report-issue";
import { TrackMenuButton, usePlayer } from "./player";
import { ArtistLink } from "./music-links";
import { MusicItem } from "./music-item";

type RecordingResult = RequestRecording & { token: string; existing: { id: string; stage: string } | null };
type Acquisition = { status: "available" | "requested" } | { status: "resolve"; message: string; query: string; results: RecordingResult[] };
async function chartFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(url.startsWith("/api/charts/request") ? body.error ?? "Couldn’t add this song. Try again." : "Charts could not load. Try again.");
  return body as T;
}
const action = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold ring-1 ring-line hover:bg-hover disabled:opacity-40";
const statusNames = { requested: "Requested", processing: "Adding", ambiguous: "Pick a version", failed: "Couldn’t add" } as const;

type AcquireJob = { view: number; chart: string; row: ChartRow; token?: string; youtubeUrl?: string };
const requestGapMs = 1100;

export function ChartBrowser({ initial, member }: { initial: ChartPage; member: boolean }) {
  const [page, setPage] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [requesting, setRequesting] = useState<{ view: number; id: string } | null>(null), [view, setView] = useState(0), [waiting, setWaiting] = useState<AcquireJob[]>([]);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [resolution, setResolution] = useState<{ row: ChartRow; results: RecordingResult[] } | null>(null);
  const generation = useRef(0), polling = useRef(false), pageRef = useRef(page), lastRequest = useRef(0), viewRef = useRef(0);
  const loading = useRef(false), resolutionRef = useRef<HTMLDivElement>(null);
  const player = usePlayer();
  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => { if (resolution) { resolutionRef.current?.focus({ preventScroll: true }); resolutionRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" }); } }, [resolution]);
  const load = useCallback(async (id: string, offset = 0, quiet = false, revision?: string) => {
    const request = ++generation.current;
    loading.current = true;
    if (!quiet) { setView(++viewRef.current); setBusy(true); setError(""); setNotice(""); setResolution(null); setWaiting([]); setRowErrors({}); }
    try {
      const query = new URLSearchParams({ chart: id, offset: String(offset), limit: "25" });
      if (revision) query.set("revision", revision);
      const next = await chartFetch<ChartPage>(`/api/charts?${query}`);
      if (request === generation.current) { setPage(next); setError(""); }
    } catch (error) { if (request === generation.current) setError("Couldn’t load this chart."); }
    finally { if (request === generation.current) { setBusy(false); loading.current = false; } }
  }, []);
  const refresh = useCallback(() => {
    if (polling.current || loading.current || document.visibilityState !== "visible") return;
    polling.current = true;
    const current = pageRef.current;
    void load(current.chart.id, current.offset, true).finally(() => { polling.current = false; });
  }, [load]);
  useEffect(() => {
    const counter = generation;
    const timer = setInterval(refresh, 15000);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); counter.current++; };
  }, [refresh]);
  useRealtime((event) => { if (event.type === "track") refresh(); });
  // Responses are scoped to the chart page view that sent them, so paging or reloading cannot reopen stale choosers or row states.
  const acquire = useCallback(async ({ view, chart, row, token, youtubeUrl }: AcquireJob) => {
    if (view !== viewRef.current) return;
    setRequesting({ view, id: row.id }); lastRequest.current = Date.now();
    if (view === viewRef.current) { setError(""); setNotice(""); }
    let outcome: ChartRequestOutcome, results: RecordingResult[] = [];
    try {
      const result = await chartFetch<Acquisition>("/api/charts/request", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chart, entry: row.id, token, ...(youtubeUrl ? { youtubeUrl } : {}) }) });
      outcome = result;
      if (result.status === "resolve") results = result.results;
    } catch (error) { outcome = { status: "error", message: error instanceof Error ? error.message : "The song could not be requested." }; }
    const effect = chartRequestEffect(view === viewRef.current, row.title, outcome);
    if (effect.resolve) setResolution({ row, results });
    else if (outcome.status !== "error" && view === viewRef.current) setResolution((open) => open?.row.id === row.id ? null : open);
    if (effect.rowError) setRowErrors((errors) => ({ ...errors, [row.id]: effect.rowError! }));
    if (effect.markRequested) setPage((current) => ({ ...current, items: current.items.map((item) => item.id !== row.id ? item
      : { ...item, availability: "requested" as const, progress: null, reason: "Requested. Waiting for acquisition." }) }));
    if (effect.notice) setNotice(effect.notice);
    if (effect.error) setError(effect.error);
    setRequesting(null); lastRequest.current = Date.now();
    if (effect.refresh) await load(chart, pageRef.current.offset, true);
  }, [load]);
  // Each click is an explicit request; clicks are sent one at a time to respect the shared recording-catalog limit.
  useEffect(() => {
    if (requesting || !waiting.length) return;
    const timer = setTimeout(() => { const [job] = waiting; setWaiting((jobs) => jobs.slice(1)); void acquire(job!); },
      Math.max(0, lastRequest.current + requestGapMs - Date.now()));
    return () => clearTimeout(timer);
  }, [requesting, waiting, acquire]);
  const request = (job: Omit<AcquireJob, "chart" | "view">) => {
    if (requesting?.view === view && requesting.id === job.row.id || waiting.some((queued) => queued.row.id === job.row.id)) return;
    setRowErrors((errors) => Object.fromEntries(Object.entries(errors).filter(([id]) => id !== job.row.id)));
    if (job.token) setResolution(null);
    setWaiting((jobs) => [...jobs, { ...job, view: viewRef.current, chart: pageRef.current.chart.id }].slice(0, 25));
  };
  const play = async () => {
    setBusy(true); setError("");
    try {
      const query = new URLSearchParams({ chart: page.chart.id, limit: "25" });
      const first = await chartFetch<ChartPage>(`/api/charts?${query}`);
      const second = first.nextOffset !== null ? await chartFetch<ChartPage>(`/api/charts?${new URLSearchParams({
        chart: first.chart.id, limit: "25", offset: String(first.nextOffset), revision: first.revision!,
      })}`) : null;
      const rows = [...first.items, ...(second?.items ?? [])];
      const items = rows.flatMap((row) => row.availability === "available" && row.item ? [row.item] : []);
      if (!items.length) { setNotice("Nothing here is in your library yet. Add a song to play it."); return; }
      if (await player?.command({ action: "items", items, shuffle: false })) {
        const skipped = rows.length - items.length;
        setNotice(`Playing ${items.length} ${items.length === 1 ? "song" : "songs"}${skipped ? `; ${skipped} not in your library yet` : ""}.`);
      }
    } catch (error) { setError("Couldn’t start playback. Try again."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Music charts" aria-busy={busy} className="chart-browser">
    <header className="mb-5 grid gap-4 border-b border-line pb-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-bold tracking-tight sm:text-3xl">{page.chart.title}</h1>
        <p className="mt-1 text-xs text-faint">
          {page.chart.territory}{page.period ? ` · ${page.period}` : ""}
          {" · "}<a href={page.chart.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 underline underline-offset-4 hover:text-fg">{page.chart.providerName}<ExternalLink className="size-3" aria-hidden /></a>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
        <label className="sr-only" htmlFor="chart-select">Choose a chart</label>
        <select id="chart-select" value={page.chart.id} disabled={busy} onChange={(event) => void load(event.target.value)} className="min-h-11 max-w-full rounded-xl bg-elevated px-3 text-sm text-fg ring-1 ring-line">
          {(["apple", "listenbrainz", "audius"] as const).map((provider) => <optgroup key={provider} label={CHARTS.find((chart) => chart.provider === provider)!.providerName}>
            {CHARTS.filter((chart) => chart.provider === provider).map((chart) => <option key={chart.id} value={chart.id}>{chart.title}</option>)}
          </optgroup>)}
        </select>
        {member ? <button className={`${action} bg-mint text-mint-ink ring-0 hover:bg-mint-strong`} disabled={busy || !player?.ready || player.busy || !page.total} onClick={() => void play()}><Play className="size-4" fill="currentColor" />Play</button>
          : <Link className={action} href="/login">Sign in to listen</Link>}
        <button className="grid size-11 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg disabled:opacity-40" disabled={busy} aria-label="Refresh chart" onClick={() => void load(page.chart.id, page.offset)}><RefreshCw className="size-4" /></button>
      </div>
    </header>
    {page.total > 0 && page.status === "error" && <p role="status" className="mb-5 text-sm text-muted">Couldn’t refresh this chart. <button className="min-h-11 underline" onClick={() => void load(page.chart.id)}>Try again</button></p>}
    {page.total > 0 && page.status === "stale" && <p role="status" className="mb-5 text-sm text-muted">This chart may be out of date. <button className="min-h-11 underline" onClick={() => void load(page.chart.id)}>Refresh</button></p>}
    {error && <p role="alert" className="mb-5 text-sm text-danger">{error} <button className="min-h-11 underline" onClick={() => void load(page.chart.id)}>Reload chart</button></p>}
    <p role="status" className="text-sm text-mint">{notice}</p>
    {page.status === "error" && !page.total ? <div className="py-12"><h3 className="text-xl font-semibold">This chart isn’t available right now.</h3><button className={`${action} mt-4`} onClick={() => void load(page.chart.id)}><RefreshCw className="size-4" />Try again</button></div>
      : !page.total ? <div className="py-12"><h3 className="text-xl font-semibold">Nothing on this chart yet.</h3><p className="mt-3 text-sm text-muted">Try another chart.</p></div>
      : <ol start={page.offset + 1} className="chart-rows mt-3">{page.items.map((row) => <MusicItem as="li" item={member && row.availability === "available" ? row.item : null} key={`${page.chart.id}:${row.id}`} className="chart-row group" data-availability={row.availability}>
        <span className="text-center text-sm text-faint tabular">{row.rank}</span>
        <div className={`relative ${row.availability !== "available" ? "grayscale" : ""}`}>
          <Artwork track={{ artworkUrl: row.item?.thumb ?? row.artwork ?? "" }} className="size-14 rounded-lg" />
          {row.availability === "available" && member && <button aria-label={`Play ${row.title}`} disabled={!player?.ready || player.busy} onClick={() => player?.command({ action: "play", item: row.item! })}
            className="absolute inset-0 grid place-items-center rounded-lg bg-bg/70 text-fg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40"><Play className="size-5" fill="currentColor" /></button>}
        </div>
        <div className="min-w-0">
          <p className="truncate font-semibold">{row.title}</p><p className="truncate text-sm text-muted">{member && row.item ? <ArtistLink item={row.item} /> : row.artist}</p>
          {row.availability !== "available" && row.availability !== "missing" && <p className="mt-1 text-xs text-faint">{statusNames[row.availability]}{row.availability === "processing" && row.progress !== null ? ` · ${Math.round(row.progress)}%` : ""}</p>}
          {row.availability === "processing" && <progress aria-label={`Progress for ${row.title}`} value={row.progress ?? 0} max={100} className="mt-2 h-1 w-full max-w-40 accent-mint" />}
        </div>
        <p className="hidden text-sm text-faint tabular md:block">{row.durationSec ? formatDuration(row.durationSec) : "—"}</p>
        <div className="chart-row-actions flex items-center justify-end gap-1">
          {row.availability === "available" ? member ? <><Check className="size-4 text-muted" aria-label="In your library" /><TrackMenuButton item={row.item!} /></> : <span className="text-xs text-muted">In library</span>
            : ["requested", "processing"].includes(row.availability) ? <span className="inline-flex min-h-11 items-center gap-2 text-xs text-muted" role="status"><Loader2 className="size-4" />{statusNames[row.availability as "requested" | "processing"]}</span>
            : member ? <AddButton row={row} busy={busy} state={requesting?.view === view && requesting.id === row.id ? "checking" : waiting.some((job) => job.row.id === row.id) ? "waiting" : rowErrors[row.id] ? "error" : "idle"}
              open={resolution?.row.id === row.id} onClick={() => request({ row })} />
              : <Link className="inline-flex min-h-11 items-center text-xs text-muted underline" href="/request-access">Request access</Link>}
        </div>
        {member && rowErrors[row.id] ? <div className="chart-row-reason flex flex-wrap items-center gap-x-3 text-xs leading-relaxed text-danger" role="alert">
          <span>Couldn’t add this song.</span>
          <ReportIssueButton className="min-h-11 rounded-control px-2 text-xs text-muted hover:bg-hover hover:text-fg"
            context={`${row.title} — ${row.artist}`} icon={false} />
        </div> : row.availability === "ambiguous" && <p className="chart-row-reason text-xs leading-relaxed text-muted">Choose the version to add.</p>}
        {member && resolution?.row.id === row.id && <div ref={resolutionRef} tabIndex={-1} role="group" aria-label={`Choose the recording for ${row.title}`}
          onKeyDown={(event) => { if (event.key === "Escape") setResolution(null); }} style={{ gridColumn: "1 / -1" }} className="mt-1 rounded-2xl bg-elevated p-4 sm:p-5">
          <ChartResolution row={row} results={resolution.results} disabled={requesting !== null || waiting.length > 0}
            onClose={() => setResolution(null)} onRequest={(token, youtubeUrl) => request({ row, token, youtubeUrl })} />
        </div>}
      </MusicItem>)}</ol>}
    {page.total > 25 && <nav aria-label="Chart pages" className="mt-6 flex items-center justify-between gap-3 border-t border-line pt-5">
      <p className="text-xs text-muted tabular">{page.offset + 1}–{Math.min(page.offset + 25, page.total)} of {page.total}</p><div className="flex gap-2">
        <button className={action} disabled={busy || page.offset === 0} onClick={() => void load(page.chart.id, Math.max(0, page.offset - 25), false, page.revision ?? undefined)}><ChevronLeft className="size-4" /><span className="sr-only sm:not-sr-only">Previous</span></button>
        <button className={action} disabled={busy || page.nextOffset === null} onClick={() => void load(page.chart.id, page.nextOffset!, false, page.revision ?? undefined)}><span className="sr-only sm:not-sr-only">Next</span><ChevronRight className="size-4" /></button>
      </div>
    </nav>}
  </section>;
}

function AddButton({ row, busy, state, open, onClick }: { row: ChartRow; busy: boolean; state: "idle" | "waiting" | "checking" | "error"; open: boolean; onClick: () => void }) {
  const label = state === "checking" ? "Checking…" : state === "waiting" ? "Waiting…" : state === "error" ? "Try again"
    : row.availability === "failed" ? "Retry" : row.availability === "ambiguous" || open ? "Choose version" : "Add to library";
  return <button className={`${action} ${state === "idle" && row.availability === "missing" && !open ? "bg-mint/10 text-fg ring-mint/40" : ""}`}
    disabled={busy || state === "waiting" || state === "checking"} aria-busy={state === "checking"}
    aria-label={`${row.availability === "failed" || state === "error" ? "Retry adding" : "Add to library:"} ${row.title} by ${row.artist}`} onClick={onClick}>
    {state === "checking" || state === "waiting" ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : state === "error" || row.availability === "failed" ? <RefreshCw className="size-4" /> : <ArrowDownToLine className="size-4" />}
    <span>{label}</span>
  </button>;
}

function ChartResolution({ row, results, disabled, onClose, onRequest }: {
  row: ChartRow; results: RecordingResult[]; disabled: boolean; onClose: () => void; onRequest: (token: string, youtubeUrl: string) => void;
}) {
  const compatible = results.filter((recording) => compatibleChartRecording(row, recording));
  return <>
    <div className="flex items-start justify-between gap-3"><div>
      <h3 className="font-bold">Choose a version</h3>
    </div><button aria-label="Close recording selection" className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-hover" onClick={onClose}><X className="size-5" /></button></div>
    {!compatible.length ? <p className="mt-3 text-sm text-muted">No matches. <Link className="underline underline-offset-4" href={`/app/search?q=${encodeURIComponent(`${row.artist} ${row.title}`.slice(0, 100))}`} onClick={onClose}>Try another spelling in Search</Link>.</p>
      : <ol className="mt-2 divide-y divide-line">{compatible.map((recording) => <li key={recording.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <h4 className="truncate font-semibold">{recording.title}</h4>
          <p className="truncate text-sm text-muted">{recording.artist}
            {recording.album ? ` · ${recording.album}` : ""}
            {recording.durationSec ? ` · ${formatDuration(recording.durationSec)}` : ""}</p>
        </div>
        <button type="button" className={action} disabled={disabled} onClick={() => onRequest(recording.token, "")}>
          <ArrowDownToLine className="size-4" />Add to library
        </button>
      </li>)}</ol>}
  </>;
}
