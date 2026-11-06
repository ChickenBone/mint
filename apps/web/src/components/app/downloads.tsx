"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Download, HardDrive, Trash2, WifiOff, X } from "lucide-react";
import { collectionSchema, type PlayerItem } from "@/lib/player-protocol";
import { loadCollection } from "@/lib/browser-catalog";
import {
  authorizeOffline,
  clearOffline,
  downloadSong,
  listOffline,
  offlineSettings,
  removeOffline,
  saveOfflineCollection,
  setOfflineLimit,
  type OfflineSong,
} from "@/lib/offline";
import { Artwork } from "@/components/artwork";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrackMenuButton, usePlayer } from "./player";
import { ArtistLink } from "./music-links";
import { MusicItem } from "./music-item";

const bytes = (value: number) =>
  value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

export function Downloads({ memberId, embedded = false }: { memberId: string; embedded?: boolean }) {
  const params = useSearchParams();
  const player = usePlayer();
  const [songs, setSongs] = useState<OfflineSong[]>([]);
  const [selected, setSelected] = useState<PlayerItem[] | null>(null);
  const [limit, setLimit] = useState(2 * 1024 ** 3);
  const [expiry, setExpiry] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ title: string; index: number; total: number; bytes: number; size: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [format, setFormat] = useState<"original" | "mp3">("original");
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const isOffline = useSyncExternalStore(subscribeOnline, () => !navigator.onLine, () => false);
  const controller = useRef<AbortController | null>(null);

  const refresh = async () => {
    const [nextSongs, settings] = await Promise.all([listOffline(memberId), offlineSettings()]);
    setSongs(nextSongs);
    setLimit(settings?.limit ?? 2 * 1024 ** 3);
    setExpiry(settings?.grant.expiresAt ?? null);
  };

  useEffect(() => {
    const abort = new AbortController();
    void authorizeOffline(memberId, abort.signal)
      .then(refresh)
      .catch((err: unknown) => {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : "Downloads could not initialize.");
      });
    const changed = () => {
      void refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Downloads could not refresh."));
    };
    window.addEventListener("mint-offline-changed", changed);
    return () => {
      abort.abort();
      controller.current?.abort();
      window.removeEventListener("mint-offline-changed", changed);
    };
    // Account identity is fixed for this member layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  const act = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The download action failed.");
    }
  };

  const select = async () => {
    setBusy(true);
    setError(null);
    setFeedback("");
    const abort = (controller.current = new AbortController());
    try {
      const collection = collectionSchema.parse({
        kind: params.get("kind") ?? "liked",
        id: params.get("id") || undefined,
        query: params.get("q") || undefined,
      });
      const items = await loadCollection(collection, abort.signal);
      setSelected(params.get("track") ? items.filter((item) => item.id === params.get("track")) : items);
    } catch (err) {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : "This collection could not load.");
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!selected?.length) return;
    setBusy(true);
    setError(null);
    setFeedback("");
    const abort = (controller.current = new AbortController());
    const unique = [...new Map(selected.map((item) => [item.id, item])).values()];
    let completed = 0;
    try {
      for (const [index, item] of unique.entries()) {
        abort.signal.throwIfAborted();
        if (songs.some((song) => song.id === item.id)) {
          completed++;
          continue;
        }
        setProgress({ title: item.title, index: index + 1, total: unique.length, bytes: 0, size: null });
        await downloadSong(
          memberId,
          item,
          abort.signal,
          (b, size) => setProgress({ title: item.title, index: index + 1, total: unique.length, bytes: b, size }),
          format,
        );
        completed++;
      }
      setFeedback(`${completed} ${completed === 1 ? "song is" : "songs are"} available offline.`);
    } catch (err) {
      if (abort.signal.aborted) setFeedback(`Download cancelled. ${completed} complete songs remain saved.`);
      else setError(err instanceof Error ? err.message : "Download failed. Completed songs remain saved; retry to continue.");
    } finally {
      try {
        await saveOfflineCollection(memberId, {
          id: new URLSearchParams({
            kind: params.get("kind") ?? "liked",
            id: params.get("id") ?? "",
            q: params.get("q") ?? "",
            track: params.get("track") ?? "",
          }).toString(),
          title:
            params.get("title") ??
            (params.get("track")
              ? selected[0]!.title
              : params.get("kind") === "album"
                ? selected[0]!.album ?? "Saved album"
                : params.get("kind") === "playlist" || params.get("kind") === "spotify"
                  ? "Saved playlist"
                  : params.get("kind") === "library"
                    ? "Saved library"
                    : "YouTube likes"),
          trackIds: selected.map((item) => item.id),
        });
      } catch (err) {
        setError(`Audio files were saved, but their collection could not be stored: ${err instanceof Error ? err.message : "check device storage."}`);
      }
      setBusy(false);
      setProgress(null);
      await refresh();
    }
  };

  const used = songs.reduce((sum, song) => sum + song.bytes, 0);
  const Heading = embedded ? "h2" : "h1";

  return (
    <div className="mx-auto max-w-4xl">
      {isOffline && (
        <div role="status" className="mb-6 flex items-start gap-3 rounded-surface border border-line bg-elevated p-4 text-sm">
          <WifiOff className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <div>
            <p className="font-semibold text-fg">Downloaded-only mode · You are offline</p>
            <p className="mt-1 max-w-prose text-muted">
              Only songs saved on this device can play right now. Reconnect to browse the full catalog or save new music.
            </p>
          </div>
        </div>
      )}

      <Heading className={embedded ? "text-2xl font-bold tracking-tight" : "text-3xl font-extrabold tracking-tight sm:text-5xl"}>
        Take your music with you.
      </Heading>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">
        Save complete songs on this device. Downloads belong to your account, expire after seven days without verification, and are removed when you sign out. Server originals are never modified.
      </p>

      <div className="my-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || isOffline}
          onClick={() => void select()}
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-mint px-5 text-sm font-bold text-mint-ink disabled:opacity-40"
        >
          <Download className="size-4" aria-hidden />
          Choose {params.get("title") ?? params.get("kind") ?? "liked songs"}
        </button>
        {!!songs.length && player && (
          <button
            type="button"
            disabled={!player.ready || player.busy}
            onClick={() => player.command({ action: "items", items: songs.map((s) => s.item) })}
            className="inline-flex min-h-11 items-center rounded-full bg-elevated px-5 py-2.5 text-sm font-semibold hover:bg-hover disabled:opacity-40"
          >
            Play downloaded songs
          </button>
        )}
        <a href="/offline.html" className="inline-flex min-h-11 items-center rounded-full bg-elevated px-5 py-2.5 text-sm font-semibold hover:bg-hover">
          Open offline player
        </a>
        <Link href="/app/settings?section=storage" className="inline-flex min-h-11 items-center px-3 text-sm text-muted hover:text-fg">
          Storage settings
        </Link>
      </div>

      {selected && (
        <div className="mb-6 border-y border-line py-5">
          <p className="font-semibold">
            {selected.length.toLocaleString()} {selected.length === 1 ? "song" : "songs"} selected
          </p>
          <p className="mt-2 max-w-prose text-sm text-muted">
            Already saved songs are skipped. Downloads run one at a time; keep Mint open until finished.
          </p>
          <label className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            Audio format
            <select
              aria-label="Download audio format"
              disabled={busy}
              value={format}
              onChange={(event) => setFormat(event.target.value as "original" | "mp3")}
              className="min-h-11 rounded border border-line bg-elevated px-3"
            >
              <option value="original">Original file</option>
              <option value="mp3">MP3 compatibility · 192 kbps</option>
            </select>
          </label>
          <p className="mt-2 max-w-prose text-xs text-muted">
            If your browser cannot decode an original, remove that device download and save its MP3 compatibility copy instead. Server originals are never changed. Each device file is limited to 512 MB.
          </p>
          <button
            type="button"
            disabled={busy || !selected.length}
            onClick={() => void download()}
            className="mt-4 min-h-11 rounded-full bg-mint px-5 text-sm font-bold text-mint-ink disabled:opacity-40"
          >
            Download selected songs
          </button>
        </div>
      )}

      {busy && (
        <div role="status" className="mb-6 border-b border-line pb-5">
          <p className="font-semibold">
            {progress ? `${progress.index} / ${progress.total} · ${progress.title}` : "Loading selection…"}
          </p>
          {progress && (
            <p className="mt-2 text-sm text-muted tabular">
              {bytes(progress.bytes)}
              {progress.size !== null ? ` / ${bytes(progress.size)}` : ""}
            </p>
          )}
          <button
            type="button"
            onClick={() => controller.current?.abort()}
            className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-4 text-sm"
          >
            <X className="size-4" aria-hidden />
            Cancel
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mb-5 text-sm text-warn">
          {error}
        </p>
      )}
      {feedback && (
        <p role="status" className="mb-5 text-sm text-mint">
          {feedback}
        </p>
      )}

      <section aria-label="Device storage" className="mb-8 border-y border-line py-5">
        <h3 className="flex items-center gap-2 font-semibold">
          <HardDrive className="size-4" aria-hidden />
          Device storage
        </h3>
        <p className="mt-3 text-sm text-muted tabular">
          {bytes(used)} of {bytes(limit)} · {songs.length} saved {songs.length === 1 ? "song" : "songs"}
        </p>
        <label className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          Storage limit
          <select
            aria-label="Download storage limit"
            disabled={busy}
            value={limit}
            onChange={(event) => void act(() => setOfflineLimit(memberId, Number(event.target.value)))}
            className="min-h-11 rounded bg-elevated px-3"
          >
            {[256 * 1024 ** 2, 1024 ** 3, 2 * 1024 ** 3, 5 * 1024 ** 3, 10 * 1024 ** 3, 20 * 1024 ** 3].map((value) => (
              <option key={value} value={value}>
                {bytes(value)}
              </option>
            ))}
          </select>
        </label>
        {expiry && <p className="mt-3 text-xs text-muted">Offline access valid until {new Date(expiry).toLocaleString()}.</p>}
        <button
          type="button"
          disabled={busy || !songs.length}
          onClick={() => setConfirmClearOpen(true)}
          className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm text-danger hover:bg-hover disabled:opacity-40"
        >
          <Trash2 className="size-4" aria-hidden />
          Remove all downloads
        </button>
      </section>

      <ConfirmDialog
        open={confirmClearOpen}
        onOpenChange={setConfirmClearOpen}
        title="Remove all downloaded music?"
        description="This removes all downloaded audio files from this browser device. Your server originals and playlists remain untouched."
        confirmLabel="Remove all downloads"
        loading={busy}
        onConfirm={async () => {
          setConfirmClearOpen(false);
          await act(async () => {
            await clearOffline();
            await authorizeOffline(memberId);
          });
        }}
      />

      <h3 className="mb-4 text-xl font-bold">Downloaded songs</h3>
      {!songs.length ? (
        <p className="max-w-prose py-6 text-sm text-muted">
          Nothing saved yet. Choose liked songs above, or use any song, album or playlist&apos;s Download action before going offline.
        </p>
      ) : (
        <ol className="divide-y divide-line">
          {songs.map((song) => (
            <MusicItem as="li" item={song.item} key={song.id} className="flex flex-wrap items-center gap-3 py-3">
              <Artwork track={{ artworkUrl: song.item.thumb ?? "" }} className="size-11" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{song.item.title}</p>
                <p className="truncate text-xs text-muted">
                  <ArtistLink item={song.item} /> · {bytes(song.bytes)}
                </p>
              </div>
              {player && (
                <button
                  type="button"
                  disabled={!player.ready || player.busy}
                  onClick={() => player.command({ action: "play", item: song.item })}
                  className="min-h-11 rounded-full px-3 text-xs font-semibold text-muted hover:bg-hover hover:text-fg"
                >
                  Play
                </button>
              )}
              <TrackMenuButton item={song.item} />
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove download ${song.item.title}`}
                onClick={() => void act(() => removeOffline(memberId, song.id))}
                className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-danger disabled:opacity-40"
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            </MusicItem>
          ))}
        </ol>
      )}
    </div>
  );
}
