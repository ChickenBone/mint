import { ListMusic } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LiveTrackList } from "@/components/app/live-track-list";
import { PageHeader } from "@/components/app/page-header";
import { PlaylistToggle } from "@/components/app/playlist-toggle";
import { requireUser } from "@/lib/auth";
import { getPlaylist } from "@/lib/data";
import { formatCount } from "@/lib/format";

export const metadata: Metadata = { title: "Playlist" };

export default async function PlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const data = await getPlaylist(user.id, id);
  if (!data) notFound();
  const { playlist, tracks } = data;
  const ready = tracks.filter((t) => t.stage === "ready" || t.stage === "analyzing").length;
  return (
    <>
      <PageHeader
        title={playlist.title}
        art={
          <div className="relative size-40 shrink-0 overflow-hidden rounded-lg bg-elevated shadow-[0_20px_50px_-15px_rgb(0_0_0/0.8)] sm:size-52">
            {playlist.artworkUrl ? (
              <img src={playlist.artworkUrl} alt="" className="size-full object-cover" />
            ) : (
              <ListMusic className="absolute inset-0 m-auto size-16 text-faint" aria-hidden />
            )}
          </div>
        }
        sub={
          <p className="tabular">
            YouTube Music playlist · {formatCount(playlist.itemCount)} songs
            {playlist.syncEnabled && <> · {formatCount(ready)} ready in Plexamp</>}
          </p>
        }
      >
        <label className="inline-flex items-center gap-3 text-sm font-semibold">
          <PlaylistToggle id={playlist.id} enabled={playlist.syncEnabled} label={playlist.title} />
          {playlist.syncEnabled ? "Syncing to Plex" : "Sync this playlist to Plex"}
        </label>
      </PageHeader>
      {playlist.syncEnabled ? (
        <LiveTrackList initial={tracks} empty={<p className="py-12 text-muted">The next sync fills this in. It can take a minute.</p>} />
      ) : (
        <p className="max-w-xl text-muted">
          This playlist isn&rsquo;t synced. Turn on sync and Mint downloads every song in it and keeps a matching Plex playlist called{" "}
          <span className="text-fg">Mint · {user.name} · {playlist.title}</span>.
        </p>
      )}
    </>
  );
}
