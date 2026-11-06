import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, ListMusic, PauseCircle, RefreshCw } from "lucide-react";
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
import { PlaylistToggle } from "@/components/app/playlist-toggle";
import { SpotifyCopyButton, SpotifyPlaylistToggle, YouTubeCopyButton } from "@/components/app/spotify-controls";
import { requireUser } from "@/lib/auth";
import { getPlaylist } from "@/lib/data";
import { formatCount, timeAgo } from "@/lib/format";
import { collectionDetail } from "@/lib/music-store";

export const dynamic = "force-dynamic";

export default async function UnifiedCollectionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();

  const db = getDb();

  // 1. Native Mint or smart collection
  const nativeDetail = await collectionDetail(db, user.id, id).catch((error: unknown) => {
    if (error instanceof MusicError && error.status === 404) return null;
    throw error;
  });
  if (nativeDetail) {
    return (
      <NativeCollectionEditor
        initial={{
          ...nativeDetail,
          entries: nativeDetail.entries.map((e) => ({ ...e, track: toTrackView(e.track) })),
        }}
      />
    );
  }

  // 2. YouTube imported playlist
  const ytData = await getPlaylist(user.id, id);
  if (ytData) {
    const { playlist, tracks } = ytData;
    const ready = tracks.filter((t) => t.stage === "ready" || t.stage === "analyzing").length;
    const bringingIn = playlist.syncEnabled && playlist.itemCount > 0 && ready < playlist.itemCount;
    return (
      <section className="mx-auto max-w-6xl">
        <Link href="/app/collection" className="mb-5 inline-flex min-h-11 items-center text-sm text-muted hover:text-fg">
          ← Your music
        </Link>
        <PageHeader
          title={playlist.title}
          backdrop={playlist.artworkUrl ?? firstCover(tracks)}
          art={
            <div className="relative size-40 shrink-0 overflow-hidden rounded-lg bg-elevated shadow-[0_24px_60px_-18px_rgb(0_0_0/0.9)] sm:size-52">
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
                <Badge tone="neutral">YouTube</Badge>
                <span className="inline-flex items-center gap-1.5 text-sm text-muted tabular">
                  {bringingIn ? (
                    <>
                      <RefreshCw className="size-4 text-mint" aria-hidden />
                      <span>
                        Bringing in your music · {formatCount(ready)} of {formatCount(playlist.itemCount)} playable
                      </span>
                    </>
                  ) : playlist.syncEnabled ? (
                    <>
                      <CheckCircle2 className="size-4 text-mint" aria-hidden />
                      <span>
                        Synced · {formatCount(ready)} of {formatCount(playlist.itemCount)} playable
                      </span>
                    </>
                  ) : (
                    <>
                      <PauseCircle className="size-4 text-muted" aria-hidden />
                      <span>Sync off · {formatCount(playlist.itemCount)} songs</span>
                    </>
                  )}
                </span>
              </div>
              <p className="max-w-prose text-sm text-muted">
                YouTube imports stay source-managed. Make an editable Mint copy whenever you want to reorder or customize songs.
              </p>
            </div>
          }
        >
          <label className="inline-flex min-h-11 items-center gap-3 text-sm font-semibold">
            <PlaylistToggle id={playlist.id} enabled={playlist.syncEnabled} label={playlist.title} />
            {playlist.syncEnabled ? "Syncing playlist" : "Sync this playlist"}
          </label>
        </PageHeader>
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <CollectionActions
            collection={{ kind: "playlist", id }}
            empty={!ready || !playlist.syncEnabled}
            label="playlist"
            title={playlist.title}
          />
          <YouTubeCopyButton id={playlist.id} title={playlist.title} empty={!ready} />
        </div>
        {playlist.syncEnabled ? (
          <LiveTrackList
            initial={tracks}
            collection={{ kind: "playlist", id }}
            empty={<p className="max-w-prose py-12 text-muted">The next sync fills this in. It can take a minute.</p>}
          />
        ) : (
          <p className="max-w-prose text-muted">
            This playlist isn&rsquo;t synced yet. Turn on sync above and Mint will bring its songs into your library.
          </p>
        )}
      </section>
    );
  }

  // 3. Spotify read-only metadata playlist
  const n = Number(sp.page ?? 0);
  const page = Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 99) : 0;
  const [view, playback] = await Promise.all([
    spotifyPlaylistView(db, user.id, id, page),
    spotifyPlayableQuery(db, user.id, id),
  ]);
  if (!view || !playback) notFound();

  const { playlist, items } = view;
  return (
    <section className="mx-auto max-w-6xl">
      <Link
        href="/app/collection?source=spotify"
        className="mb-5 inline-flex min-h-11 items-center text-sm text-muted hover:text-fg"
      >
        ← Your music
      </Link>
      <PageHeader
        className="[&_h1]:break-words"
        title={playlist.title}
        sub={
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">Spotify</Badge>
              <span className="text-sm text-muted tabular">
                {playback.total} locally playable · {playlist.sourceTotal} source items · Last synced{" "}
                {timeAgo(playlist.lastSyncedAt)}
              </span>
            </div>
            <p className="max-w-prose text-sm text-muted">
              Source order and repeated songs are preserved. Play and Shuffle skip missing, ambiguous and unavailable items; nothing is downloaded automatically.
            </p>
          </div>
        }
      >
        <CollectionActions
          collection={{ kind: "spotify", id }}
          empty={!playback.total}
          label="local matches"
          title={playlist.title}
        />
      </PageHeader>
      <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <SpotifyCopyButton id={id} empty={!playback.total} />
          <a
            href={playlist.providerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center rounded-full bg-elevated px-4 text-sm font-semibold text-fg hover:bg-hover"
          >
            Open original on Spotify
          </a>
        </div>
        <SpotifyPlaylistToggle id={id} enabled={playlist.syncEnabled} title={playlist.title} />
      </div>
      {playlist.error && (
        <p className="mb-6 text-sm text-danger" role="alert">
          {playlist.error} The last successful snapshot remains below.
        </p>
      )}
      {!playlist.lastSyncedAt ? (
        <p className="max-w-prose text-muted">
          Turn sync on, then use Sync now in Connected services. Your source snapshot appears here after the sync completes.
        </p>
      ) : !items.length ? (
        <p className="max-w-prose text-muted">This playlist is empty. Future syncs will keep its contents up to date.</p>
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
              <Badge
                tone={item.status === "matched" ? "positive" : item.status === "ambiguous" ? "warning" : "neutral"}
                className="shrink-0"
              >
                {item.status}
              </Badge>
            </li>
          ))}
        </ol>
      )}
      <nav aria-label="Playlist items" className="mt-6 flex flex-wrap items-center gap-5">
        {page > 0 && (
          <Link
            className="inline-flex min-h-11 items-center text-sm hover:text-mint"
            href={`/app/collection/${id}?page=${page - 1}`}
          >
            Previous 100
          </Link>
        )}
        {(page + 1) * 100 < playlist.sourceTotal && (
          <Link
            className="inline-flex min-h-11 items-center text-sm hover:text-mint"
            href={`/app/collection/${id}?page=${page + 1}`}
          >
            Next 100
          </Link>
        )}
      </nav>
    </section>
  );
}
