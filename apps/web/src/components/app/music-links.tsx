import React from "react";
import Link from "next/link";
import { albumPlayerId, artistPlayerId, type PlayerItem } from "@/lib/player-protocol";

export function ArtistLink({ item }: { item: Pick<PlayerItem, "artist" | "artistId"> }) {
  if (!item.artist) return null;
  return <Link href={`/app/library/artists/${encodeURIComponent(item.artistId ?? artistPlayerId(item.artist))}?type=album`}
    className="rounded-sm hover:text-fg hover:underline">{item.artist}</Link>;
}

export function AlbumLink({ item }: { item: Pick<PlayerItem, "artist" | "album" | "albumId"> }) {
  if (!item.album) return <>Single</>;
  if (!item.albumId && !item.artist) return <>{item.album}</>;
  return <Link href={`/app/library/albums/${encodeURIComponent(item.albumId ?? albumPlayerId(item.artist!, item.album))}?type=track`}
    className="rounded-sm hover:text-fg hover:underline">{item.album}</Link>;
}
