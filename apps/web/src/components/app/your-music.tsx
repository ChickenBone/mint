"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { TrackView } from "@mint/core/events";
import {
  AlertTriangle,
  CheckCircle2,
  Folder,
  Heart,
  ListMusic,
  PauseCircle,
  Pin,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Artwork } from "@/components/artwork";
import { Badge, Button, EmptyState, ProgressBar } from "@/components/ui/primitives";
import { Dialog, Tabs } from "@/components/ui/interactive";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  resolveCollectionTab,
  resolvePlaylistSource,
  type CollectionTab,
  type PlaylistSourceFilter,
} from "@/lib/app-routes";
import { musicRequest, type CollectionList } from "@/lib/music-client";
import { CollectionActions } from "./collection-actions";
import { Downloads } from "./downloads";
import { LinkYoutubeCallout } from "./link-youtube";
import { ListeningHistory } from "./listening-history";
import { LiveTrackList } from "./live-track-list";
import { NativeLikes } from "./native-likes";
import { PageHeader } from "./page-header";
import { PlaylistToggle } from "./playlist-toggle";
import { SpotifyPlaylistToggle } from "./spotify-controls";

export interface YouTubePlaylistSummary {
  id: string;
  title: string;
  itemCount: number;
  readyCount: number;
  syncEnabled: boolean;
  artworkUrl: string | null;
}

export interface SpotifyPlaylistSummary {
  id: string;
  title: string;
  sourceTotal: number;
  matchedTotal: number;
  syncEnabled: boolean;
  status: string;
  error: string | null;
  lastSyncedAt: string | null;
}

export interface HistoryInitialData {
  entries: Array<{
    event: { id: string; createdAt: string; listenedMs: number; completed: boolean };
    track: TrackView;
  }>;
  privateSession: boolean;
  excluded: TrackView[];
}

const inputClass = "min-h-11 w-full rounded-md bg-elevated px-3 py-2 text-sm ring-1 ring-line focus:ring-mint";
const pillButton = "inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-4 py-2 text-sm font-semibold hover:bg-hover disabled:opacity-40";

export function YourMusic({
  memberId,
  initialCollections,
  youtubePlaylists,
  spotifyPlaylists,
  youtubeLinked,
  spotifyLinked,
  likedTracks,
  history,
}: {
  memberId: string;
  initialCollections: CollectionList;
  youtubePlaylists: YouTubePlaylistSummary[];
  spotifyPlaylists: SpotifyPlaylistSummary[];
  youtubeLinked: boolean;
  spotifyLinked: boolean;
  likedTracks: TrackView[];
  history: HistoryInitialData;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = resolveCollectionTab(new URLSearchParams(searchParams.toString()));
  const activeSource = resolvePlaylistSource(new URLSearchParams(searchParams.toString()));

  const [data, setData] = useState(initialCollections);
  const [folder, setFolder] = useState("all");
  const [likesFilter, setLikesFilter] = useState<"all" | "mint" | "youtube">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmDeleteFolderOpen, setConfirmDeleteFolderOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => setData(await musicRequest<CollectionList>("collections"));

  const setTab = (nextTab: CollectionTab) => {
    const next = new URLSearchParams(searchParams.toString());
    if (nextTab === "playlists") {
      next.delete("tab");
      next.delete("kind");
      next.delete("track");
      next.delete("title");
    } else {
      next.set("tab", nextTab);
    }
    const query = next.toString();
    router.replace(query ? `/app/collection?${query}` : "/app/collection", { scroll: false });
  };

  const setSourceFilter = (nextSource: PlaylistSourceFilter) => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("tab");
    if (nextSource === "all") next.delete("source");
    else next.set("source", nextSource);
    const query = next.toString();
    router.replace(query ? `/app/collection?${query}` : "/app/collection", { scroll: false });
  };

  const mintPlaylists = data.collections.filter(
    (p) => !p.rules && (folder === "all" || (folder === "unfiled" ? !p.folderId : p.folderId === folder)),
  );
  const smartPlaylists = data.collections.filter(
    (p) => Boolean(p.rules) && (folder === "all" || (folder === "unfiled" ? !p.folderId : p.folderId === folder)),
  );

  const showMint = activeSource === "all" || activeSource === "mint";
  const showSmart = activeSource === "all" || activeSource === "smart";
  const showYouTube = activeSource === "all" || activeSource === "youtube";
  const showSpotify = activeSource === "all" || activeSource === "spotify";

  const totalVisiblePlaylists =
    (showMint ? mintPlaylists.length : 0) +
    (showSmart ? smartPlaylists.length : 0) +
    (showYouTube ? youtubePlaylists.length : 0) +
    (showSpotify ? spotifyPlaylists.length : 0);

  const readyLiked = likedTracks.filter((t) => t.stage === "ready" || t.stage === "analyzing");
  const inFlightLiked = likedTracks.filter((t) => t.stage !== "ready" && t.stage !== "analyzing" && t.stage !== "failed");

  const playlistsContent = (
    <div className="pt-6">
      {!!data.invitations.length && (
        <section className="mb-6 rounded-surface border border-line bg-elevated/60 p-5" aria-label="Playlist invitations">
          <h2 className="text-lg font-bold">Collaboration invitations</h2>
          {data.invitations.map((invite) => (
            <div key={invite.id} className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p>
                <span className="font-semibold">{invite.title}</span>
                <span className="ml-2 text-sm text-muted">from {invite.owner}</span>
              </p>
              <div className="flex gap-2">
                {([true, false] as const).map((accept) => (
                  <button
                    key={String(accept)}
                    type="button"
                    disabled={busy}
                    className={pillButton}
                    onClick={() =>
                      void run(async () => {
                        await musicRequest(`collections/${invite.id}/invitation`, "POST", { accept });
                        await reload();
                      })
                    }
                  >
                    {accept ? "Accept editor invitation" : "Decline"}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div role="group" aria-label="Filter playlists by source" className="flex flex-wrap gap-2">
          {(
            [
              ["all", `All (${data.collections.length + youtubePlaylists.length + spotifyPlaylists.length})`],
              ["mint", `Mint (${data.collections.filter((p) => !p.rules).length})`],
              ["youtube", `YouTube (${youtubePlaylists.length})`],
              ["spotify", `Spotify (${spotifyPlaylists.length})`],
              ["smart", `Smart (${data.collections.filter((p) => Boolean(p.rules)).length})`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={activeSource === value}
              onClick={() => setSourceFilter(value)}
              className={`min-h-11 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                activeSource === value ? "bg-fg text-bg" : "bg-elevated text-muted hover:bg-hover hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {(showMint || showSmart) && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-semibold text-muted">
              Folder
              <select
                aria-label="Filter by folder"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                className={`${inputClass} mt-1 min-w-36`}
              >
                <option value="all">All folders</option>
                <option value="unfiled">Unfiled</option>
                {data.folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.title}
                  </option>
                ))}
              </select>
            </label>
            <form
              className="flex min-w-0 flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const title = new FormData(form).get("title");
                void run(async () => {
                  await musicRequest("folders", "POST", { title });
                  form.reset();
                  await reload();
                });
              }}
            >
              <label className="sr-only" htmlFor="folder-title">
                New folder name
              </label>
              <input
                id="folder-title"
                name="title"
                required
                maxLength={100}
                className={`${inputClass} w-36`}
                placeholder="New folder"
              />
              <button type="submit" disabled={busy} className={pillButton}>
                Create folder
              </button>
            </form>
            {folder !== "all" && folder !== "unfiled" && (
              <button
                type="button"
                className={`${pillButton} text-danger`}
                disabled={busy}
                onClick={() => setConfirmDeleteFolderOpen(true)}
              >
                Delete folder
              </button>
            )}
          </div>
        )}
      </div>

      {folder !== "all" && folder !== "unfiled" && (
        <form
          key={folder}
          className="mb-6 flex min-w-0 flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const title = new FormData(e.currentTarget).get("title");
            void run(async () => {
              await musicRequest(`folders/${folder}`, "PATCH", { title });
              await reload();
            });
          }}
        >
          <label className="text-sm text-muted">
            Folder name
            <input
              name="title"
              defaultValue={data.folders.find((f) => f.id === folder)?.title}
              required
              maxLength={100}
              className={`${inputClass} mt-2 w-52`}
            />
          </label>
          <button type="submit" className={pillButton} disabled={busy}>
            Rename folder
          </button>
        </form>
      )}

      <ConfirmDialog
        open={confirmDeleteFolderOpen}
        onOpenChange={setConfirmDeleteFolderOpen}
        title="Delete this folder?"
        description="Its playlists will remain in Your music as unfiled playlists."
        confirmLabel="Delete folder"
        loading={busy}
        onConfirm={async () => {
          setConfirmDeleteFolderOpen(false);
          await run(async () => {
            await musicRequest(`folders/${folder}`, "DELETE");
            setFolder("all");
            await reload();
          });
        }}
      />

      {error && (
        <p role="alert" className="mb-5 text-sm text-warn">
          {error}
        </p>
      )}

      {activeSource === "youtube" && !youtubeLinked ? (
        <EmptyState
          title="YouTube Music is not connected."
          action={
            <Link
              href="/app/settings?section=services"
              className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong"
            >
              Connect YouTube Music
            </Link>
          }
        >
          Connect your Google account in Settings to bring your YouTube Music playlists and liked songs into Mint.
        </EmptyState>
      ) : activeSource === "spotify" && !spotifyLinked ? (
        <EmptyState
          title="Spotify is not connected."
          action={
            <Link
              href="/app/settings?section=services"
              className="inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong"
            >
              Connect Spotify
            </Link>
          }
        >
          Connect Spotify in Settings for read-only playlist metadata matched against your local library.
        </EmptyState>
      ) : totalVisiblePlaylists === 0 ? (
        <EmptyState
          title="Make room for your next favorite."
          action={
            <div className="flex flex-wrap justify-center gap-3">
              <Button type="button" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden />
                New playlist
              </Button>
              {(!youtubeLinked || !spotifyLinked) && (
                <Link
                  href="/app/settings?section=services"
                  className="inline-flex min-h-11 items-center rounded-full bg-elevated px-5 text-sm font-semibold hover:bg-hover"
                >
                  Connect a service
                </Link>
              )}
            </div>
          }
        >
          Create a Mint playlist or smart playlist, or connect YouTube Music or Spotify in Settings.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line/60" aria-label="Unified playlists">
          {[...(showMint ? mintPlaylists : []), ...(showSmart ? smartPlaylists : [])].map((p) => (
            <li key={`mint-${p.id}`} className="flex flex-wrap items-center gap-3 py-4">
              <Link className="flex min-w-0 flex-1 items-center gap-4" href={`/app/collection/${p.id}`}>
                {p.artworkUrl ? (
                  <Artwork track={{ artworkUrl: p.artworkUrl }} className="size-16 shrink-0 rounded" />
                ) : (
                  <span className="grid size-16 shrink-0 place-items-center rounded bg-elevated text-faint">
                    <ListMusic className="size-6" aria-hidden />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-bold hover:underline">{p.title}</span>
                    <Badge tone="neutral">{p.rules ? "Smart" : "Mint"}</Badge>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted">
                    {p.rules ? (
                      <>
                        <Sparkles className="size-3.5 shrink-0 text-mint" aria-hidden />
                        <span>Smart rules · {p.role === "owner" ? "Owner" : "Editor"}</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="size-3.5 shrink-0 text-mint" aria-hidden />
                        <span>Saved in Mint · {p.role === "owner" ? "Owner" : "Editor"}</span>
                      </>
                    )}
                  </span>
                </span>
              </Link>
              <button
                type="button"
                className={pillButton}
                disabled={busy}
                aria-label={`${p.pinned ? "Unpin" : "Pin"} ${p.title}`}
                aria-pressed={p.pinned}
                onClick={() =>
                  void run(async () => {
                    await musicRequest(`collections/${p.id}/organization`, "PATCH", {
                      pinned: !p.pinned,
                      folderId: p.folderId,
                    });
                    await reload();
                  })
                }
              >
                <Pin className={`size-4 ${p.pinned ? "text-mint" : ""}`} aria-hidden />
              </button>
              <label className="flex items-center gap-2 text-sm text-muted">
                <Folder className="size-4" aria-hidden />
                <span className="sr-only">Folder for {p.title}</span>
                <select
                  className={`${inputClass} max-w-44`}
                  disabled={busy}
                  value={p.folderId ?? ""}
                  onChange={(e) => {
                    const folderId = e.target.value || null;
                    void run(async () => {
                      await musicRequest(`collections/${p.id}/organization`, "PATCH", {
                        pinned: p.pinned,
                        folderId,
                      });
                      await reload();
                    });
                  }}
                >
                  <option value="">Unfiled</option>
                  {data.folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.title}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}

          {showYouTube &&
            youtubePlaylists.map((p) => {
              const bringingIn = p.syncEnabled && p.itemCount > 0 && p.readyCount < p.itemCount;
              return (
                <li key={`yt-${p.id}`} className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <Link className="flex min-w-0 flex-1 items-center gap-4" href={`/app/collection/${p.id}`}>
                    {p.artworkUrl ? (
                      <Artwork track={{ artworkUrl: p.artworkUrl }} className="size-16 shrink-0 rounded" />
                    ) : (
                      <span className="grid size-16 shrink-0 place-items-center rounded bg-elevated text-faint">
                        <ListMusic className="size-6" aria-hidden />
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-bold hover:underline">{p.title}</span>
                        <Badge tone="neutral">YouTube</Badge>
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted tabular">
                        {bringingIn ? (
                          <>
                            <RefreshCw className="size-3.5 shrink-0 text-mint" aria-hidden />
                            <span>
                              Bringing in your music · {p.readyCount} of {p.itemCount} playable
                            </span>
                          </>
                        ) : p.syncEnabled ? (
                          <>
                            <CheckCircle2 className="size-3.5 shrink-0 text-mint" aria-hidden />
                            <span>
                              Synced · {p.readyCount} of {p.itemCount} playable
                            </span>
                          </>
                        ) : (
                          <>
                            <PauseCircle className="size-3.5 shrink-0 text-muted" aria-hidden />
                            <span>Sync off · {p.itemCount} songs</span>
                          </>
                        )}
                      </span>
                    </span>
                  </Link>
                  <PlaylistToggle id={p.id} enabled={p.syncEnabled} label={p.title} />
                </li>
              );
            })}

          {showSpotify &&
            spotifyPlaylists.map((p) => (
              <li key={`sp-${p.id}`} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <Link className="flex min-w-0 flex-1 items-center gap-4" href={`/app/collection/${p.id}`}>
                  <span className="grid size-16 shrink-0 place-items-center rounded bg-elevated text-faint">
                    <ListMusic className="size-6" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-bold hover:underline">{p.title}</span>
                      <Badge tone="neutral">Spotify</Badge>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted tabular">
                      {p.error ? (
                        <>
                          <AlertTriangle className="size-3.5 shrink-0 text-warn" aria-hidden />
                          <span>
                            Needs attention · {p.matchedTotal} of {p.sourceTotal} playable
                          </span>
                        </>
                      ) : p.syncEnabled && p.lastSyncedAt ? (
                        <>
                          <CheckCircle2 className="size-3.5 shrink-0 text-mint" aria-hidden />
                          <span>
                            Synced · {p.matchedTotal} of {p.sourceTotal} playable
                          </span>
                        </>
                      ) : p.syncEnabled ? (
                        <>
                          <RefreshCw className="size-3.5 shrink-0 text-mint" aria-hidden />
                          <span>Bringing in playlist metadata</span>
                        </>
                      ) : (
                        <>
                          <PauseCircle className="size-3.5 shrink-0 text-muted" aria-hidden />
                          <span>
                            Sync off · {p.matchedTotal} of {p.sourceTotal} playable
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                </Link>
                <SpotifyPlaylistToggle id={p.id} enabled={p.syncEnabled} title={p.title} />
              </li>
            ))}
        </ul>
      )}
    </div>
  );

  const likesContent = (
    <div className="space-y-8 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter likes by source" className="flex flex-wrap gap-2">
          {(
            [
              ["all", "All likes"],
              ["mint", "Mint likes"],
              ["youtube", `YouTube Music (${likedTracks.length})`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={likesFilter === value}
              onClick={() => setLikesFilter(value)}
              className={`min-h-11 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                likesFilter === value ? "bg-fg text-bg" : "bg-elevated text-muted hover:bg-hover hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {youtubeLinked && likedTracks.length > 0 && (
        <section
          aria-label="Playable likes progress"
          className="rounded-surface border border-line bg-elevated/60 p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p className="font-semibold text-fg">
              {inFlightLiked.length > 0
                ? `Bringing in your music · ${readyLiked.length} of ${likedTracks.length} playable`
                : `${readyLiked.length} of ${likedTracks.length} playable`}
            </p>
            <span className="text-xs text-muted tabular">
              {inFlightLiked.length > 0 ? `${inFlightLiked.length} on the way` : "Synced from YouTube Music"}
            </span>
          </div>
          <ProgressBar
            className="mt-3"
            label="Playable liked songs"
            value={readyLiked.length}
            max={likedTracks.length}
          />
        </section>
      )}

      {(likesFilter === "all" || likesFilter === "mint") && (
        <div className="border-b border-line pb-8">
          <NativeLikes />
        </div>
      )}

      {(likesFilter === "all" || likesFilter === "youtube") && (
        <section aria-labelledby="youtube-likes-heading">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="youtube-likes-heading" className="text-2xl font-bold">
                YouTube Music likes
              </h2>
              <p className="mt-1 max-w-prose text-sm text-muted">
                Songs you liked on YouTube Music, matched and kept playable in Mint.
              </p>
            </div>
            <CollectionActions
              collection={{ kind: "liked" }}
              empty={!readyLiked.length}
              label="YouTube likes"
              title="YouTube likes"
            />
          </div>
          {!youtubeLinked && <LinkYoutubeCallout />}
          <LiveTrackList
            initial={likedTracks}
            collection={{ kind: "liked" }}
            empty={
              <p className="max-w-prose py-8 text-sm text-muted">
                No synced YouTube likes yet. Like a song in YouTube Music or connect your account in Settings.
              </p>
            }
          />
        </section>
      )}

      <p className="flex items-center gap-2 text-sm text-faint">
        <Heart className="size-4" aria-hidden />
        Mint likes are private to you and never change your connected YouTube Music account.
      </p>
    </div>
  );

  return (
    <section className="mx-auto max-w-6xl">
      <PageHeader
        title="Your music"
        sub="Your playlists, liked songs, offline downloads and listening history in one place."
      >
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" aria-hidden />+ New playlist
        </Button>
      </PageHeader>

      <Dialog open={createOpen} onOpenChange={setCreateOpen} title="Create playlist">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void run(async () => {
              const result = await musicRequest<{ id: string }>("collections", "POST", {
                title: values.get("title"),
                sourcePlaylistId: values.get("source") || undefined,
                rules: values.get("smart") ? { order: "newest", limit: 100 } : null,
              });
              setCreateOpen(false);
              router.push(`/app/collection/${result.id}`);
            });
          }}
        >
          <label className="text-sm font-semibold">
            Playlist name
            <input
              name="title"
              required
              maxLength={200}
              className={`${inputClass} mt-2 font-normal`}
              placeholder="A new shelf"
            />
          </label>
          <label className="text-sm font-semibold">
            Starting point
            <select name="source" className={`${inputClass} mt-2 font-normal`}>
              <option value="">Empty Mint playlist</option>
              {youtubePlaylists.map((s) => (
                <option key={s.id} value={s.id}>
                  Copy: {s.title}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-muted">
            <input name="smart" type="checkbox" className="size-4 accent-mint" />
            Use smart rules instead of fixed songs
          </label>
          <div className="mt-2 flex flex-wrap justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {busy ? "Creating…" : "Create playlist"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Tabs
        label="Your music sections"
        value={activeTab}
        onValueChange={(val) => setTab(val as CollectionTab)}
        tabs={[
          { value: "playlists", label: "Playlists", content: playlistsContent },
          { value: "likes", label: "Likes", content: likesContent },
          {
            value: "downloads",
            label: "Downloads",
            content: (
              <div className="pt-6">
                <Downloads memberId={memberId} embedded />
              </div>
            ),
          },
          {
            value: "history",
            label: "History",
            content: (
              <div className="pt-6">
                <ListeningHistory
                  initialEntries={history.entries}
                  initialPrivate={history.privateSession}
                  initialExcluded={history.excluded}
                  embedded
                />
              </div>
            ),
          },
        ]}
      />
    </section>
  );
}
