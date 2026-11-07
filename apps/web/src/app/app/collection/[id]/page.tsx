import Link from "next/link";
import { notFound } from "next/navigation";
import { ListMusic } from "lucide-react";
import { Artwork, ArtworkAtmosphere } from "@/components/artwork";
import { getDb } from "@mint/core/db";
import { MusicError } from "@mint/core/music";
import { UUID } from "@mint/core/playback";
import { spotifyPlayableQuery, spotifyPlaylistView } from "@mint/core/spotify-store";
import { toTrackView } from "@mint/core/views";
import { Badge } from "@/components/ui/primitives";
import { CollectionActions } from "@/components/app/collection-actions";
import { LiveTrackList } from "@/components/app/live-track-list";
import { NativeCollectionEditor } from "@/components/app/native-collection-editor";
import { firstCover } from "@/components/app/page-header";
import { SpotifyCopyButton, YouTubeCopyButton } from "@/components/app/spotify-controls";
import { requireUser } from "@/lib/auth";
import { getPlaylist } from "@/lib/data";
import { formatCount, timeAgo } from "@/lib/format";
import { collectionDetail } from "@/lib/music-store";

export const dynamic = "force-dynamic";

function ImportedPlaylistHeader({
  title,
  artwork,
  backdrop,
  label,
  metadata,
  explanation,
}: {
  title: string;
  artwork?: string | null;
  backdrop?: string | null;
  label: string;
  metadata: string;
  explanation: string;
}) {
  return (
    <header className="playlist-heading collection-hero music-atmosphere mb-6">
      {backdrop && <ArtworkAtmosphere src={backdrop} />}
      <div className="collection-hero-art grid place-items-center bg-elevated">
        {artwork ? (
          <Artwork track={{ artworkUrl: artwork }} eager className="size-full rounded-none" />
        ) : (
          <ListMusic className="size-10 text-faint" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{label}</Badge>
          <span className="text-sm text-muted tabular">{metadata}</span>
        </div>
        <h1 className="break-words text-3xl font-extrabold tracking-tight sm:text-5xl">{title}</h1>
        <details className="mt-2 max-w-prose">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted hover:text-fg">
            About this import
          </summary>
          <p className="pb-2 text-sm leading-relaxed text-muted">{explanation}</p>
        </details>
      </div>
    </header>
  );
}

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
        <ImportedPlaylistHeader
          title={playlist.title}
          label="Source-managed import"
          metadata={`${formatCount(ready)} of ${formatCount(playlist.itemCount)} playable`}
          explanation="This saved import is read-only. Make a separate editable copy to reorder or customize its songs."
          artwork={playlist.artworkUrl}
          backdrop={playlist.artworkUrl ?? firstCover(tracks)}
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
      <ImportedPlaylistHeader
        title={playlist.title}
        label="Read-only import"
        metadata={`${formatCount(playback.total)} locally playable · ${formatCount(playlist.sourceTotal)} source items · Saved ${timeAgo(playlist.lastSyncedAt)}`}
        explanation="Source order and repeated songs are preserved. Make an editable copy to edit local matches. Play and Shuffle skip missing, ambiguous and unavailable items; nothing is downloaded automatically."
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <CollectionActions collection={{ kind: "spotify", id }} empty={!playback.total} label="local matches" title={playlist.title} />
        <div className="flex flex-wrap items-center gap-3">
          <SpotifyCopyButton id={id} empty={!playback.total} />
          <a
            href={playlist.providerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center text-sm font-semibold text-muted underline-offset-4 hover:text-fg hover:underline"
          >
            Open original playlist
          </a>
        </div>
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
