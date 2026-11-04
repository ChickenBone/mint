"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Check, ChevronLeft, ChevronRight, ExternalLink, Loader2, Music2, Play, RefreshCw, X } from "lucide-react";
import { CHARTS, compatibleChartRecording, type ChartPage, type ChartRow } from "@/lib/charts";
import type { RequestRecording } from "@/lib/music-requests";
import { formatDuration } from "@/lib/format";
import { Artwork } from "@/components/artwork";
import { useRealtime } from "@/components/realtime";
import { TrackMenuButton, usePlayer } from "./player";

type RecordingResult = RequestRecording & { token: string; existing: { id: string; stage: string } | null };
type Acquisition = { status: "available" | "requested" } | { status: "resolve"; message: string; query: string; results: RecordingResult[] };
async function chartFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Charts could not load. Try again.");
  return body as T;
}
const action = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold ring-1 ring-line hover:bg-hover disabled:opacity-40";
const statusNames = { available: "In your library", missing: "Not in library", ambiguous: "Choose recording", requested: "Requested", processing: "Processing", failed: "Request failed" };

export function ChartBrowser({ initial, member }: { initial: ChartPage; member: boolean }) {
  const [page, setPage] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [requesting, setRequesting] = useState<string | null>(null);
  const [resolution, setResolution] = useState<{ row: ChartRow; results: RecordingResult[] } | null>(null);
  const generation = useRef(0), polling = useRef(false), pageRef = useRef(page);
  const loading = useRef(false), resolutionRef = useRef<HTMLElement>(null);
  const player = usePlayer();
  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => { if (resolution) { resolutionRef.current?.focus(); resolutionRef.current?.scrollIntoView({ block: "start", behavior: "instant" }); } }, [resolution]);
  const load = useCallback(async (id: string, offset = 0, quiet = false, revision?: string) => {
    const request = ++generation.current;
    loading.current = true;
    if (!quiet) { setBusy(true); setError(""); setNotice(""); setResolution(null); }
    try {
      const query = new URLSearchParams({ chart: id, offset: String(offset), limit: "25" });
      if (revision) query.set("revision", revision);
      const next = await chartFetch<ChartPage>(`/api/charts?${query}`);
      if (request === generation.current) { setPage(next); setError(""); }
    } catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : "The chart could not refresh."); }
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
  const acquire = async (row: ChartRow, token?: string, youtubeUrl?: string) => {
    setRequesting(row.id); setError(""); setNotice("");
    try {
      const result = await chartFetch<Acquisition>("/api/charts/request", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chart: page.chart.id, entry: row.id, token, ...(youtubeUrl ? { youtubeUrl } : {}) }) });
      if (result.status === "resolve") setResolution({ row, results: result.results });
      else {
        setResolution(null);
        setNotice(result.status === "available" ? "This song is already available in Mint." : "Requested. Progress will update here; no unavailable song was added to your queue.");
        await load(page.chart.id, page.offset, true);
      }
    } catch (error) { setError(error instanceof Error ? error.message : "The song could not be requested."); }
    finally { setRequesting(null); }
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
      if (!items.length) { setNotice("None of this chart is available locally yet. Add a song to your library first; nothing was downloaded or queued."); return; }
      if (await player?.command({ action: "items", items, shuffle: false })) {
        const skipped = rows.length - items.length;
        setNotice(`Playing ${items.length} local ${items.length === 1 ? "song" : "songs"} in chart order.${skipped ? ` Skipped ${skipped} missing or uncertain recordings. Nothing was downloaded.` : ""}`);
      }
    } catch (error) { setError(error instanceof Error ? error.message : "The chart could not play."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Music charts" aria-busy={busy} className="chart-browser">
    <div className="mb-5 grid gap-5 sm:grid-cols-2">
      <label className="text-sm font-semibold">Chart collection
        <select value={page.chart.id} disabled={busy || requesting !== null} onChange={(event) => void load(event.target.value)} className="mt-2 min-h-12 w-full rounded-xl bg-elevated px-4 text-fg ring-1 ring-line">
          {(["apple", "listenbrainz", "audius"] as const).map((provider) => <optgroup key={provider} label={CHARTS.find((chart) => chart.provider === provider)!.providerName}>
            {CHARTS.filter((chart) => chart.provider === provider).map((chart) => <option key={chart.id} value={chart.id}>{chart.title}</option>)}
          </optgroup>)}
        </select>
      </label>
      <div className="flex items-end gap-3">
        {member ? <button className={`${action} bg-mint text-mint-ink ring-0 hover:bg-mint-strong`} disabled={busy || !player?.ready || player.busy || !page.total} onClick={() => void play()}><Play className="size-4" fill="currentColor" />Play local songs</button>
          : <Link className={action} href="/login">Sign in to listen</Link>}
        <button className={action} disabled={busy} aria-label="Refresh chart availability" onClick={() => void load(page.chart.id, page.offset)}><RefreshCw className="size-4" /><span className="hidden sm:inline">Refresh</span></button>
      </div>
    </div>
    <header className="mb-5 border-b border-line pb-5">
      <div className="flex flex-wrap items-center gap-3"><h2 className="text-2xl font-bold">{page.chart.title}</h2>
        <a href={page.chart.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 text-sm text-muted underline underline-offset-4">{page.chart.providerName}<ExternalLink className="size-3" /></a>
        {page.status === "stale" && <span className="rounded-full bg-warn/10 px-3 py-1 text-sm text-warn">Stale ranking</span>}
      </div>
      <p className="mt-1 text-sm text-muted">{page.chart.territory} · {page.period ?? "Ranking period unavailable"}</p>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">{page.chart.description}</p>
      <p className="mt-3 text-xs leading-relaxed text-faint">
        Last checked: {page.fetchedAt ? new Date(page.fetchedAt).toUTCString() : "not yet refreshed"}.
        {" "}Provider update: {page.providerUpdatedAt ? new Date(page.providerUpdatedAt).toUTCString() : "not supplied"}.
      </p>
    </header>
    {page.notice && <p role="status" className="mb-5 text-sm leading-relaxed text-warn">{page.notice}{page.retryAt && ` Retry after ${new Date(page.retryAt).toUTCString()}.`}</p>}
    {error && <p role="alert" className="mb-5 text-sm text-danger">{error} <button className="min-h-11 underline" onClick={() => void load(page.chart.id)}>Reload chart</button></p>}
    <p role="status" className="text-sm text-mint">{notice}</p>
    {page.status === "error" && !page.total ? <div className="py-12"><h3 className="text-xl font-semibold">This chart couldn’t be reached.</h3><p className="mt-3 text-sm text-muted">Your library is unaffected. Retry shortly or choose another collection.</p></div>
      : !page.total ? <div className="py-12"><h3 className="text-xl font-semibold">No rankings published yet.</h3><p className="mt-3 text-sm text-muted">The provider returned an empty chart, not an error. Check another collection.</p></div>
      : <ol start={page.offset + 1} className="chart-rows mt-3">{page.items.map((row) => <li key={`${page.chart.id}:${row.id}`} className="chart-row group" data-availability={row.availability}>
        <span className="text-center text-sm text-faint tabular">{row.rank}</span>
        <div className={`relative ${row.availability !== "available" ? "grayscale" : ""}`}>
          <Artwork track={{ artworkUrl: row.item?.thumb ?? row.artwork ?? "" }} className="size-14 rounded-lg" />
          {row.availability === "available" && member && <button aria-label={`Play ${row.title}`} disabled={!player?.ready || player.busy} onClick={() => player?.command({ action: "play", item: row.item! })}
            className="absolute inset-0 grid place-items-center rounded-lg bg-bg/70 text-fg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40"><Play className="size-5" fill="currentColor" /></button>}
        </div>
        <div className="min-w-0">
          <p className="truncate font-semibold">{row.title}</p><p className="truncate text-sm text-muted">{row.artist}</p>
          <p className="mt-1 text-xs text-faint">{statusNames[row.availability]}{row.availability === "processing" && row.progress !== null ? ` · ${Math.round(row.progress)}%` : ""}</p>
          {row.availability === "processing" && <progress aria-label={`Acquisition progress for ${row.title}`} value={row.progress ?? 0} max={100} className="mt-2 h-1 w-full max-w-40 accent-mint" />}
        </div>
        <p className="hidden text-sm text-faint tabular md:block">{row.durationSec ? formatDuration(row.durationSec) : "—"}</p>
        <div className="chart-row-actions flex items-center justify-end gap-1">
          {row.availability === "available" ? member ? <><Check className="size-4 text-muted" aria-label="Available locally" /><TrackMenuButton item={row.item!} /></> : <span className="text-xs text-muted">Available</span>
            : ["requested", "processing"].includes(row.availability) ? <Link className="inline-flex min-h-11 items-center gap-2 text-xs text-muted" href={member ? "/app/jobs" : "/login"}><Loader2 className="size-4" />{statusNames[row.availability]}</Link>
            : member ? <button className={action} disabled={requesting !== null || busy} aria-label={`${row.availability === "failed" ? "Retry adding" : "Add to library:"} ${row.title} by ${row.artist}`} onClick={() => void acquire(row)}>
              <ArrowDownToLine className="size-4" /><span>{requesting === row.id ? "Checking…" : row.availability === "failed" ? "Retry" : "Add to library"}</span></button>
              : <Link className="inline-flex min-h-11 items-center text-xs text-muted underline" href="/request-access">Request access</Link>}
          <a href={row.url} target="_blank" rel="noreferrer" aria-label={`View ${row.title} on its source`} className="grid size-11 shrink-0 place-items-center text-faint hover:text-fg"><ExternalLink className="size-4" /></a>
        </div>
        {row.availability === "ambiguous" && <p className="chart-row-reason text-xs leading-relaxed text-muted">{row.reason}</p>}
      </li>)}</ol>}
    {resolution && <section ref={resolutionRef} tabIndex={-1} className="my-7 rounded-2xl bg-elevated p-5 sm:p-7" aria-label={`Resolve ${resolution.row.title}`}>
      <div className="flex items-start justify-between gap-3"><h3 className="text-xl font-bold">Choose the right recording.</h3><button aria-label="Close recording selection" className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-hover" onClick={() => setResolution(null)}><X className="size-5" /></button></div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">Nothing has been requested yet. Check the version and duration for {resolution.row.title} by {resolution.row.artist}. Live, remix and cover recordings are not interchangeable.</p>
      {!resolution.results.length && <p className="mt-5 text-sm text-warn">No recording was found. <Link className="underline" href={`/app/search?q=${encodeURIComponent(`${resolution.row.artist} ${resolution.row.title}`.slice(0, 100))}`}>Search the library and recording catalog</Link> with another spelling. Mint will not guess.</p>}
      <ol className="mt-5 divide-y divide-line">{resolution.results.map((recording) => <li key={recording.id} className="py-5">
        <h4 className="font-semibold">{recording.title}</h4><p className="mt-1 text-sm text-muted">{recording.artist} · {recording.album ?? "Album unknown"} · {recording.durationSec ? formatDuration(recording.durationSec) : "Duration unknown"}</p>
        <a className="inline-flex min-h-11 items-center gap-1 text-xs text-muted underline" href={`https://musicbrainz.org/recording/${recording.id}`} target="_blank" rel="noreferrer">MusicBrainz recording<ExternalLink className="size-3" /></a>
        {compatibleChartRecording(resolution.row, recording) ? <form className="mt-2 flex flex-wrap items-end gap-3" onSubmit={(event) => {
          event.preventDefault();
          void acquire(resolution.row, recording.token, String(new FormData(event.currentTarget).get("youtubeUrl") ?? "").trim());
        }}>
          <label className="min-w-0 flex-[1_1_16rem] text-xs text-muted">YouTube source URL (optional)
            <input name="youtubeUrl" type="url" maxLength={2048} placeholder="https://music.youtube.com/watch?v=…" className="mt-2 min-h-11 w-full rounded-lg bg-surface px-3 text-sm text-fg ring-1 ring-line" /></label>
          <button className={`${action} bg-mint text-mint-ink ring-0`} disabled={requesting !== null}>Request this recording</button>
        </form> : <p className="mt-2 text-sm text-warn">Different artist, version or duration. This recording cannot be requested for this chart entry.</p>}
      </li>)}</ol>
      <p className="mt-4 text-xs leading-relaxed text-faint">Requests use Mint’s existing sources and permissions. Without a source URL, Mint tries configured release sources, then a verified YouTube match. Acquisition may not be possible for every Audius upload.</p>
    </section>}
    {page.total > 25 && <nav aria-label="Chart pages" className="mt-6 flex items-center justify-between gap-3 border-t border-line pt-5">
      <p className="text-xs text-muted tabular">{page.offset + 1}–{Math.min(page.offset + 25, page.total)} of {page.total}</p><div className="flex gap-2">
        <button className={action} disabled={busy || page.offset === 0} onClick={() => void load(page.chart.id, Math.max(0, page.offset - 25), false, page.revision ?? undefined)}><ChevronLeft className="size-4" /><span className="sr-only sm:not-sr-only">Previous</span></button>
        <button className={action} disabled={busy || page.nextOffset === null} onClick={() => void load(page.chart.id, page.nextOffset!, false, page.revision ?? undefined)}><span className="sr-only sm:not-sr-only">Next</span><ChevronRight className="size-4" /></button>
      </div>
    </nav>}
    <p className="mt-7 flex items-start gap-2 text-xs leading-relaxed text-muted"><Music2 className="mt-0.5 size-4 shrink-0" />Playback only uses local files. Adding music always requires an explicit approved-member request. Rankings and song metadata do not grant rights to acquire audio.</p>
  </section>;
}
