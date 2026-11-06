import type { TrackView } from "@mint/core/events";
import clsx from "clsx";
import * as React from "react";
import { Artwork, ArtworkAtmosphere } from "../artwork";

export function PageHeader({
  title,
  sub,
  children,
  art,
  backdrop,
  className,
}: {
  title: string;
  sub?: React.ReactNode;
  children?: React.ReactNode;
  art?: React.ReactNode;
  backdrop?: string | null;
  className?: string;
}) {
  return (
    <div className={clsx("page-heading mb-10 flex flex-col gap-7 pt-3 sm:flex-row sm:items-end", backdrop && "music-atmosphere", className)} data-artwork={backdrop ? "present" : undefined}>
      {backdrop && <ArtworkAtmosphere src={backdrop} />}
      {art}
      <div className="min-w-0 flex-1">
        <h1 className="text-4xl leading-[1.05] font-bold tracking-[-0.035em] sm:text-5xl xl:text-6xl">{title}</h1>
        {sub && <div className="mt-4 max-w-prose text-sm leading-relaxed text-muted">{sub}</div>}
        {children && <div className="mt-5 flex flex-wrap items-center gap-2">{children}</div>}
      </div>
    </div>
  );
}

/** Four real covers tiled into one, like a generated playlist cover. Falls back to `fallback`. */
export function CoverMosaic({ tracks, fallback }: { tracks: TrackView[]; fallback: React.ReactNode }) {
  // One tile per distinct cover, so a liked album doesn't fill the whole mosaic.
  const covers = [...new Map(tracks.filter((t) => t.artworkUrl).map((t) => [
    t.album ? JSON.stringify([t.artist, t.album]) : t.artworkUrl, t,
  ])).values()].slice(0, 4);
  return (
    <div className="size-40 shrink-0 overflow-hidden rounded-lg shadow-[0_24px_60px_-18px_rgb(0_0_0/0.9)] sm:size-56">
      {covers.length === 4 ? (
        <div className="grid size-full grid-cols-2">
          {covers.map((t) => (
            <Artwork key={t.id} track={t} eager className="size-full rounded-none" />
          ))}
        </div>
      ) : (
        fallback
      )}
    </div>
  );
}

export const firstCover = (tracks: TrackView[]) => tracks.find((t) => t.artworkUrl && (t.stage === "ready" || t.stage === "analyzing"))?.artworkUrl ?? null;
