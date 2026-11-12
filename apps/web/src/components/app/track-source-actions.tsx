"use client";

import type { TrackView } from "@mint/core/events";
import { ExternalLink, Flag, ListChecks, Loader2 } from "lucide-react";
import { useState } from "react";
import { musicRequest } from "@/lib/music-client";
import { RetryButton } from "./retry-button";

type SourceState = {
  trackId: string; stage: string; videoId: string | null; canReportWrong: boolean;
  choices: Array<{ id: string; title: string; channel: string; durationSec: number | null; viewCount: number | null }>;
};
const clock = (seconds: number | null) => seconds === null ? "–:––"
  : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
const views = (count: number | null) => count === null ? null
  : `${new Intl.NumberFormat(undefined, { notation: "compact" }).format(count)} views`;
export const needsSource = (track: Pick<TrackView, "stage" | "detail">) => track.stage === "failed" && track.detail === "Needs a source";

/** Failed imports offer retry and, when the worker found close candidates, a member pick; YouTube imports can be reported as wrong audio. */
export function TrackSourceActions({ track }: { track: Pick<TrackView, "id" | "title" | "stage" | "detail" | "youtubeVideoId" | "source"> }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SourceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (task: () => Promise<SourceState>) => {
    setBusy(true); setError("");
    try { setState(await task()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The source could not be changed. Try again."); }
    finally { setBusy(false); }
  };
  const ready = track.stage === "ready" || track.stage === "analyzing";
  if (ready) {
    if (!track.youtubeVideoId || track.source === "lidarr") return null;
    return <span className="inline-flex items-center gap-1">
      <button type="button" disabled={busy} className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm text-muted hover:bg-hover hover:text-fg disabled:opacity-60"
        aria-label={`Report wrong audio for ${track.title}`} title="Wrong audio? Mint will find a different upload."
        onClick={() => { if (window.confirm(`Find different audio for “${track.title}”? The current upload won’t be used again.`)) void run(() => musicRequest(`sources/${track.id}`, "POST", { action: "wrong" })); }}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Flag className="size-4" aria-hidden />} Wrong audio
      </button>
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
    </span>;
  }
  if (track.stage !== "failed") return null;
  return <div className="flex flex-col items-end gap-1">
    <span className="inline-flex items-center gap-1">
      {needsSource(track) && <button type="button" aria-expanded={open} disabled={busy}
        className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm text-fg hover:bg-hover disabled:opacity-60"
        onClick={() => { const next = !open; setOpen(next); if (next && !state) void run(() => musicRequest(`sources/${track.id}`)); }}>
        <ListChecks className="size-4" aria-hidden /> Choose source
      </button>}
      <RetryButton trackId={track.id} />
    </span>
    {open && <div className="w-full max-w-md rounded-lg border border-line bg-elevated p-2 text-left">
      {!state ? (busy && <p role="status" className="p-2 text-sm text-muted">Loading sources…</p>)
        : state.stage !== "failed" ? <p role="status" className="p-2 text-sm text-muted">Importing with the source you chose…</p>
        : !state.choices.length ? <p className="p-2 text-sm text-muted">No reviewable uploads were found. Retry, or paste a YouTube link from Search.</p>
        : <ul aria-label={`Possible sources for ${track.title}`}>{state.choices.map((choice) => <li key={choice.id} className="flex items-center gap-2">
          <button type="button" disabled={busy} onClick={() => void run(() => musicRequest(`sources/${track.id}`, "POST", { action: "choose", videoId: choice.id }))}
            className="min-h-11 flex-1 rounded-md px-2 py-1 text-left hover:bg-hover disabled:opacity-60">
            <span className="block truncate text-sm text-fg">{choice.title}</span>
            <span className="block truncate text-xs text-muted">{[choice.channel, clock(choice.durationSec), views(choice.viewCount)].filter(Boolean).join(" · ")}</span>
          </button>
          <a href={`https://www.youtube.com/watch?v=${choice.id}`} target="_blank" rel="noreferrer" aria-label={`Preview ${choice.title} on YouTube`}
            className="grid size-11 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"><ExternalLink className="size-4" aria-hidden /></a>
        </li>)}</ul>}
      {error && <p role="alert" className="p-2 text-xs text-danger">{error}</p>}
    </div>}
  </div>;
}
