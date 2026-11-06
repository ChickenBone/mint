"use client";

import Link from "next/link";
import { useState } from "react";
import type { Stage } from "@mint/core/stages";
import type { TrackView } from "@mint/core/events";
import type { RequestRecording } from "@/lib/music-requests";
import { musicRequest } from "@/lib/music-client";
import { StageBadge } from "@/components/stage-badge";
import { useLiveTracks } from "@/components/realtime";

type Result = RequestRecording & {
  token: string;
  existing: { id: string; stage: Stage; error: string | null; detail: string | null } | null;
};

function requestable(item: Result) {
  return !item.existing || item.existing.stage === "failed";
}

export function MissingMusic({ query }: { query: string }) {
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [requested, setRequested] = useState<Record<string, string>>({});
  const [requestTracks, setRequestTracks] = useState<TrackView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [youtubeUrls, setYoutubeUrls] = useState<Record<string, string>>({});
  const { tracks: liveRequestTracks } = useLiveTracks(requestTracks, { keep: () => true, accept: () => true, limit: 10 });
  const canRequest = (item: Result) => requestable(item) && !requested[item.id];

  const submitRequest = async (item: Result, youtubeUrl = "") => {
    setBusy(item.id);
    setRowErrors((previous) => {
      const next = { ...previous };
      delete next[item.id];
      return next;
    });
    try {
      const result = await musicRequest<{ trackId: string; stage: Stage }>("search", "POST", {
        token: item.token,
        ...(youtubeUrl.trim() ? { youtubeUrl: youtubeUrl.trim() } : {}),
      });
      setRequested((previous) => ({ ...previous, [item.id]: result.trackId }));
      const placeholder: TrackView = {
        id: result.trackId, title: item.title, artist: item.artist, album: item.album,
        year: null, durationSec: item.durationSec, stage: result.stage, progress: 0,
        detail: "Requested from search", source: null, sonicAnalyzed: false,
        artworkUrl: "", youtubeVideoId: null, updatedAt: new Date().toISOString(),
      };
      setRequestTracks((previous) => [placeholder, ...previous.filter((track) => track.id !== placeholder.id)].slice(0, 10));
      setSelected((previous) => {
        const next = new Set(previous);
        next.delete(item.id);
        return next;
      });
    } catch (reason) {
      setRowErrors((previous) => ({
        ...previous,
        [item.id]: reason instanceof Error ? reason.message : "This recording could not be added.",
      }));
    } finally {
      setBusy(null);
    }
  };

  const addSelected = async () => {
    if (!results || busy) return;
    const chosen = results.filter((item) => selected.has(item.id) && canRequest(item));
    for (const item of chosen) await submitRequest(item, youtubeUrls[item.id] ?? "");
  };

  return (
    <section className="mt-10 border-t border-line pt-7" aria-label="Request missing music">
      <h2 className="text-xl font-bold">Not in the backlog yet?</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Search the recording catalog and choose the exact recording before requesting it. Mint uses its configured acquisition sources only after you choose Add to library.
        MusicBrainz receives this search text, not your library or account.
      </p>
      <button
        disabled={busy !== null || query.trim().length < 2}
        onClick={async () => {
          setBusy("search");
          setError("");
          try {
            const found = (await musicRequest<{ items: Result[] }>(`search?${new URLSearchParams({ q: query })}`)).items;
            setResults(found);
            setSelected(new Set());
            setRowErrors({});
            setRequested({});
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "The recording catalog could not load.");
          } finally {
            setBusy(null);
          }
        }}
        className="mt-4 min-h-11 rounded-full bg-elevated px-5 text-sm font-semibold hover:bg-hover disabled:opacity-40"
      >
        {busy === "search" ? "Searching recordings…" : `Find missing music for “${query}”`}
      </button>
      {results && !results.length && <p className="mt-4 text-sm text-muted">No recordings found. Try the title and artist without punctuation.</p>}
      {!!results?.some(canRequest) && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">Choose the exact recording. Selected requests will be added one by one.</p>
          <button type="button" disabled={busy !== null || !results.some((item) => selected.has(item.id) && canRequest(item))}
            onClick={() => void addSelected()}
            className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong disabled:opacity-40">
            {busy && busy !== "search" ? "Adding selected…" : `Add selected to library (${selected.size})`}
          </button>
        </div>
      )}
      {results && <ol className="mt-2 divide-y divide-line">{results.map((item) => {
        const available = item.existing?.stage === "ready" || item.existing?.stage === "analyzing";
        const live = liveRequestTracks.find((track) => track.id === requested[item.id]);
        const playable = live?.stage === "ready" || live?.stage === "analyzing" || available;
        const statusHref = playable ? `/app/library?q=${encodeURIComponent(`${item.artist} ${item.title}`)}` : "/app/collection?tab=requests";
        return (
          <li key={item.id} className="py-4">
            <div className="flex flex-wrap items-center gap-3">
              {canRequest(item) && (
                <label className="grid min-h-11 min-w-11 place-items-center" title={`Select ${item.title} by ${item.artist}`}>
                  <input type="checkbox" checked={selected.has(item.id)} disabled={busy !== null}
                    aria-label={`Select ${item.title} by ${item.artist}`}
                    onChange={(event) => setSelected((previous) => {
                      const next = new Set(previous);
                      if (event.target.checked) next.add(item.id); else next.delete(item.id);
                      return next;
                    })}
                    className="size-5 accent-mint" />
                </label>
              )}
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold">{item.title}</h3>
                <p className="text-sm text-muted">{item.artist}{item.album ? ` · ${item.album}` : ""}</p>
                {item.existing && <div className="mt-2"><StageBadge stage={item.existing.stage} /></div>}
                {item.existing?.stage === "failed" && (item.existing.error || item.existing.detail) && (
                  <p className="mt-2 max-w-prose text-sm text-warn">{item.existing.error || item.existing.detail}</p>
                )}
              </div>
              <a href={`https://musicbrainz.org/recording/${item.id}`} target="_blank" rel="noreferrer"
                className="inline-flex min-h-11 items-center py-2 text-xs text-muted hover:text-fg">Recording details</a>
            </div>
            {requested[item.id] ? (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <StageBadge stage={live?.stage ?? "queued"} progress={live?.progress} />
                {live?.stage === "failed" && (
                  <>
                    <p role="alert" className="max-w-prose text-sm text-warn">{live.detail || "The request failed. Retry it or choose another recording."}</p>
                    <button type="button" disabled={busy !== null} onClick={() => void submitRequest(item, youtubeUrls[item.id] ?? "")}
                      className="inline-flex min-h-11 items-center font-semibold text-mint underline">Retry</button>
                  </>
                )}
                {live?.stage !== "failed" && <Link href={statusHref} className="inline-flex min-h-11 items-center text-sm font-semibold text-mint">
                  {playable ? "Playable now · open library" : "Added to library · view progress"}
                </Link>}
              </div>
            ) : item.existing && !requestable(item) ? (
              <Link href={statusHref} className="mt-2 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-mint">
                <StageBadge stage={item.existing.stage} />
                {available ? "Already playable · open library" : "Already requested · view progress"}
              </Link>
            ) : (
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <label className="min-w-0 flex-[1_1_16rem] text-xs text-muted">YouTube video URL (optional)
                  <input type="url" maxLength={2048} value={youtubeUrls[item.id] ?? ""}
                    onChange={(event) => setYoutubeUrls((previous) => ({ ...previous, [item.id]: event.target.value }))}
                    placeholder="https://music.youtube.com/watch?v=…"
                    className="mt-2 min-h-11 w-full rounded-md bg-elevated px-3 text-sm text-fg ring-1 ring-line focus:ring-mint" />
                </label>
                <button type="button" disabled={busy !== null} onClick={() => void submitRequest(item, youtubeUrls[item.id] ?? "")}
                  className="min-h-11 rounded-full bg-mint px-5 text-sm font-bold text-mint-ink disabled:opacity-40">
                  {busy === item.id ? "Adding…" : item.existing?.stage === "failed" ? "Retry" : "Add to library"}
                </button>
                <p className="w-full text-xs leading-relaxed text-faint">
                  Without a video URL, Mint tries configured release sources, then your linked YouTube Music source. Source or quota failures remain visible in Requests.
                </p>
                {rowErrors[item.id] && <div className="w-full">
                  <p role="alert" className="text-sm text-warn">{rowErrors[item.id]}</p>
                  <button type="button" disabled={busy !== null} onClick={() => void submitRequest(item, youtubeUrls[item.id] ?? "")}
                    className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-mint underline">Retry this request</button>
                </div>}
              </div>
            )}
          </li>
        );
      })}</ol>}
      {error && <p role="alert" className="mt-4 text-sm text-warn">{error}</p>}
    </section>
  );
}
