"use client";
import { useState } from "react";

type Match = { id: number; trackName: string; artistName: string; albumName: string; duration: number; instrumental: boolean };
export function LyricsMatch({ id, title, offset, refresh }: { id: string; title: string; offset: number; refresh: () => void }) {
  const [query, setQuery] = useState(title), [results, setResults] = useState<Match[] | null>(null);
  const [shift, setShift] = useState(offset / 1000), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const perform = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (error) { setError(error instanceof Error ? error.message : "The lyrics correction failed."); }
    finally { setBusy(false); }
  };
  const save = async (lyricsId?: number, reset = false) => perform(async () => {
    const response = await fetch(`/api/player/lyrics/${id}/matches`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ lyricsId, offsetMs: Math.round(shift * 1000), reset }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "The lyrics correction could not save.");
    setResults(null); refresh();
  });
  return <details className="my-5 border-y border-line py-3">
    <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">Wrong lyrics or timing?</summary>
    <p className="mt-2 text-xs leading-relaxed text-muted">Search LRCLIB for a better match. Your correction and timing offset apply only to your Mint account.</p>
    <form className="my-4 flex flex-wrap gap-2" onSubmit={(event) => {
      event.preventDefault();
      void perform(async () => {
        const response = await fetch(`/api/player/lyrics/${id}/matches?${new URLSearchParams({ q: query })}`, { cache: "no-store" });
        const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Lyrics search failed.");
        setResults(body.matches);
      });
    }}>
      <label className="min-w-0 flex-1 text-xs text-muted">Title and artist
        <input aria-label="Lyrics search query" required minLength={2} maxLength={150} value={query} onChange={(event) => setQuery(event.target.value)} className="mt-2 min-h-11 w-full rounded border border-line bg-elevated px-3 text-sm text-fg" />
      </label>
      <button disabled={busy} type="submit" className="mt-auto min-h-11 rounded-full bg-elevated px-4 text-sm font-semibold hover:bg-hover disabled:opacity-40">{busy ? "Working…" : "Search"}</button>
    </form>
    {results && <ul className="mb-4 space-y-2">{results.length ? results.map((match) => <li key={match.id}>
      <button disabled={busy} onClick={() => void save(match.id)} className="min-h-11 w-full rounded p-3 text-left hover:bg-hover disabled:opacity-40">
        <span className="block text-sm font-semibold">{match.trackName}</span><span className="mt-1 block text-xs text-muted">{match.artistName} · {match.albumName} · {Math.round(match.duration)}s{match.instrumental ? " · Instrumental" : ""}</span>
      </button>
    </li>) : <li className="text-sm text-muted">No matches. Try a simpler title and artist.</li>}</ul>}
    <label className="block text-sm">Lyrics timing offset <span className="float-right text-muted">{shift > 0 ? "+" : ""}{shift.toFixed(1)}s</span>
      <input aria-label="Lyrics timing offset" type="range" min="-30" max="30" step=".1" value={shift} onChange={(event) => setShift(Number(event.target.value))} className="mt-3 h-8 w-full accent-mint" />
    </label>
    <p className="mb-3 text-xs text-muted">Positive values show each line later.</p>
    <div className="flex flex-wrap gap-2"><button disabled={busy} onClick={() => void save()} className="min-h-11 rounded-full bg-elevated px-4 text-sm font-semibold disabled:opacity-40">Save timing</button>
      <button disabled={busy} onClick={() => void save(undefined, true)} className="min-h-11 rounded-full px-3 text-sm text-muted hover:bg-hover disabled:opacity-40">Reset to automatic match</button></div>
    {error && <p role="alert" className="mt-4 text-sm text-warn">{error}</p>}
  </details>;
}
