"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addSpotifyPlaylist, copySpotifyToMint, selectSpotifyPlaylist, syncSpotifyNow, unlinkSpotify } from "@/app/actions/spotify";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { musicRequest } from "@/lib/music-client";

const button = "inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold ring-1 ring-line hover:bg-hover disabled:cursor-wait disabled:opacity-50";

export function SpotifyAccountControls() {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ error?: string; success?: string }>({});
  const [confirmDisconnectOpen, setConfirmDisconnectOpen] = useState(false);

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={`${button} bg-mint text-mint-ink hover:bg-mint-strong`}
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                const result = await syncSpotifyNow();
                setMessage(result.error ? result : { success: "Sync queued. Refresh this page in a moment to see the result." });
              } catch {
                setMessage({ error: "Could not queue a sync. Try again shortly." });
              }
            })
          }
        >
          {pending ? "Working…" : "Sync now"}
        </button>
        <a className={button} href="/api/oauth/spotify/start">
          Reconnect
        </a>
        <button
          type="button"
          className={`${button} text-danger`}
          disabled={pending}
          onClick={() => setConfirmDisconnectOpen(true)}
        >
          Disconnect
        </button>
      </div>
      <ConfirmDialog
        open={confirmDisconnectOpen}
        onOpenChange={setConfirmDisconnectOpen}
        title="Disconnect Spotify?"
        description="Mint will remove your Spotify account tokens and playlist snapshots. Local music files stay untouched. You can also remove Mint in Spotify account permissions."
        confirmLabel="Disconnect Spotify"
        loading={pending}
        onConfirm={() => {
          setConfirmDisconnectOpen(false);
          start(async () => {
            try {
              await unlinkSpotify();
            } catch {
              setMessage({ error: "Disconnect failed. Try again." });
            }
          });
        }}
      />
      {message.error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {message.error}
        </p>
      )}
      {message.success && (
        <p role="status" className="mt-3 text-sm text-muted">
          {message.success}
        </p>
      )}
    </div>
  );
}

export function SpotifyImportForm() {
  const [state, action, pending] = useActionState(addSpotifyPlaylist, {});
  return (
    <form action={action} className="max-w-2xl">
      <label htmlFor="spotify-playlist" className="mb-2 block font-semibold">
        Add a Spotify playlist link
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          id="spotify-playlist"
          name="playlist"
          required
          maxLength={2048}
          placeholder="https://open.spotify.com/playlist/…"
          className="min-h-11 min-w-0 flex-1 rounded-lg bg-elevated px-4 py-2 text-sm ring-1 ring-line placeholder:text-faint focus-visible:outline-2 focus-visible:outline-mint"
        />
        <button type="submit" disabled={pending} className={button}>
          {pending ? "Checking access…" : "Add playlist"}
        </button>
      </div>
      <p className="mt-2 max-w-prose text-sm text-muted">
        Read-only metadata sync. Only confident local library matches can play. Missing songs never start downloads.
      </p>
      {state.error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="mt-3 text-sm text-muted">
          {state.success}
        </p>
      )}
    </form>
  );
}

export function SpotifyPlaylistToggle({ id, enabled, title }: { id: string; enabled: boolean; title: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  return (
    <div className="flex shrink-0 flex-col items-end">
      <button
        type="button"
        className={button}
        role="switch"
        aria-checked={enabled}
        aria-label={`Sync ${title}`}
        disabled={pending}
        onClick={() =>
          start(async () => {
            try {
              const result = await selectSpotifyPlaylist(id, !enabled);
              setError(result.error ?? "");
            } catch {
              setError("Could not save your selection. Try again.");
            }
          })
        }
      >
        {pending ? "Saving…" : enabled ? "Sync on" : "Sync off"}
      </button>
      {error && (
        <p role="alert" className="mt-2 max-w-48 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function SpotifyCopyButton({ id, empty }: { id: string; empty: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const router = useRouter();
  return (
    <div>
      <button
        type="button"
        className={button}
        disabled={pending || empty}
        onClick={() =>
          start(async () => {
            try {
              const result = await copySpotifyToMint(id);
              if (result.id) router.push(`/app/collection/${result.id}`);
              else setError(result.error ?? "Could not create a copy.");
            } catch {
              setError("Could not create a copy. Try again.");
            }
          })
        }
      >
        {pending ? "Creating copy…" : "Copy local matches to Mint"}
      </button>
      {error && (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function YouTubeCopyButton({ id, title, empty }: { id: string; title: string; empty: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const router = useRouter();
  return (
    <div>
      <button
        type="button"
        className={button}
        disabled={pending || empty}
        onClick={() =>
          start(async () => {
            try {
              const result = await musicRequest<{ id: string }>("collections", "POST", {
                title: `${title} (Mint copy)`.slice(0, 200),
                sourcePlaylistId: id,
              });
              router.push(`/app/collection/${result.id}`);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not create a copy.");
            }
          })
        }
      >
        {pending ? "Creating copy…" : "Make editable Mint copy"}
      </button>
      {error && (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
