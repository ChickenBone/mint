"use client";
import { useState } from "react";
import type { TrackView } from "@mint/core/events";
import { musicRequest } from "@/lib/music-client";
import { MusicTrackList } from "./music-track-list";
import { ArtistLink } from "./music-links";

type Entry = { event: { id: string; createdAt: string; listenedMs: number; completed: boolean }; track: TrackView };
const button = "inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-4 py-2 text-sm font-semibold hover:bg-hover disabled:opacity-40";
export function ListeningHistory({ initialEntries, initialPrivate, initialExcluded }: { initialEntries: Entry[]; initialPrivate: boolean; initialExcluded: TrackView[] }) {
  const [entries, setEntries] = useState(initialEntries), [privateSession, setPrivate] = useState(initialPrivate), [excluded, setExcluded] = useState(initialExcluded);
  const [page, setPage] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const show = entries.slice(0, 100);
  return <section className="mx-auto max-w-6xl">
    <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">Your listening, privately.</h1>
    <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted">Only you can see your Mint listening history. Delete a play or clear it all. Private sessions don&apos;t record plays; excluded songs don&apos;t shape your recommendations.</p>
    <div className="my-7 flex flex-wrap items-center gap-3"><button className={`${button} ${privateSession ? "bg-mint text-mint-ink" : ""}`} aria-pressed={privateSession} disabled={busy} onClick={() => void run(async () => {
      await musicRequest("preferences", "PATCH", { privateSession: !privateSession }); setPrivate(!privateSession);
      window.dispatchEvent(new CustomEvent("mint:private-session", { detail: { privateSession: !privateSession } }));
      setNotice(privateSession ? "Listening history is recording again." : "Private session started. New plays won't be recorded.");
    })}>{privateSession ? "End private session" : "Start private session"}</button>
      <button className={`${button} text-danger`} disabled={busy || !entries.length} onClick={() => {
        if (confirm("Permanently delete all your listening history? This also removes it from your discovery profile.")) void run(async () => { await musicRequest("history", "DELETE"); setEntries([]); setPage(0);
          window.dispatchEvent(new CustomEvent("mint:private-session", { detail: { privateSession } })); setNotice("Your listening history was deleted."); });
      }}>Delete all history</button></div>
    {privateSession && <p className="mb-5 text-sm text-mint">Private session is on for your account. Existing history remains until you delete it.</p>}
    {error && <p role="alert" className="mb-5 text-warn">{error}</p>}
    <p role="status" className="my-4 text-sm text-muted">{busy ? "Updating your history…" : notice}</p>
    {!show.length ? <div className="py-10"><h2 className="text-xl font-bold">A fresh start.</h2><p className="mt-3 text-sm text-muted">Play a song for more than a second outside a private session to begin your history.</p></div>
      : <MusicTrackList entries={show.map((r) => ({ key: r.event.id, track: r.track,
        reason: `${new Date(r.event.createdAt).toLocaleString()} · ${Math.round(r.event.listenedMs / 1000)} seconds listened${r.event.completed ? " · completed" : ""}` }))}
        actions={(key, track) => <><button className={button} disabled={busy} onClick={() => void run(async () => {
          const exists = excluded.some((t) => t.id === track.id); await musicRequest(`exclusions/${track.id}`, exists ? "DELETE" : "PUT");
          setExcluded(exists ? excluded.filter((t) => t.id !== track.id) : [...excluded, track]); setNotice(exists ? "Song restored to your taste profile." : "Song excluded from your taste profile.");
        })}>{excluded.some((t) => t.id === track.id) ? "Include in taste" : "Exclude from taste"}</button>
          <button className={`${button} text-danger`} disabled={busy} aria-label={`Delete play of ${track.title}`} onClick={() => {
            if (confirm(`Delete this play of "${track.title}"?`)) void run(async () => { await musicRequest(`history/${key}`, "DELETE"); setEntries(entries.filter((r) => r.event.id !== key));
              window.dispatchEvent(new CustomEvent("mint:private-session", { detail: { privateSession } })); });
          }}>Delete play</button></>} />}
    {(page > 0 || entries.length > 100) && <nav aria-label="Listening history pages" className="my-7 flex gap-2">
      {[{ value: page - 1, label: "Previous", disabled: page === 0 }, { value: page + 1, label: "Next", disabled: entries.length <= 100 }].map((p) =>
        <button key={p.label} disabled={busy || p.disabled} className={button} onClick={() => void run(async () => { const result = await musicRequest<{ entries: Entry[] }>(`history?page=${p.value}`); setEntries(result.entries); setPage(p.value); })}>{p.label}</button>)}
    </nav>}
    {!!excluded.length && <section className="mt-10 border-t border-line pt-7"><h2 className="text-2xl font-bold">Outside your taste profile</h2><p className="mt-3 mb-5 text-sm text-muted">These exclusions remain even if you delete their listening history. Restore a song whenever you want.</p>
      <ul className="divide-y divide-line/60">{excluded.map((track) => <li key={track.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><p className="min-w-0 truncate">{track.title}<span className="ml-2 text-sm text-muted"><ArtistLink item={track} /></span></p>
        <button className={button} disabled={busy} onClick={() => void run(async () => { await musicRequest(`exclusions/${track.id}`, "DELETE"); setExcluded(excluded.filter((t) => t.id !== track.id)); })}>Include in taste</button></li>)}</ul>
    </section>}
  </section>;
}
