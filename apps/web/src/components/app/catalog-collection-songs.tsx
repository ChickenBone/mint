"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Disc3 } from "lucide-react";
import type { CatalogCollectionAlbum, RecordingSearchItem } from "@/lib/music-requests";
import { playerItemSchema, type PlayerItem } from "@/lib/player-protocol";
import { useRealtime } from "@/components/realtime";
import { ExternalRecording, requestCatalogRecording, type RequestState } from "./global-search";
import { usePlayer } from "./player";

export type CatalogCollection = { items: RecordingSearchItem[]; albums: CatalogCollectionAlbum[] };
type CollectionState = { id: string; data?: CatalogCollection; error?: string };

/** Catalog songs and correlated albums for an artist or album page that the library cannot play yet. */
export function useCatalogCollection(id: string | null) {
  const [state, setState] = useState<CollectionState | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    fetch(`/api/music/search/collection?id=${encodeURIComponent(id)}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The music catalog could not be reached.");
        if (!Array.isArray(body.items)) throw new Error("The music catalog returned an unexpected response.");
        const status = body.catalog?.status;
        const error = status === "not_configured" ? "The search catalog is not configured." :
          status === "unavailable" ? "The search catalog is unavailable. Try again shortly." : undefined;
        setState({ id, data: { items: body.items as RecordingSearchItem[], albums: Array.isArray(body.albums) ? body.albums as CatalogCollectionAlbum[] : [] }, error });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ id, error: error instanceof Error ? error.message : "The music catalog could not be reached." });
      });
    return () => controller.abort();
  }, [id, retry]);
  const current = id && state?.id === id ? state : null;
  return { data: current?.data, error: current?.error, loading: !!id && !current, retry: () => setRetry((count) => count + 1) };
}

export { catalogQueryMatches } from "./catalog-artist-albums";

/** Not-yet-imported catalog songs continuing the page's song list, with like-and-import and import-only actions. */
export function CatalogCollectionRows({ items }: { items: RecordingSearchItem[] }) {
  const player = usePlayer();
  const [requests, setRequests] = useState<Record<string, RequestState>>({});
  const [playable, setPlayable] = useState<Record<string, PlayerItem>>({});

  const hydratePlayable = useCallback(async (trackId: string) => {
    try {
      const response = await fetch("/api/player/items", { method: "POST", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [trackId] }) });
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("items" in body) || !Array.isArray(body.items)) return;
      const item = playerItemSchema.parse(body.items[0]);
      if (item.type === "track" && item.id === trackId) setPlayable((items) => ({ ...items, [trackId]: item }));
    } catch (error) {
      console.error("Catalog song playback lookup failed", error);
    }
  }, []);

  useRealtime((event) => {
    if (event.type !== "track") return;
    const track = event.data;
    setRequests((existing) => {
      const matches = Object.entries(existing).filter(([, request]) => request.trackId === track.id);
      if (!matches.length) return existing;
      const next = { ...existing };
      for (const [recordingId, request] of matches) next[recordingId] = { trackId: track.id, stage: track.stage, progress: track.progress,
        liked: request.liked, error: track.stage === "failed" ? "Couldn’t add this song." : null };
      return next;
    });
    if (track.stage === "ready" || track.stage === "analyzing") void hydratePlayable(track.id);
  });

  const add = async (item: RecordingSearchItem, youtubeUrl?: string, like = false) => {
    const previous = requests[item.id];
    if (previous && previous.stage !== "failed" && (!like || previous.liked)) return;
    setRequests((existing) => ({ ...existing, [item.id]: { trackId: previous?.trackId || item.existing?.id || "",
      stage: previous && previous.stage !== "failed" ? previous.stage : "matching", progress: previous?.progress ?? 0, error: null, liked: like || previous?.liked } }));
    try {
      const body = await requestCatalogRecording(item.token, youtubeUrl, like);
      setRequests((existing) => ({ ...existing, [item.id]: { trackId: body.trackId, stage: body.stage, progress: 0, error: null, liked: like || previous?.liked } }));
      if (body.stage === "ready" || body.stage === "analyzing") void hydratePlayable(body.trackId);
    } catch (error) {
      console.error("Catalog song request failed", error);
      setRequests((existing) => ({ ...existing, [item.id]: { trackId: item.existing?.id ?? "", stage: "failed", progress: 0,
        error: "Couldn’t add this song. Try again.", liked: previous?.liked } }));
    }
  };

  if (!items.length) return null;
  return <ul aria-label="Songs not imported yet">{items.map((item) => <ExternalRecording key={item.id} item={item} request={requests[item.id]}
    playable={playable[item.existing?.id ?? ""] ?? playable[requests[item.id]?.trackId ?? ""]}
    busy={false} playDisabled={!player?.ready || !!player?.busy}
    onPlay={(target) => { if (player) void player.command({ action: "play", item: target }); }}
    onAdd={(youtubeUrl, like) => void add(item, youtubeUrl, like)} />)}</ul>;
}

/** Catalog albums the library has nothing from yet; each opens the album page to like or import its songs. */
export function CatalogAlbumCards({ albums, renderActions }: {
  albums: CatalogCollectionAlbum[]; renderActions?(album: CatalogCollectionAlbum): ReactNode;
}) {
  return <>{albums.map((album) => {
    const href = `/app/library/albums/${encodeURIComponent(album.id)}?type=track`;
    return <article key={album.id} className="min-w-0 rounded-lg p-3 transition-colors hover:bg-surface focus-within:bg-surface">
      <Link href={href} className="block rounded-md" aria-label={`${album.title}, not imported yet`}>
        <span className="grid aspect-square w-full place-items-center rounded-md bg-elevated text-muted shadow-raised"><Disc3 className="size-10" aria-hidden /></span>
      </Link>
      <div className="mt-3 min-w-0">
        <h3 className="truncate font-semibold"><Link href={href} tabIndex={-1} className="hover:underline">{album.title}</Link></h3>
        <p className="mt-1 truncate text-sm text-muted">Not imported yet</p>
        {renderActions?.(album)}
      </div>
    </article>;
  })}</>;
}
