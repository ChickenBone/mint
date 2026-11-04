"use client";
import { useEffect, useState } from "react";
import type { TrackView } from "@mint/core/events";
import { musicRequest } from "@/lib/music-client";
import { trackPlayerItem } from "@/lib/player-protocol";
import { Play, Shuffle } from "lucide-react";
import { MusicTrackList } from "./music-track-list";
import { usePlayer } from "./player";

export function NativeLikes() {
  const [tracks, setTracks] = useState<TrackView[] | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const player = usePlayer();
  const items = (tracks ?? []).filter((t) => ["ready", "analyzing"].includes(t.stage)).map(trackPlayerItem);
  useEffect(() => { let active = true;
    void musicRequest<{ tracks: { track: TrackView }[] }>("likes").then((r) => { if (active) setTracks(r.tracks.map((r) => r.track)); }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  return <section><h2 className="text-2xl font-bold">Mint likes</h2><p className="my-4 text-sm text-muted">A private shelf for your favorites. Add hearts from Discover or a native playlist. YouTube likes are untouched.</p>
    {!!tracks?.length && <div className="mb-5 flex flex-wrap gap-2"><button disabled={!player?.ready || player.busy || !items.length} onClick={() => player?.command({ action: "items", items })}
      className="inline-flex min-h-11 items-center gap-2 rounded-full bg-mint px-5 py-2 text-sm font-bold text-mint-ink disabled:opacity-40"><Play className="size-4" />Play Mint likes</button>
      <button disabled={!player?.ready || player.busy || !items.length} onClick={() => player?.command({ action: "items", items, shuffle: true })}
        className="inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-4 py-2 text-sm font-semibold hover:bg-hover disabled:opacity-40"><Shuffle className="size-4" />Shuffle</button></div>}
    {error && <p role="alert" className="my-4 text-warn">{error}</p>}
    {!tracks ? <p role="status" className="py-8 text-muted">Opening your likes…</p> : !tracks.length ? <p className="py-8 text-muted">Your first Mint favorite is one heart away. Explore Discover to add it.</p>
      : <MusicTrackList playAsQueue entries={tracks.map((track) => ({ key: track.id, track }))} actions={(_, track) => <button className="min-h-11 rounded-full px-3 text-sm text-muted hover:bg-hover hover:text-danger" disabled={busy} onClick={async () => {
        setBusy(true); setError(""); try { await musicRequest(`likes/${track.id}`, "DELETE"); setTracks(tracks.filter((t) => t.id !== track.id)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>Unlike</button>} />}
  </section>;
}
