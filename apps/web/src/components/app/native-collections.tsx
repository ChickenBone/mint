"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Folder, Heart, ListMusic, Pin } from "lucide-react";
import { Artwork } from "@/components/artwork";
import { musicRequest, type CollectionList } from "@/lib/music-client";
import { NativeLikes } from "./native-likes";
import { MusicItem } from "./music-item";
import { TrackMenuButton } from "./player";

const input = "min-h-11 w-full rounded-md bg-elevated px-3 py-2 text-sm ring-1 ring-line focus:ring-mint";
const button = "min-h-11 rounded-full bg-elevated px-4 py-2 text-sm font-semibold hover:bg-hover disabled:opacity-40";
export function NativeCollections({ initial, sources }: { initial: CollectionList; sources: { id: string; title: string }[] }) {
  const [data, setData] = useState(initial), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"playlists" | "likes">("playlists"), [folder, setFolder] = useState("all");
  const router = useRouter();
  const run = async (fn: () => Promise<void>) => { setError(""); setBusy(true); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const reload = async () => setData(await musicRequest<CollectionList>("collections"));
  const shown = data.collections.filter((p) => folder === "all" || (folder === "unfiled" ? !p.folderId : p.folderId === folder));
  return <section className="mx-auto max-w-6xl">
    <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">Made by you.</h1>
    <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted">Your Mint playlists and likes live here. YouTube imports stay source-managed; make a Mint copy when you want to change one.</p>
    <nav className="my-7 flex flex-wrap gap-2" aria-label="Mint collections">
      {(["playlists", "likes"] as const).map((value) => <button key={value} onClick={() => setTab(value)} aria-pressed={tab === value}
        className={`${button} ${tab === value ? "bg-fg text-bg" : ""}`}>{value === "playlists" ? "Playlists" : "Mint likes"}</button>)}
    </nav>
    {error && <p role="alert" className="mb-5 text-warn">{error}</p>}
    {tab === "likes" ? <NativeLikes /> : <>
      {!!data.invitations.length && <section className="mb-8 border-y border-line py-5"><h2 className="text-xl font-bold">Invitations</h2>
        {data.invitations.map((invite) => <div key={invite.id} className="mt-3 flex flex-wrap items-center justify-between gap-3"><p>{invite.title}<span className="ml-2 text-sm text-muted">from {invite.owner}</span></p>
          <div className="flex gap-2">{[true, false].map((accept) => <button key={String(accept)} disabled={busy} className={button} onClick={() => void run(async () => {
            await musicRequest(`collections/${invite.id}/invitation`, "POST", { accept }); await reload();
          })}>{accept ? "Accept editor invitation" : "Decline"}</button>)}</div></div>)}</section>}
      <details className="mb-7 rounded-lg bg-elevated/50 p-5">
        <summary className="cursor-pointer font-semibold">Create a playlist or import a copy</summary>
        <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={(event) => {
          event.preventDefault(); const values = new FormData(event.currentTarget);
          void run(async () => {
            const result = await musicRequest<{ id: string }>("collections", "POST", { title: values.get("title"),
              sourcePlaylistId: values.get("source") || undefined, rules: values.get("smart") ? { order: "newest", limit: 100 } : null });
            router.push(`/app/collections/${result.id}`);
          });
        }}>
          <label className="text-sm">Playlist name<input name="title" required maxLength={200} className={`${input} mt-2`} placeholder="A new shelf" /></label>
          <label className="text-sm">Starting point<select name="source" className={`${input} mt-2`}><option value="">Empty Mint playlist</option>{sources.map((s) => <option key={s.id} value={s.id}>Copy: {s.title}</option>)}</select></label>
          <label className="flex items-center gap-2 text-sm text-muted"><input name="smart" type="checkbox" className="size-4 accent-mint" />Use smart rules instead of fixed songs</label>
          <button disabled={busy} className="min-h-11 justify-self-start rounded-full bg-mint px-5 py-2 text-sm font-bold text-mint-ink disabled:opacity-40">{busy ? "Creating…" : "Create playlist"}</button>
        </form>
      </details>
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <label className="text-sm text-muted">Folder<select value={folder} onChange={(e) => setFolder(e.target.value)} className={`${input} mt-2 min-w-40`}>
          <option value="all">All playlists</option><option value="unfiled">Unfiled</option>{data.folders.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}</select></label>
        <form className="flex min-w-0 flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget, title = new FormData(form).get("title");
          void run(async () => { await musicRequest("folders", "POST", { title }); form.reset(); await reload(); }); }}>
          <label className="sr-only" htmlFor="folder-title">New folder name</label><input id="folder-title" name="title" required maxLength={100} className={`${input} w-40`} placeholder="New folder name" />
          <button disabled={busy} className={button}>Create folder</button>
        </form>
        {folder !== "all" && folder !== "unfiled" && <button className={`${button} text-danger`} disabled={busy} onClick={() => {
          if (confirm("Delete this folder? Its playlists will remain unfiled.")) void run(async () => { await musicRequest(`folders/${folder}`, "DELETE"); setFolder("all"); await reload(); });
        }}>Delete folder</button>}
      </div>
      {folder !== "all" && folder !== "unfiled" && <form key={folder} className="mb-5 flex min-w-0 flex-wrap items-end gap-3" onSubmit={(e) => {
        e.preventDefault(); const title = new FormData(e.currentTarget).get("title");
        void run(async () => { await musicRequest(`folders/${folder}`, "PATCH", { title }); await reload(); });
      }}><label className="text-sm text-muted">Folder name<input name="title" defaultValue={data.folders.find((f) => f.id === folder)?.title} required maxLength={100} className={`${input} mt-2 w-52`} /></label>
        <button className={button} disabled={busy}>Rename folder</button></form>}
      {!shown.length ? <div className="py-12"><ListMusic className="mb-4 size-8 text-faint" /><h2 className="text-xl font-bold">Make room for your next favorite.</h2><p className="mt-3 text-sm text-muted">Create a playlist above, or copy a YouTube playlist to make it your own.</p></div>
        : <ul className="divide-y divide-line/60">{shown.map((p) => <MusicItem as="li" item={{ id: p.id, type: "playlist", title: p.title, thumb: p.artworkUrl ?? undefined }} key={p.id} className="flex flex-wrap items-center gap-3 py-4">
          <Link className="flex min-w-0 flex-1 items-center gap-4" href={`/app/collections/${p.id}`}>
            {p.artworkUrl ? <Artwork track={{ artworkUrl: p.artworkUrl }} className="size-16 shrink-0 rounded" /> : <span className="grid size-16 shrink-0 place-items-center rounded bg-elevated text-faint"><ListMusic className="size-6" /></span>}
            <span className="min-w-0"><span className="block truncate font-bold hover:underline">{p.title}</span><span className="mt-1 block text-sm text-muted">{p.rules ? "Smart playlist" : "Mint playlist"} · {p.role === "owner" ? "Owner" : "Editor"}</span></span></Link>
          <TrackMenuButton item={{ id: p.id, type: "playlist", title: p.title, thumb: p.artworkUrl ?? undefined }} />
          <button className={button} disabled={busy} aria-label={`${p.pinned ? "Unpin" : "Pin"} ${p.title}`} aria-pressed={p.pinned} onClick={() => void run(async () => {
            await musicRequest(`collections/${p.id}/organization`, "PATCH", { pinned: !p.pinned, folderId: p.folderId }); await reload();
          })}><Pin className={`size-4 ${p.pinned ? "text-mint" : ""}`} /></button>
          <label className="flex items-center gap-2 text-sm text-muted"><Folder className="size-4" /><span className="sr-only">Folder for {p.title}</span>
            <select className={`${input} max-w-44`} disabled={busy} value={p.folderId ?? ""} onChange={(e) => { const folderId = e.target.value || null;
              void run(async () => { await musicRequest(`collections/${p.id}/organization`, "PATCH", { pinned: p.pinned, folderId }); await reload(); }); }}>
              <option value="">Unfiled</option>{data.folders.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}</select></label>
        </MusicItem>)}</ul>}
      <p className="mt-8 flex items-center gap-2 text-sm text-faint"><Heart className="size-4" />Mint likes are private to you and never change YouTube Music.</p>
    </>}
  </section>;
}
