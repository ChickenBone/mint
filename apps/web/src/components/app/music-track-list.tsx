"use client";
import type { TrackView } from "@mint/core/events";
import type { ReactNode } from "react";
import { Play } from "lucide-react";
import { Artwork, ArtworkAtmosphere } from "@/components/artwork";
import { formatDuration } from "@/lib/format";
import { trackPlayerItem, type PlayerItem } from "@/lib/player-protocol";
import { TrackMenuButton, usePlayer } from "./player";
import { ArtistLink } from "./music-links";
import { MusicItem } from "./music-item";

export function PlaylistHeader({
  title,
  artworkUrl,
  artwork,
  eyebrow,
  metadata,
  description,
  actions,
}: {
  title: string;
  artworkUrl?: string | null;
  artwork?: ReactNode;
  eyebrow?: ReactNode;
  metadata?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="playlist-heading collection-hero music-atmosphere mb-6">
      {artworkUrl && <ArtworkAtmosphere src={artworkUrl} />}
      <div className="collection-hero-art">
        {artwork ?? <Artwork track={{ artworkUrl: artworkUrl ?? "" }} eager className="size-full rounded-none" />}
      </div>
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="mb-2 flex flex-wrap items-center gap-2">{eyebrow}</div>}
        <h1 className="break-words text-3xl font-extrabold tracking-tight sm:text-5xl">{title}</h1>
        {description && <div className="mt-2 max-w-prose text-sm leading-relaxed text-muted">{description}</div>}
        {metadata && <div className="mt-2 text-sm text-muted">{metadata}</div>}
        {actions && <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function PlaylistTrackList({
  children,
  label = "Playlist tracks",
  start = 1,
  className = "",
}: {
  children: ReactNode;
  label?: string;
  start?: number;
  className?: string;
}) {
  return <ol aria-label={label} start={start} className={`playlist-track-list ${className}`}>{children}</ol>;
}

export function PlaylistTrackRow({
  item,
  title,
  subtitle,
  artworkUrl,
  leading,
  rank,
  duration,
  details,
  actions,
  footer,
  artwork,
  artworkClassName = "",
  className = "",
  availability,
}: {
  item: PlayerItem | null;
  title: ReactNode;
  subtitle?: ReactNode;
  artworkUrl?: string | null;
  artwork?: ReactNode;
  artworkClassName?: string;
  leading?: ReactNode;
  rank?: number;
  duration?: ReactNode;
  details?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  className?: string;
  availability?: string;
}) {
  return (
    <MusicItem as="li" item={item} data-availability={availability} className={`playlist-track-row group ${className}`}>
      <span className="playlist-track-leading">{leading ?? (rank !== undefined ? rank : null)}</span>
      <div className={`playlist-track-art ${artworkClassName}`}>
        {artwork ?? <Artwork track={{ artworkUrl: artworkUrl ?? "" }} className="size-full rounded" />}
      </div>
      <div className="playlist-track-content">
        <div className="min-w-0">
          <div className="truncate font-semibold">{title}</div>
          {subtitle && <div className="truncate text-sm text-muted">{subtitle}</div>}
        </div>
        {details && <div className="playlist-track-details">{details}</div>}
      </div>
      {duration && <div className="playlist-track-duration">{duration}</div>}
      {actions && <div className="playlist-track-actions">{actions}</div>}
      {footer && <div className="playlist-track-footer">{footer}</div>}
    </MusicItem>
  );
}

/** Entry identities, rather than track identities, keep intentional playlist duplicates distinct. */
export function MusicTrackList({ entries, actions, playAsQueue = false }: {
  entries: { key: string; track: TrackView; reason?: string }[];
  actions?: (key: string, track: TrackView, index: number) => React.ReactNode;
  playAsQueue?: boolean;
}) {
  const player = usePlayer();
  const playableEntries = entries.filter((e) => ["ready", "analyzing"].includes(e.track.stage));
  return <PlaylistTrackList>{entries.map(({ key, track, reason }, index) => {
    const item = trackPlayerItem(track), playable = ["ready", "analyzing"].includes(track.stage);
    const play = () => player?.command(playAsQueue ? { action: "items", items: playableEntries.map((e) => ({
      ...trackPlayerItem(e.track), occurrenceId: e.key,
    })), index: playableEntries.findIndex((e) => e.key === key) } : { action: "play", item });
    return <PlaylistTrackRow key={key} item={playable ? item : null}
      leading={<button className="grid size-10 place-items-center rounded-full text-muted hover:bg-elevated hover:text-mint disabled:opacity-40"
        disabled={!player?.ready || !playable} aria-label={`Play ${track.title}`} onClick={play}><Play className="size-4" /></button>}
      artworkUrl={track.artworkUrl}
      title={<button disabled={!player?.ready || !playable} onClick={play}
        className="block max-w-full truncate text-left font-semibold hover:underline disabled:opacity-50">{track.title}</button>}
      subtitle={<ArtistLink item={item} />}
      duration={<span>{formatDuration(track.durationSec)}</span>}
      details={reason && <p>{reason}</p>}
      actions={<><TrackMenuButton item={item} />{actions?.(key, track, index)}</>}
    />;
  })}</PlaylistTrackList>;
}
