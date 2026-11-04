"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Download, HardDrive, Trash2, X } from "lucide-react";
import { collectionSchema, type PlayerItem } from "@/lib/player-protocol";
import { loadCollection } from "@/lib/browser-catalog";
import { authorizeOffline, clearOffline, downloadSong, listOffline, offlineSettings, removeOffline, saveOfflineCollection, setOfflineLimit, type OfflineSong } from "@/lib/offline";
import { Artwork } from "@/components/artwork";

const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
export function Downloads({ memberId }: { memberId: string }) {
  const params = useSearchParams();
  const [songs, setSongs] = useState<OfflineSong[]>([]), [selected, setSelected] = useState<PlayerItem[] | null>(null);
  const [limit, setLimit] = useState(2 * 1024 ** 3), [expiry, setExpiry] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ title: string; index: number; total: number; bytes: number; size: number | null } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [feedback, setFeedback] = useState("");
  const [format, setFormat] = useState<"original" | "mp3">("original");
  const controller = useRef<AbortController | null>(null);
  const refresh = async () => {
    const [songs, settings] = await Promise.all([listOffline(memberId), offlineSettings()]);
    setSongs(songs); setLimit(settings?.limit ?? 2 * 1024 ** 3); setExpiry(settings?.grant.expiresAt ?? null);
  };
  useEffect(() => {
    const abort = new AbortController();
    void authorizeOffline(memberId, abort.signal).then(refresh).catch((error: unknown) => {
      if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "Downloads could not initialize.");
    });
    const changed = () => { void refresh().catch((error: unknown) => setError(error instanceof Error ? error.message : "Downloads could not refresh.")); };
    window.addEventListener("mint-offline-changed", changed);
    return () => { abort.abort(); controller.current?.abort(); window.removeEventListener("mint-offline-changed", changed); };
    // Account identity is fixed for this member layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);
  const act = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); await refresh(); } catch (error) {
      setError(error instanceof Error ? error.message : "The download action failed.");
    }
  };
  const select = async () => {
    setBusy(true); setError(null); setFeedback("");
    const abort = controller.current = new AbortController();
    try {
      const collection = collectionSchema.parse({ kind: params.get("kind") ?? "liked", id: params.get("id"), query: params.get("q") || undefined });
      const items = await loadCollection(collection, abort.signal);
      setSelected(params.get("track") ? items.filter((item) => item.id === params.get("track")) : items);
    } catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "This collection could not load."); }
    finally { setBusy(false); }
  };
  const download = async () => {
    if (!selected?.length) return;
    setBusy(true); setError(null); setFeedback("");
    const abort = controller.current = new AbortController();
    const unique = [...new Map(selected.map((item) => [item.id, item])).values()];
    let completed = 0;
    try {
      for (const [index, item] of unique.entries()) {
        abort.signal.throwIfAborted();
        if (songs.some((song) => song.id === item.id)) { completed++; continue; }
        setProgress({ title: item.title, index: index + 1, total: unique.length, bytes: 0, size: null });
        await downloadSong(memberId, item, abort.signal, (bytes, size) => setProgress({ title: item.title, index: index + 1, total: unique.length, bytes, size }), format);
        completed++;
      }
      setFeedback(`${completed} ${completed === 1 ? "song is" : "songs are"} available offline.`);
    } catch (error) {
      if (abort.signal.aborted) setFeedback(`Download cancelled. ${completed} complete songs remain saved.`);
      else setError(error instanceof Error ? error.message : "Download failed. Completed songs remain saved; retry to continue.");
    } finally {
      try {
        await saveOfflineCollection(memberId, {
          id: new URLSearchParams({ kind: params.get("kind") ?? "liked", id: params.get("id") ?? "", q: params.get("q") ?? "", track: params.get("track") ?? "" }).toString(),
          title: params.get("title") ?? (params.get("track") ? selected[0]!.title : params.get("kind") === "album" ? selected[0]!.album ?? "Saved album" : params.get("kind") === "playlist" ? "Saved playlist" : params.get("kind") === "library" ? "Saved library" : "YouTube likes"),
          trackIds: selected.map((item) => item.id),
        });
      } catch (error) { setError(`Audio files were saved, but their collection could not be stored: ${error instanceof Error ? error.message : "check device storage."}`); }
      setBusy(false); setProgress(null); await refresh();
    }
  };
  const used = songs.reduce((sum, song) => sum + song.bytes, 0);
  return <div className="mx-auto max-w-4xl">
    <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">Take your music with you.</h1>
    <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">Save complete songs on this device. Downloads belong to your account, expire after seven days without verification, and are removed when you sign out. Android can reclaim browser storage; keep the server originals.</p>
    <div className="my-7 flex flex-wrap items-center gap-3">
      <button disabled={busy} onClick={() => void select()} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-mint px-5 text-sm font-bold text-mint-ink disabled:opacity-40"><Download className="size-4" />Choose {params.get("kind") ?? "liked songs"}</button>
      <a href="/offline.html" className="min-h-11 rounded-full bg-elevated px-5 py-3 text-sm font-semibold hover:bg-hover">Open offline player</a>
      <Link href="/app/music?view=library" className="min-h-11 px-3 py-3 text-sm text-muted hover:text-fg">Back to music</Link>
    </div>
    {selected && <div className="mb-6 border-y border-line py-5">
      <p className="font-semibold">{selected.length.toLocaleString()} {selected.length === 1 ? "song" : "songs"} selected</p>
      <p className="mt-2 text-sm text-muted">Already saved songs are skipped. Downloads run one at a time; keep Mint open until finished.</p>
      <label className="mt-4 flex flex-wrap items-center gap-3 text-sm">Audio format
        <select aria-label="Download audio format" disabled={busy} value={format} onChange={(event) => setFormat(event.target.value as "original" | "mp3")} className="min-h-11 rounded border border-line bg-elevated px-3">
          <option value="original">Original file</option><option value="mp3">MP3 compatibility · 192 kbps</option>
        </select>
      </label>
      <p className="mt-2 text-xs text-muted">If your browser cannot decode an original, remove that device download and save its MP3 compatibility copy instead. Server originals are never changed. Each device file is limited to 512 MB.</p>
      <button disabled={busy || !selected.length} onClick={() => void download()} className="mt-4 min-h-11 rounded-full bg-mint px-5 text-sm font-bold text-mint-ink disabled:opacity-40">Download selected songs</button>
    </div>}
    {busy && <div role="status" className="mb-6 border-b border-line pb-5">
      <p className="font-semibold">{progress ? `${progress.index} / ${progress.total} · ${progress.title}` : "Loading selection…"}</p>
      {progress && <p className="mt-2 text-sm text-muted tabular">{bytes(progress.bytes)}{progress.size !== null ? ` / ${bytes(progress.size)}` : ""}</p>}
      <button onClick={() => controller.current?.abort()} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-4 text-sm"><X className="size-4" />Cancel</button>
    </div>}
    {error && <p role="alert" className="mb-5 text-sm text-warn">{error}</p>}
    {feedback && <p role="status" className="mb-5 text-sm text-mint">{feedback}</p>}
    <section aria-label="Device storage" className="mb-8 border-y border-line py-5">
      <h2 className="flex items-center gap-2 font-semibold"><HardDrive className="size-4" />Device storage</h2>
      <p className="mt-3 text-sm text-muted tabular">{bytes(used)} of {bytes(limit)} · {songs.length} saved {songs.length === 1 ? "song" : "songs"}</p>
      <label className="mt-4 flex flex-wrap items-center gap-3 text-sm">Storage limit
        <select aria-label="Download storage limit" disabled={busy} value={limit} onChange={(event) => void act(() => setOfflineLimit(memberId, Number(event.target.value)))} className="min-h-11 rounded bg-elevated px-3">
          {[256 * 1024 ** 2, 1024 ** 3, 2 * 1024 ** 3, 5 * 1024 ** 3, 10 * 1024 ** 3, 20 * 1024 ** 3].map((value) => <option key={value} value={value}>{bytes(value)}</option>)}
        </select>
      </label>
      {expiry && <p className="mt-3 text-xs text-muted">Offline access valid until {new Date(expiry).toLocaleString()}.</p>}
      <button disabled={busy} onClick={() => void act(async () => { if (!confirm("Remove all downloaded music from this device? Server originals are untouched.")) return; await clearOffline(); await authorizeOffline(memberId); })} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm text-danger hover:bg-hover disabled:opacity-40"><Trash2 className="size-4" />Remove all downloads</button>
    </section>
    <h2 className="mb-4 text-xl font-bold">Downloaded songs</h2>
    {!songs.length ? <p className="py-6 text-sm text-muted">Nothing saved yet. Choose liked songs above, or use a song, album or playlist&apos;s Download menu.</p> : <ol className="divide-y divide-line">{songs.map((song) => <li key={song.id} className="flex items-center gap-3 py-3">
      <Artwork track={{ artworkUrl: song.item.thumb ?? "" }} className="size-11" />
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{song.item.title}</p><p className="truncate text-xs text-muted">{song.item.artist} · {bytes(song.bytes)}</p></div>
      <button disabled={busy} aria-label={`Remove download ${song.item.title}`} onClick={() => void act(() => removeOffline(memberId, song.id))} className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-danger disabled:opacity-40"><Trash2 className="size-4" /></button>
    </li>)}</ol>}
  </div>;
}
