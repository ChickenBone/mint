import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@mint/core/db";
import { spotifyPlaylistView, spotifyPlayableQuery } from "@mint/core/spotify-store";
import { requireUser } from "@/lib/auth";
import { timeAgo } from "@/lib/format";
import { PageHeader } from "@/components/app/page-header";
import { CollectionActions } from "@/components/app/collection-actions";
import { SpotifyCopyButton, SpotifyPlaylistToggle } from "@/components/app/spotify-controls";

export const dynamic = "force-dynamic";
export default async function SpotifySourcePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }>;
}) {
  const user = await requireUser(), { id } = await params, sp = await searchParams;
  const n = Number(sp.page ?? 0), page = Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 99) : 0;
  const db = getDb();
  const [view, playback] = await Promise.all([spotifyPlaylistView(db, user.id, id, page), spotifyPlayableQuery(db, user.id, id)]);
  if (!view || !playback) notFound();
  const { playlist, items } = view;
  return <>
    <Link href="/app/spotify" className="mb-7 inline-flex min-h-11 items-center text-sm text-muted hover:text-fg">Back to Spotify playlists</Link>
    <PageHeader className="[&_h1]:break-words" title={playlist.title} sub={`${playback.total} locally playable · ${playlist.sourceTotal} source items · Last synced ${timeAgo(playlist.lastSyncedAt)}`}>
      <CollectionActions collection={{ kind: "spotify", id }} empty={!playback.total} label="local matches" />
    </PageHeader>
    <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
      <div className="max-w-2xl text-sm text-muted">
        <p>Source order and repeated songs are preserved. Play and Shuffle skip missing, ambiguous and unavailable items; nothing is downloaded.</p>
        <a href={playlist.providerUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-11 items-center text-fg hover:text-mint">Open original on Spotify</a>
      </div>
      <div className="mb-7">
        <SpotifyCopyButton id={id} empty={!playback.total} />
        <p className="mt-2 text-sm text-muted">Create an editable snapshot of up to 5,000 local matches. This source and your Spotify playlist stay unchanged.</p>
      </div>
      <SpotifyPlaylistToggle id={id} enabled={playlist.syncEnabled} title={playlist.title} />
    </div>
    {playlist.error && <p className="mb-6 text-sm text-danger" role="alert">{playlist.error} The last successful snapshot remains below.</p>}
    {!playlist.lastSyncedAt ? <p className="text-muted">Turn sync on, then use Sync now from Spotify playlists. Your source snapshot appears here after the worker finishes.</p> :
      !items.length ? <p className="text-muted">This playlist is empty. Future syncs will keep its contents up to date.</p> :
        <ol start={page * 100 + 1} className="divide-y divide-line">{items.map((item) => <li key={item.id} className="flex items-start gap-3 py-4 sm:gap-5">
          <span className="w-7 shrink-0 pt-0.5 text-right text-sm text-faint tabular">{item.position + 1}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{item.title}</p>
            <p className="mt-1 truncate text-sm text-muted">{item.artists.join(", ") || "Unknown artist"}{item.album ? ` · ${item.album}` : ""}</p>
            <p className="mt-2 text-sm text-muted">{item.reason}</p>
          </div>
          <span className={`shrink-0 rounded-full bg-elevated px-3 py-1 text-xs font-semibold ${item.status === "matched" ? "text-mint" : item.status === "ambiguous" ? "text-warn" : "text-muted"}`}>{item.status}</span>
        </li>)}</ol>}
    <nav aria-label="Playlist items" className="mt-6 flex flex-wrap items-center gap-5">
      {page > 0 && <Link className="inline-flex min-h-11 items-center text-sm hover:text-mint" href={`/app/spotify/${id}?page=${page - 1}`}>Previous 100</Link>}
      {((page + 1) * 100 < playlist.sourceTotal) && <Link className="inline-flex min-h-11 items-center text-sm hover:text-mint" href={`/app/spotify/${id}?page=${page + 1}`}>Next 100</Link>}
    </nav>
  </>;
}
