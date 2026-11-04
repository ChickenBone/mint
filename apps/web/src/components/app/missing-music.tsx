"use client";
import Link from "next/link";
import { useState } from "react";
import type { RequestRecording } from "@/lib/music-requests";
import { musicRequest } from "@/lib/music-client";

type Result = RequestRecording & { token: string; existing: { id: string; stage: string } | null };
export function MissingMusic({ query }: { query: string }) {
  const [results, setResults] = useState<Result[] | null>(null), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState("");
  const [requested, setRequested] = useState<Record<string, string>>({});
  return <section className="mt-10 border-t border-line pt-7" aria-label="Request missing music">
    <h2 className="text-xl font-bold">Not in the backlog yet?</h2>
    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">Search the recording catalog and explicitly request a song. Mint tries your configured acquisition sources; it never downloads a search result automatically. MusicBrainz receives this search text, not your library or account.</p>
    <button disabled={busy !== null || query.trim().length < 2} onClick={async () => {
      setBusy("search"); setError("");
      try { setResults((await musicRequest<{ items: Result[] }>(`search?${new URLSearchParams({ q: query })}`)).items); }
      catch (error) { setError(error instanceof Error ? error.message : "The recording catalog could not load."); }
      finally { setBusy(null); }
    }} className="mt-4 min-h-11 rounded-full bg-elevated px-5 text-sm font-semibold hover:bg-hover disabled:opacity-40">{busy === "search" ? "Searching recordings…" : `Find missing music for “${query}”`}</button>
    {results && !results.length && <p className="mt-4 text-sm text-muted">No recordings found. Try the title and artist without punctuation.</p>}
    {results && <ol className="mt-5 divide-y divide-line">{results.map((item) => <li key={item.id} className="py-4">
      <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><h3 className="font-semibold">{item.title}</h3><p className="text-sm text-muted">{item.artist}{item.album ? ` · ${item.album}` : ""}</p></div>
        <a href={`https://musicbrainz.org/recording/${item.id}`} target="_blank" rel="noreferrer" className="min-h-11 py-3 text-xs text-muted hover:text-fg">Recording details</a></div>
      {requested[item.id] || item.existing && !["failed", "queued"].includes(item.existing.stage) ? <Link href={["ready", "analyzing"].includes(item.existing?.stage ?? "") ? `/app/music?view=search&q=${encodeURIComponent(`${item.artist} ${item.title}`)}` : "/app/jobs"} className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-mint">
        {requested[item.id] ? "Requested · view progress" : ["ready", "analyzing"].includes(item.existing!.stage) ? "Already available · find in library" : "Already requested · view progress"}
      </Link> : <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={async (event) => {
        event.preventDefault(); const youtubeUrl = String(new FormData(event.currentTarget).get("youtubeUrl") ?? "").trim();
        setBusy(item.id); setError("");
        try {
          const result = await musicRequest<{ trackId: string }>("search", "POST", { token: item.token, ...(youtubeUrl ? { youtubeUrl } : {}) });
          setRequested((previous) => ({ ...previous, [item.id]: result.trackId }));
        } catch (error) { setError(error instanceof Error ? error.message : "This recording could not be requested."); }
        finally { setBusy(null); }
      }}>
        <label className="min-w-0 flex-[1_1_16rem] text-xs text-muted">YouTube video URL (optional)
          <input type="url" name="youtubeUrl" maxLength={2048} placeholder="https://music.youtube.com/watch?v=…" className="mt-2 min-h-11 w-full rounded-md bg-elevated px-3 text-sm text-fg ring-1 ring-line focus:ring-mint" /></label>
        <button disabled={busy !== null} className="min-h-11 rounded-full bg-mint px-5 text-sm font-bold text-mint-ink disabled:opacity-40">{busy === item.id ? "Requesting…" : item.existing?.stage === "failed" ? "Retry download" : "Request download"}</button>
        <p className="w-full text-xs leading-relaxed text-faint">Without a video URL, Mint tries Lidarr, then verifies a YouTube match using your linked account. Source or quota failures appear in Jobs.</p>
      </form>}
    </li>)}</ol>}
    {error && <p role="alert" className="mt-4 text-sm text-warn">{error}</p>}
  </section>;
}
