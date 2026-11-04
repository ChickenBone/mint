"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { TrackView } from "@mint/core/events";
import { ArrowDown, ArrowUp, Heart, ListMusic, Plus, Trash2 } from "lucide-react";
import { Artwork } from "@/components/artwork";
import { musicRequest, type CollectionDetail } from "@/lib/music-client";
import { CollectionActions } from "./collection-actions";
import { MusicTrackList } from "./music-track-list";

const field = "mt-2 min-h-11 w-full rounded-md bg-elevated px-3 py-2 text-sm ring-1 ring-line focus:ring-mint";
const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-elevated px-4 py-2 text-sm font-semibold hover:bg-hover disabled:opacity-40";
export function NativeCollectionEditor({ initial }: { initial: CollectionDetail }) {
  const [data, setData] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [results, setResults] = useState<TrackView[]>([]), [searched, setSearched] = useState(false);
  const router = useRouter();
  const reload = async () => setData(await musicRequest<CollectionDetail>(`collections/${data.id}`));
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const mutate = async (patch: Record<string, unknown>) => {
    await musicRequest(`collections/${data.id}`, "PATCH", { ...patch, revision: data.revision }); await reload(); setNotice("Playlist saved.");
  };
  const reorder = (index: number, offset: number) => {
    const ids = data.entries.map((e) => e.entryId), other = index + offset;
    if (other < 0 || other >= ids.length) return;
    [ids[index], ids[other]] = [ids[other]!, ids[index]!];
    return mutate({ action: "reorder", entryIds: ids });
  };
  return <section className="mx-auto max-w-6xl">
    <Link href="/app/collections" className="mb-5 inline-flex min-h-11 items-center text-sm text-muted hover:text-fg">← Mint playlists</Link>
    <header className="mb-6 flex items-end gap-5">
      {data.artworkUrl ? <Artwork track={{ artworkUrl: data.artworkUrl }} className="hidden size-36 shrink-0 rounded-md sm:block" />
        : <span className="hidden size-36 shrink-0 place-items-center rounded-md bg-elevated text-faint sm:grid"><ListMusic className="size-10" /></span>}
      <div className="min-w-0"><h1 className="break-words text-4xl font-extrabold tracking-tight sm:text-6xl">{data.title}</h1>
      <p className="mt-4 max-w-xl whitespace-pre-wrap text-sm text-muted">{data.description || (data.rules ? "A living playlist, rebuilt from your library rules." : "Your order. Your repeats. Make this one yours.")}</p>
      <p className="mt-3 text-xs text-faint">{data.role === "owner" ? "Owner" : "Collaborating editor"} · Revision {data.revision} · {data.entries.length} entries</p></div></header>
    <div className="mb-7 flex flex-wrap gap-3"><CollectionActions collection={{ kind: "playlist", id: data.id }} empty={!data.entries.some((e) => ["ready", "analyzing"].includes(e.track.stage))} label="playlist" />
      <button className={button} disabled={busy} onClick={() => void run(async () => {
        const copy = await musicRequest<{ id: string }>("collections", "POST", { title: `${data.title} (copy)`.slice(0, 200), sourceCollectionId: data.id });
        router.push(`/app/collections/${copy.id}`);
      })}>Duplicate as editable playlist</button>
    </div>
    {error && <div role="alert" className="mb-5 border-y border-line py-4"><p className="text-warn">{error}</p><button className={`${button} mt-3`} disabled={busy} onClick={() => void run(reload)}>Reload latest playlist</button></div>}
    <p role="status" className="mb-4 text-sm text-muted">{busy ? "Saving your music…" : notice}</p>
    <details className="mb-7 border-y border-line py-5"><summary className="cursor-pointer font-semibold">Edit playlist{data.rules ? " and smart rules" : ""}</summary>
      <form key={data.revision} className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={(event) => {
        event.preventDefault(); const f = new FormData(event.currentTarget);
        const number = (name: string) => f.get(name) ? Number(f.get(name)) : undefined;
        void run(() => mutate({ action: "update", title: f.get("title"), description: f.get("description"), artworkUrl: f.get("artworkUrl") || null,
          ...(data.rules ? { rules: { artist: f.get("artist") || undefined, album: f.get("album") || undefined, title: f.get("matchTitle") || undefined,
            liked: f.get("liked") === "any" ? undefined : f.get("liked") === "yes", neverPlayed: Boolean(f.get("neverPlayed")),
            codec: f.get("codec") || undefined, addedWithinDays: number("days"), minYear: number("minYear"), maxYear: number("maxYear"), order: f.get("order"), limit: number("limit") } } : {}) }));
      }}>
        <label className="text-sm">Name<input required name="title" defaultValue={data.title} maxLength={200} className={field} /></label>
        <label className="text-sm">Artwork URL<input name="artworkUrl" type="url" maxLength={2048} defaultValue={data.artworkUrl ?? ""} placeholder="https://…" className={field} /></label>
        <label className="text-sm sm:col-span-2">Description<textarea name="description" defaultValue={data.description} maxLength={2000} rows={2} className={field} /></label>
        {data.rules && <fieldset className="grid gap-4 border-t border-line pt-5 sm:col-span-2 sm:grid-cols-2"><legend className="mb-3 text-lg font-bold">Smart rules</legend>
          <p className="text-sm leading-relaxed text-muted sm:col-span-2">All rules must match. These use the owner&apos;s native likes and listening history. No songs are downloaded automatically.</p>
          <label className="text-sm">Artist contains<input name="artist" defaultValue={data.rules.artist} maxLength={200} className={field} /></label>
          <label className="text-sm">Album contains<input name="album" defaultValue={data.rules.album} maxLength={200} className={field} /></label>
          <label className="text-sm">Song title contains<input name="matchTitle" defaultValue={data.rules.title} maxLength={200} className={field} /></label>
          <label className="text-sm">Codec exactly matches<input name="codec" defaultValue={data.rules.codec} maxLength={100} placeholder="flac, opus, mp3…" className={field} /></label>
          <label className="text-sm">Mint likes<select name="liked" defaultValue={data.rules.liked === undefined ? "any" : data.rules.liked ? "yes" : "no"} className={field}><option value="any">Any song</option><option value="yes">Liked in Mint</option><option value="no">Not liked in Mint</option></select></label>
          <label className="text-sm">Year from<input name="minYear" type="number" min={1000} max={3000} defaultValue={data.rules.minYear} className={field} /></label>
          <label className="text-sm">Year through<input name="maxYear" type="number" min={1000} max={3000} defaultValue={data.rules.maxYear} className={field} /></label>
          <label className="text-sm">Added within days<input name="days" type="number" min={1} max={3650} defaultValue={data.rules.addedWithinDays} className={field} /></label>
          <label className="text-sm">Maximum songs<input name="limit" type="number" required min={1} max={1000} defaultValue={data.rules.limit} className={field} /></label>
          <label className="text-sm">Order<select name="order" defaultValue={data.rules.order} className={field}><option value="artist">Artist and title</option><option value="newest">Newest first</option><option value="least-played">Least played first</option></select></label>
          <label className="flex items-center gap-2 text-sm"><input name="neverPlayed" type="checkbox" defaultChecked={data.rules.neverPlayed} className="size-4 accent-mint" />Never played in Mint</label>
        </fieldset>}
        <button disabled={busy} className="min-h-11 justify-self-start rounded-full bg-mint px-5 py-2 text-sm font-bold text-mint-ink disabled:opacity-40">Save changes</button>
      </form>
    </details>
    {!data.rules && <details className="mb-7 border-b border-line pb-5"><summary className="cursor-pointer font-semibold">Add songs from your library</summary>
      <form className="mt-5 flex flex-wrap items-end gap-3" onSubmit={(e) => {
        e.preventDefault(); const q = String(new FormData(e.currentTarget).get("q") ?? "");
        void run(async () => { const result = await musicRequest<{ tracks: TrackView[] }>(`library?q=${encodeURIComponent(q)}`); setResults(result.tracks); setSearched(true); });
      }}><label className="min-w-0 flex-1 text-sm">Song, artist or album<input name="q" maxLength={100} className={field} placeholder="Search downloaded music" /></label><button className={button} disabled={busy}>Find songs</button></form>
      {searched && !results.length && <p className="py-5 text-sm text-muted">No playable matches. Try fewer words.</p>}
      {!!results.length && <div className="mt-5 max-h-96 overflow-y-auto"><MusicTrackList entries={results.map((track) => ({ key: track.id, track }))} actions={(_, track) =>
        <button className={button} disabled={busy} aria-label={`Add ${track.title} to playlist`} onClick={() => void run(() => mutate({ action: "append", trackIds: [track.id] }))}><Plus className="size-4" />Add</button>} /></div>}
      <p className="mt-3 text-xs text-faint">Add a song again to keep a second entry. Removing one entry never removes the other.</p>
    </details>}
    {!data.entries.length ? <p className="py-10 text-muted">{data.rules ? "No playable songs match these rules. Adjust the filters above." : "This playlist is ready for its first song. Search your library above."}</p>
      : <MusicTrackList playAsQueue entries={data.entries.map((e) => ({ key: e.entryId, track: e.track }))} actions={(key, track, index) => <>
        <button className={button} disabled={busy} aria-label={`Like ${track.title} in Mint`} onClick={() => void run(async () => { await musicRequest(`likes/${track.id}`, "PUT"); setNotice("Added to Mint likes."); })}><Heart className="size-4" /></button>
        {!data.rules && <><button className={button} disabled={busy || index === 0} aria-label={`Move entry ${index + 1} up`} onClick={() => void run(async () => { await reorder(index, -1); })}><ArrowUp className="size-4" /></button>
          <button className={button} disabled={busy || index === data.entries.length - 1} aria-label={`Move entry ${index + 1} down`} onClick={() => void run(async () => { await reorder(index, 1); })}><ArrowDown className="size-4" /></button>
          <button className={`${button} text-danger`} disabled={busy} aria-label={`Remove entry ${index + 1}: ${track.title}`} onClick={() => void run(() => mutate({ action: "remove", entryId: key }))}><Trash2 className="size-4" /></button></>}
      </>} />}
    {data.role === "owner" && <section className="mt-10 border-t border-line pt-7"><h2 className="text-2xl font-bold">Collaborators</h2><p className="mt-3 max-w-xl text-sm text-muted">Invite an approved Mint member by email. Editors can change songs and details. Only you can invite, revoke or delete.</p>
      <form className="my-5 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); const email = new FormData(e.currentTarget).get("email");
        void run(() => mutate({ action: "invite", email })); }}>
        <label className="min-w-0 flex-1 text-sm">Member email<input name="email" type="email" required maxLength={320} className={field} /></label><button className={button} disabled={busy}>Invite editor</button>
      </form>
      <ul>{data.collaborators.map((member) => <li key={member.userId} className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 py-3"><p>{member.name}<span className="ml-2 text-sm text-muted">{member.accepted ? "Editor" : "Invitation pending"}</span></p>
        <button className={`${button} text-danger`} disabled={busy} onClick={() => { if (confirm(`Revoke ${member.name}'s access?`)) void run(() => mutate({ action: "revoke", userId: member.userId })); }}>Revoke</button></li>)}</ul>
      <button className={`${button} mt-8 text-danger`} disabled={busy} onClick={() => { if (confirm(`Permanently delete "${data.title}"? Your music files will remain.`)) void run(async () => {
        await musicRequest(`collections/${data.id}`, "PATCH", { action: "delete", revision: data.revision }); router.push("/app/collections");
      }); }}>Delete playlist</button>
    </section>}
  </section>;
}
