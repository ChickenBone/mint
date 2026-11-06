"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { TrackView } from "@mint/core/events";
import type { BacklogFilter } from "@/lib/backlog";
import { filterBacklog } from "@/lib/backlog";
import {
  CheckCircle2,
  Folder,
  ListMusic,
  Pin,
  Plus,
  Sparkles,
} from "lucide-react";
import { Artwork } from "@/components/artwork";
import { Badge, Button, EmptyState } from "@/components/ui/primitives";
import { Dialog, Tabs } from "@/components/ui/interactive";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { resolveCollectionTab, type CollectionTab } from "@/lib/app-routes";
import { musicRequest, type CollectionList } from "@/lib/music-client";
import { Downloads } from "./downloads";
import { ListeningHistory } from "./listening-history";
import { LiveTrackList } from "./live-track-list";
import { NativeLikes } from "./native-likes";
import { MissingMusic } from "./missing-music";
import { PageHeader } from "./page-header";
import { TrackMenuButton } from "./player";
import { MusicItem } from "./music-item";

export interface ImportPlaylistSummary {
  id: string;
  title: string;
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
  importPlaylists,
  history,
  backlogSummary,
  backlogTracks,
  importedLikes,
}: {
  memberId: string;
  initialCollections: CollectionList;
  importPlaylists: ImportPlaylistSummary[];
  history: HistoryInitialData;
  backlogSummary: { total: number; ready: number; active: number; failed: number };
  backlogTracks: TrackView[];
  importedLikes: { tracks: TrackView[]; nextCursor: string | null };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = resolveCollectionTab(new URLSearchParams(searchParams.toString()));

  const [data, setData] = useState(initialCollections);
  const [folder, setFolder] = useState("all");
  const [backlogFilter, setBacklogFilter] = useState<BacklogFilter>("all");
  const [backlogPage, setBacklogPage] = useState(0);
  const [missingQuery, setMissingQuery] = useState("");
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
    next.delete("source");
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

  const playlists = data.collections.filter(
    (p) => folder === "all" || (folder === "unfiled" ? !p.folderId : p.folderId === folder),
  );
  const filteredBacklog = filterBacklog(backlogTracks, backlogFilter);
  const backlogPageCount = Math.max(1, Math.ceil(filteredBacklog.length / 100));
  const pageBacklogTracks = filteredBacklog.slice(backlogPage * 100, backlogPage * 100 + 100);

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

      <details className="mb-6 border-b border-line">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted">
          {folder === "all" ? "Organize playlists" : `Folder: ${folder === "unfiled" ? "Unfiled" : data.folders.find((item) => item.id === folder)?.title ?? "Selected"}`}
        </summary>
      <div className="mb-6 flex flex-wrap items-end gap-2">
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
      </details>

      <ConfirmDialog
        open={confirmDeleteFolderOpen}
        onOpenChange={setConfirmDeleteFolderOpen}
        title="Delete this folder?"
        description="Its playlists will remain in Your Library as unfiled playlists."
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

      {playlists.length === 0 ? (
        <EmptyState
          title={folder === "all" ? "Your playlists start here." : "No playlists in this folder."}
          action={
            <div className="flex flex-wrap justify-center gap-3">
              {folder !== "all" && (
                <Button type="button" variant="secondary" onClick={() => setFolder("all")}>
                  Show all playlists
                </Button>
              )}
              <Button type="button" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden />
                Create playlist
              </Button>
            </div>
          }
        >
          {folder === "all"
            ? "Create a playlist to bring your favorite songs together."
            : "Choose another folder or show all playlists."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line/60" aria-label="Playlists">
          {playlists.map((p) => (
            <MusicItem as="li" item={{ id: p.id, type: "playlist", title: p.title, thumb: p.artworkUrl ?? undefined }} key={p.id} className="flex flex-wrap items-center gap-3 py-4">
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
                    {p.rules && <Badge tone="neutral">Smart playlist</Badge>}
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
                        <span>{p.role === "owner" ? "Playlist" : "Collaborative playlist"}</span>
                      </>
                    )}
                  </span>
                </span>
              </Link>
              <TrackMenuButton item={{ id: p.id, type: "playlist", title: p.title, thumb: p.artworkUrl ?? undefined }} />
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
            </MusicItem>
          ))}
        </ul>
      )}
    </div>
  );

  const likesContent = (
    <div className="pt-6">
      <NativeLikes importedLikes={importedLikes} />
    </div>
  );

  const requestsContent = (
    <div className="pt-6">
      <p className="mb-4 max-w-prose text-sm leading-relaxed text-muted">
        Songs linked to your Mint account, grouped by what can play now and what still needs work.
      </p>
      <div role="group" aria-label="Filter backlog by state" className="mb-5 flex flex-wrap gap-2">
        {([
          ["all", `All songs (${backlogTracks.length})`],
          ["playable", `Playable (${backlogSummary.ready})`],
          ["on-the-way", `On the way (${backlogSummary.active})`],
          ["attention", `Needs attention (${backlogSummary.failed})`],
        ] as const).map(([state, label]) => (
          <button key={state} type="button" aria-pressed={backlogFilter === state} onClick={() => { setBacklogFilter(state); setBacklogPage(0); }}
            className={`min-h-11 rounded-full px-4 text-sm font-semibold ${backlogFilter === state ? "bg-fg text-bg" : "bg-elevated text-muted hover:bg-hover hover:text-fg"}`}>
            {label}
          </button>
        ))}
      </div>
      <LiveTrackList
        key={`${backlogFilter}:${backlogPage}`}
        initial={pageBacklogTracks}
        mode="jobs"
        includePlayable
        empty={
          <div className="py-6">
            <p className="text-sm text-muted">{backlogFilter === "attention" ? "Nothing needs attention." : backlogFilter === "on-the-way" ? "Nothing is on the way right now." : backlogFilter === "playable" ? "No linked songs are playable yet." : "Your Mint-linked songs are up to date."}</p>
            <Link href="#missing-music-search" className="mt-3 inline-flex min-h-11 items-center rounded-full bg-mint px-5 text-sm font-bold text-mint-ink hover:bg-mint-strong">
              Find music to add
            </Link>
          </div>
        }
      />
      {filteredBacklog.length > 100 && <nav aria-label="Backlog pages" className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-sm">
        <p className="text-muted tabular">{backlogPage * 100 + 1}–{Math.min((backlogPage + 1) * 100, filteredBacklog.length)} of {filteredBacklog.length}</p>
        <div className="flex gap-2">
          <button type="button" disabled={backlogPage === 0} onClick={() => setBacklogPage((page) => page - 1)}
            className="min-h-11 rounded-full bg-elevated px-4 font-semibold hover:bg-hover disabled:opacity-40">Previous</button>
          <span className="inline-flex min-h-11 items-center px-2 text-muted">Page {backlogPage + 1} of {backlogPageCount}</span>
          <button type="button" disabled={backlogPage + 1 >= backlogPageCount} onClick={() => setBacklogPage((page) => page + 1)}
            className="min-h-11 rounded-full bg-elevated px-4 font-semibold hover:bg-hover disabled:opacity-40">Next</button>
        </div>
      </nav>}
      {backlogTracks.length >= 500 && <p className="mt-4 text-xs text-faint">Showing the 500 most recently updated songs linked to Mint.</p>}
      <label id="missing-music-search" className="mt-10 block max-w-lg text-sm font-semibold">
        Find a song to add
        <input type="search" value={missingQuery} maxLength={100} onChange={(event) => setMissingQuery(event.target.value)}
          placeholder="Search title and artist"
          className="mt-2 min-h-11 w-full rounded-control bg-elevated px-4 text-fg placeholder:text-faint ring-1 ring-line focus-visible:ring-2 focus-visible:ring-action" />
      </label>
      {missingQuery.trim().length >= 2 && <MissingMusic query={missingQuery.trim()} />}
    </div>
  );

  return (
    <section className="mx-auto max-w-6xl">
      <PageHeader
        title="Your Library"
      >
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" aria-hidden /> Create playlist
        </Button>
        <Link href="/app/library" className={pillButton}>Browse all music</Link>
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
              placeholder="My playlist"
            />
          </label>
          <details className="rounded-control border border-line px-4">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">
              Import or use smart rules
            </summary>
            <div className="grid gap-3 pb-4">
          <label htmlFor="source-playlist" className="text-sm font-semibold">
            YouTube playlist to import (optional)
          </label>
          <select id="source-playlist" name="source" className={`${inputClass} font-normal`}>
            <option value="">Start with an empty playlist</option>
            {importPlaylists.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <p className="max-w-prose text-xs text-muted">
            Imports create a separate editable playlist here, without changing the original.{" "}
            <Link href="/app/settings?section=services" className="text-mint underline underline-offset-2">
              Choose playlists in Settings
            </Link>
          </p>
          <label className="flex min-h-11 items-center gap-2 text-sm text-muted">
            <input name="smart" type="checkbox" className="size-4 accent-mint" />
            Use smart rules instead of fixed songs
          </label>
            </div>
          </details>
          {error && <p role="alert" className="text-sm text-warn">{error}</p>}
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
        label="Your Library sections"
        value={activeTab}
        onValueChange={(val) => setTab(val as CollectionTab)}
        tabs={[
          { value: "playlists", label: "Playlists", content: playlistsContent },
          { value: "likes", label: "Liked songs", content: likesContent },
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
            label: "Recently played",
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
          ...(activeTab === "requests" ? [{ value: "requests", label: "Music requests", content: requestsContent }] : []),
        ]}
      />
      <Link href="/app/collection?tab=requests" className="mt-8 inline-flex min-h-11 items-center text-sm text-muted hover:text-fg">
        Music requests
      </Link>
    </section>
  );
}
