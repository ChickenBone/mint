"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { PlayerItem } from "@/lib/player-protocol";
import { itemCollection, loadCollection } from "@/lib/browser-catalog";
import { musicRequest, type CollectionList } from "@/lib/music-client";

export function TrackMusicActions({ item, close }: { item: PlayerItem; close: () => void }) {
  const [profile, setProfile] = useState<{ likes: string[]; exclusions: string[] } | null>(null);
  const [collections, setCollections] = useState<CollectionList | null>(null), [choose, setChoose] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const router = useRouter(), menuClass = "w-full rounded px-3 py-2.5 text-left text-sm text-fg hover:bg-hover focus:bg-hover disabled:opacity-40";
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
    router.push(`/app/discover?${query}`);
  });
  return <div className="border-t border-line pt-1">
    <button role="menuitem" disabled={busy} className={menuClass} onClick={() => void radio()}>Start {item.type === "track" ? "song" : item.type} radio</button>
    {item.type === "track" && <>
      <button role="menuitem" disabled={busy || !profile} className={menuClass} onClick={() => void run(async () => {
        await musicRequest(`likes/${item.id}`, profile?.likes.includes(item.id) ? "DELETE" : "PUT");
      })}>{profile?.likes.includes(item.id) ? "Remove from Mint likes" : "Like in Mint"}</button>
      <button role="menuitem" disabled={busy || !collections} className={menuClass} onClick={() => setChoose(!choose)} aria-expanded={choose}>Save to Mint playlist…</button>
      {choose && <div className="max-h-52 overflow-y-auto border-y border-line py-1">
        {collections?.collections.filter((collection) => !collection.rules).map((collection) => <button key={collection.id} role="menuitem" disabled={busy} className={menuClass}
          onClick={() => void run(async () => {
            await musicRequest(`collections/${collection.id}`, "PATCH", { action: "append", revision: collection.revision, trackIds: [item.id] });
          })}>{collection.title}</button>)}
        {!collections?.collections.some((collection) => !collection.rules) && <p className="px-3 py-2 text-xs text-muted">Create an editable playlist in Mint playlists first.</p>}
      </div>}
      <button role="menuitem" disabled={busy || !profile} className={menuClass} onClick={() => void run(async () => {
        await musicRequest(`exclusions/${item.id}`, profile?.exclusions.includes(item.id) ? "DELETE" : "PUT");
      })}>{profile?.exclusions.includes(item.id) ? "Allow in recommendations" : "Don’t recommend this song"}</button>
    </>}
    {error && <p role="alert" className="px-3 py-2 text-xs text-warn">{error}</p>}
  </div>;
}
