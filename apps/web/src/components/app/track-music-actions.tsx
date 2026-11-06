"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { PlayerItem } from "@/lib/player-protocol";
import { itemCollection, loadCollection } from "@/lib/browser-catalog";
import { musicRequest, type CollectionList } from "@/lib/music-client";
import { useToast } from "@/components/ui/toast";

export function TrackMusicActions({ item, close }: { item: PlayerItem; close: () => void }) {
  const [profile, setProfile] = useState<{ likes: string[]; exclusions: string[] } | null>(null);
  const [collections, setCollections] = useState<CollectionList | null>(null), [choose, setChoose] = useState(false);
  const [creating, setCreating] = useState(false), [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const router = useRouter(), { showToast } = useToast(), menuClass = "w-full rounded px-3 py-2.5 text-left text-sm text-fg hover:bg-hover focus:bg-hover disabled:opacity-40";
  useEffect(() => {
    let active = true;
    void Promise.all([musicRequest<{ likes: string[]; exclusions: string[] }>("preferences"), musicRequest<CollectionList>("collections")])
      .then(([profile, collections]) => { if (active) { setProfile(profile); setCollections(collections); } })
      .catch((error: unknown) => { if (active) setError(error instanceof Error ? error.message : "Music actions could not load."); });
    return () => { active = false; };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); close(); } catch (error) { setError(error instanceof Error ? error.message : "This music action failed."); }
    finally { setBusy(false); }
  };
  const radio = () => run(async () => {
    const seeds = item.type === "track" ? [item.id] : (await loadCollection(itemCollection(item), new AbortController().signal)).slice(0, 20).map((item) => item.id);
    if (!seeds.length) throw new Error("No playable songs are available to seed this radio.");
    const query = new URLSearchParams({ mode: "radio" }); seeds.forEach((seed) => query.append("seed", seed));
    router.push(`/app/discover/mixes?${query}`);
  });
  const editable = (collections?.collections ?? []).filter((collection) => !collection.rules)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const addTo = async (collection: Pick<(typeof editable)[number], "id" | "title" | "revision">) => {
    await musicRequest<{ revision: number }>(`collections/${collection.id}`, "PATCH", {
      action: "append", revision: collection.revision, trackIds: [item.id],
    });
    const detail = await musicRequest<{ revision: number; entries: { entryId: string; track: { id: string } }[] }>(`collections/${collection.id}`);
    const added = [...detail.entries].reverse().find((entry) => entry.track.id === item.id);
    if (!added) throw new Error("The song was added, but its playlist entry could not be confirmed.");
    showToast(`Added to ${collection.title}.`, "success", {
      label: "Undo",
      onAction: async () => {
        await musicRequest(`collections/${collection.id}`, "PATCH", { action: "remove", revision: detail.revision, entryId: added.entryId });
      },
    });
  };
  return <div className="border-t border-line pt-1">
    <button role="menuitem" disabled={busy} className={menuClass} onClick={() => void radio()}>Start {item.type === "track" ? "song" : item.type} radio</button>
    {item.type === "track" && <>
      <button role="menuitem" disabled={busy || !profile} className={menuClass} onClick={() => void run(async () => {
        await musicRequest(`likes/${item.id}`, profile?.likes.includes(item.id) ? "DELETE" : "PUT");
      })}>{profile?.likes.includes(item.id) ? "Remove from Liked songs" : "Like"}</button>
      <button role="menuitem" disabled={busy || !collections} className={menuClass} onClick={() => setChoose(!choose)} aria-expanded={choose}>Save to playlist…</button>
      {choose && <div className="max-h-52 overflow-y-auto border-y border-line py-1">
        <p className="px-3 py-2 text-xs font-semibold text-muted">Recent playlists</p>
        {(showAll ? editable : editable.slice(0, 3)).map((collection) => <button key={collection.id} role="menuitem" disabled={busy} className={menuClass}
          onClick={() => void run(() => addTo(collection))}>{collection.title}</button>)}
        {editable.length > 3 && <button role="menuitem" className={menuClass} onClick={() => setShowAll(!showAll)}>{showAll ? "Show recent only" : "Show all playlists"}</button>}
        {!editable.length && <p className="px-3 py-2 text-xs text-muted">No editable playlists yet.</p>}
        {creating ? <form className="border-t border-line p-2" onSubmit={(event) => {
          event.preventDefault();
          const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
          if (!title) return;
          void run(async () => {
            const created = await musicRequest<Pick<(typeof editable)[number], "id" | "revision" | "title">>("collections", "POST", { title });
            await addTo(created);
          });
        }}>
          <label className="sr-only" htmlFor="track-action-playlist-title">New playlist name</label>
          <input id="track-action-playlist-title" name="title" required maxLength={200} autoFocus placeholder="New playlist name"
            className="mb-2 min-h-11 w-full rounded bg-hover px-3 text-sm text-fg" />
          <button type="submit" disabled={busy} className="min-h-11 w-full rounded bg-mint px-3 text-sm font-bold text-mint-ink disabled:opacity-40">Create and add song</button>
        </form> : <button role="menuitem" className={menuClass} onClick={() => setCreating(true)}>Create playlist…</button>}
      </div>}
      <button role="menuitem" disabled={busy || !profile} className={menuClass} onClick={() => void run(async () => {
        await musicRequest(`exclusions/${item.id}`, profile?.exclusions.includes(item.id) ? "DELETE" : "PUT");
      })}>{profile?.exclusions.includes(item.id) ? "Allow in recommendations" : "Don’t recommend this song"}</button>
    </>}
    {error && <p role="alert" className="px-3 py-2 text-xs text-warn">{error}</p>}
  </div>;
}
