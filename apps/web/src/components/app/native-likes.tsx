"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { TrackView } from "@mint/core/events";
import { Download, Heart, Play, Shuffle } from "lucide-react";
import { importLikedSongs, musicRequest } from "@/lib/music-client";
import { trackPlayerItem } from "@/lib/player-protocol";
import { MusicTrackList } from "./music-track-list";
import { usePlayer } from "./player";

export function NativeLikes({ importedLikes = { tracks: [], nextCursor: null } }: {
  importedLikes?: { tracks: TrackView[]; nextCursor: string | null };
}) {
  const [tracks, setTracks] = useState<TrackView[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const player = usePlayer();
  const router = useRouter();
  const [importPage, setImportPage] = useState(importedLikes);
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null]);
  const items = (tracks ?? []).filter((t) => ["ready", "analyzing"].includes(t.stage)).map(trackPlayerItem);
  const candidates = importPage.tracks.filter((track) => !tracks?.some((liked) => liked.id === track.id));
  const loadImportPage = async (cursors: Array<string | null>) => {
    setBusy(true);
    setError("");
    try {
      const cursor = cursors.at(-1);
      const page = await musicRequest<typeof importedLikes>(`likes/imported${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      setImportPage(page);
      setPageCursors(cursors);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Favorites could not load. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const importSongs = async (ids: string[]) => {
    setBusy(true);
    setError("");
    try {
      await importLikedSongs(ids);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Import failed. Completed likes remain saved; try again.");
    } finally {
      try {
        const result = await musicRequest<{ tracks: { track: TrackView }[] }>("likes");
        setTracks(result.tracks.map((entry) => entry.track));
        router.refresh();
      } catch {
        setError("Could not refresh Liked songs. Reload the page to see any saved likes.");
      }
      setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    void musicRequest<{ tracks: { track: TrackView }[] }>("likes")
      .then((r) => {
        if (active) setTracks(r.tracks.map((r) => r.track));
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section aria-labelledby="mint-likes-heading">
      <div className="mb-6 flex flex-wrap items-end gap-5">
        <div className="grid size-28 shrink-0 place-items-center rounded-md bg-mint text-mint-ink sm:size-36" aria-hidden>
          <Heart className="size-12 fill-current" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="mint-likes-heading" className="text-3xl font-extrabold sm:text-5xl">
            Liked songs
          </h2>
          <p className="mt-3 max-w-prose text-sm text-muted">
            Your favorites, saved just for you.
          </p>
          {tracks && <p className="mt-2 text-sm text-muted">{tracks.length} songs</p>}
        </div>
      </div>
        {!!tracks?.length && (
          <div className="mb-6 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!player?.ready || player.busy || !items.length}
              onClick={() => player?.command({ action: "items", items })}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-mint px-5 py-2 text-sm font-bold text-mint-ink disabled:opacity-40"
            >
              <Play className="size-4" aria-hidden />
              Play
            </button>
            <button
              type="button"
              disabled={!player?.ready || player.busy || !items.length}
              onClick={() => player?.command({ action: "items", items, shuffle: true })}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-4 py-2 text-sm font-semibold hover:bg-hover disabled:opacity-40"
            >
              <Shuffle className="size-4" aria-hidden />
              Shuffle
            </button>
            <Link href="/app/collection?tab=downloads&kind=native-liked&title=Liked%20songs"
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-4 py-2 text-sm font-semibold hover:bg-hover">
              <Download className="size-4" aria-hidden /> Download
            </Link>
          </div>
        )}
      {error && (
        <p role="alert" className="my-4 text-warn">
          {error}
        </p>
      )}
      {!tracks ? (
        <p role="status" className="py-8 text-muted">
          Loading Liked songs…
        </p>
      ) : !tracks.length ? (
        <p className="max-w-prose py-6 text-sm text-muted">
          Songs you like will appear here. Find a favorite in Search or Discover and choose Like.
        </p>
      ) : (
        <MusicTrackList
          playAsQueue
          entries={tracks.map((track) => ({ key: track.id, track }))}
          actions={(_, track) => (
            <div className="flex flex-wrap gap-2">
            <Link href={`/app/collection?tab=downloads&kind=native-liked&id=${track.id}&track=${track.id}&title=${encodeURIComponent(track.title)}`}
              aria-label={`Download ${track.title}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm text-muted hover:bg-hover hover:text-fg">
              <Download className="size-4" aria-hidden /> Download
            </Link>
            <button
              type="button"
              className="min-h-11 rounded-full px-3 text-sm text-muted hover:bg-hover hover:text-danger"
              disabled={busy}
              aria-label={`Remove ${track.title} from Liked songs`}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await musicRequest(`likes/${track.id}`, "DELETE");
                  setTracks(tracks.filter((t) => t.id !== track.id));
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Unlike
            </button>
            </div>
          )}
        />
      )}
          {(!!candidates.length || pageCursors.length > 1 || !!importPage.nextCursor) && (
            <details className="mt-8 border-t border-line">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">
                Previously imported favorites
              </summary>
              <p className="my-3 max-w-prose text-sm text-muted">
                These favorites were saved from YouTube and are not yet liked here.
                Add the songs you want to Liked songs. This is a copy, not a live link:
                future imports will not undo your choices or change your YouTube likes.
              </p>
              <button type="button" disabled={busy || !tracks || !candidates.length} onClick={() => void importSongs(candidates.map((track) => track.id))}
                className="mb-4 min-h-11 rounded-full bg-elevated px-4 text-sm font-semibold hover:bg-hover disabled:opacity-40">
                {busy ? "Importing…" : `Add these ${candidates.length} songs to Liked songs`}
              </button>
              <MusicTrackList playAsQueue entries={candidates.map((track) => ({ key: track.id, track }))}
                actions={(_, track) => (
                  <button type="button" disabled={busy || !tracks} onClick={() => void importSongs([track.id])}
                    aria-label={`Add ${track.title} to Liked songs`}
                    className="min-h-11 rounded-full px-3 text-sm text-muted hover:bg-hover hover:text-fg disabled:opacity-40">
                    Like
                  </button>
                )} />
              {!candidates.length && <p className="py-4 text-sm text-muted">No remaining favorites on this page.</p>}
              <nav aria-label="Previously imported favorites pages" className="mt-4 flex flex-wrap items-center gap-3">
                <button type="button" disabled={busy || pageCursors.length === 1}
                  onClick={() => void loadImportPage(pageCursors.slice(0, -1))}
                  className="min-h-11 rounded-full bg-elevated px-4 text-sm font-semibold hover:bg-hover disabled:opacity-40">
                  Previous
                </button>
                <span className="text-sm text-muted" role="status">Page {pageCursors.length}</span>
                <button type="button" disabled={busy || !importPage.nextCursor}
                  onClick={() => void loadImportPage([...pageCursors, importPage.nextCursor])}
                  className="min-h-11 rounded-full bg-elevated px-4 text-sm font-semibold hover:bg-hover disabled:opacity-40">
                  Next
                </button>
              </nav>
            </details>
          )}
    </section>
  );
}
