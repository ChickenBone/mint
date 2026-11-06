import Link from "next/link";
import { notFound } from "next/navigation";
import { ListMusic } from "lucide-react";
import { getDb } from "@mint/core/db";
import { MusicError } from "@mint/core/music";
import { UUID } from "@mint/core/playback";
import { spotifyPlayableQuery, spotifyPlaylistView } from "@mint/core/spotify-store";
import { toTrackView } from "@mint/core/views";
import { Badge } from "@/components/ui/primitives";
import { CollectionActions } from "@/components/app/collection-actions";
import { LiveTrackList } from "@/components/app/live-track-list";
import { NativeCollectionEditor } from "@/components/app/native-collection-editor";
import { firstCover, PageHeader } from "@/components/app/page-header";
import { SpotifyCopyButton, YouTubeCopyButton } from "@/components/app/spotify-controls";
import { requireUser } from "@/lib/auth";
import { getPlaylist } from "@/lib/data";
import { formatCount, timeAgo } from "@/lib/format";
import { collectionDetail } from "@/lib/music-store";

export const dynamic = "force-dynamic";

export default async function CollectionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const db = getDb();
  const detail = await collectionDetail(db, user.id, id).catch((error: unknown) => {
    if (error instanceof MusicError && error.status === 404) return null;
    throw error;
  });
  if (detail) {
    return (
      <NativeCollectionEditor
        initial={{
          ...detail,
          entries: detail.entries.map((entry) => ({ ...entry, track: toTrackView(entry.track) })),
        }}
      />
    );
  }

  const imported = await getPlaylist(user.id, id);
  if (imported) {
    const { playlist, tracks } = imported;
    const ready = tracks.filter((track) => ["ready", "analyzing"].includes(track.stage)).length;
    return (
      <section className="mx-auto max-w-6xl">
        <Link href="/app/collection" className="mb-5 inline-flex min-h-11 items-center text-sm text-muted hover:text-fg">
          ← Your Library
        </Link>
        <PageHeader
          title={playlist.title}
          backdrop={playlist.artworkUrl ?? firstCover(tracks)}
          art={
            <div className="relative size-40 shrink-0 overflow-hidden rounded-lg bg-elevated sm:size-52">
              {playlist.artworkUrl ? (
                <img src={playlist.artworkUrl} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
              ) : (
                <ListMusic className="absolute inset-0 m-auto size-16 text-faint" aria-hidden />
              )}
            </div>
          }
          sub={
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">Source-managed import</Badge>
                <span className="text-sm text-muted tabular">
                  {formatCount(ready)} of {formatCount(playlist.itemCount)} playable
                </span>
              </div>
              <p className="max-w-prose text-sm text-muted">
                This saved import is read-only. Make a separate editable copy to reorder or customize its songs.
              </p>
            </div>
          }
        />
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <CollectionActions collection={{ kind: "playlist", id }} empty={!ready} label="playlist" title={playlist.title} />
          <YouTubeCopyButton id={id} title={playlist.title} empty={!tracks.length} />
        </div>
        <LiveTrackList
          initial={tracks}
          collection={{ kind: "playlist", id }}
          empty={<p className="max-w-prose py-12 text-muted">No songs have been imported into this saved playlist yet.</p>}
        />
      </section>
    );
  }

  const sp = await searchParams;
  const requestedPage = Number(sp.page ?? 0);
  const page = Number.isSafeInteger(requestedPage) && requestedPage >= 0 ? Math.min(requestedPage, 99) : 0;
  const [view, playback] = await Promise.all([
    spotifyPlaylistView(db, user.id, id, page),
    spotifyPlayableQuery(db, user.id, id),
  ]);
  if (!view || !playback) notFound();

  const { playlist, items } = view;

  return (
    <section className="mx-auto max-w-6xl">
      <Link href="/app/collection" className="mb-5 inline-flex min-h-11 items-center text-sm text-muted hover:text-fg">
        ← Your Library
      </Link>
      <PageHeader
        className="[&_h1]:break-words"
        title={playlist.title}
        sub={
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">Read-only import</Badge>
              <span className="text-sm text-muted tabular">
                {playback.total} locally playable · {playlist.sourceTotal} source items · Saved {timeAgo(playlist.lastSyncedAt)}
              </span>
            </div>
            <p className="max-w-prose text-sm text-muted">
              Source order and repeated songs are preserved. Make an editable copy to edit local matches.
              Play and Shuffle skip missing, ambiguous and unavailable items; nothing is downloaded automatically.
            </p>
          </div>
        }
      >
        <CollectionActions collection={{ kind: "spotify", id }} empty={!playback.total} label="local matches" title={playlist.title} />
      </PageHeader>
      <div className="mb-7 flex flex-wrap items-center gap-3">
        <SpotifyCopyButton id={id} empty={!playback.total} />
        <a href={playlist.providerUrl} target="_blank" rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center rounded-full bg-elevated px-4 text-sm font-semibold text-fg hover:bg-hover">
          Open original playlist
        </a>
      </div>
      {playlist.error && (
        <p className="mb-6 text-sm text-danger" role="alert">
          {playlist.error} The last successful snapshot remains below.
        </p>
      )}
      {!items.length ? (
        <p className="max-w-prose text-muted">
          {playlist.lastSyncedAt ? "There are no saved items on this page." : "No playlist snapshot has been imported yet."}
        </p>
      ) : (
        <ol start={page * 100 + 1} className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 py-4 sm:gap-5">
              <span className="w-7 shrink-0 pt-0.5 text-right text-sm text-faint tabular">{item.position + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{item.title}</p>
                <p className="mt-1 truncate text-sm text-muted">
                  {item.artists.join(", ") || "Unknown artist"}
                  {item.album ? ` · ${item.album}` : ""}
                </p>
                <p className="mt-2 text-sm text-muted">{item.reason}</p>
              </div>
              <Badge tone={item.status === "matched" ? "positive" : item.status === "ambiguous" ? "warning" : "neutral"} className="shrink-0">
                {item.status}
              </Badge>
            </li>
          ))}
        </ol>
      )}
      <nav aria-label="Playlist items" className="mt-6 flex flex-wrap items-center gap-5">
        {page > 0 && (
          <Link className="inline-flex min-h-11 items-center text-sm hover:text-mint" href={`/app/collection/${id}?page=${page - 1}`}>
            Previous 100
          </Link>
        )}
        {(page + 1) * 100 < playlist.sourceTotal && (
          <Link className="inline-flex min-h-11 items-center text-sm hover:text-mint" href={`/app/collection/${id}?page=${page + 1}`}>
            Next 100
          </Link>
        )}
      </nav>
    </section>
  );
}
