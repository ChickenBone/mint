import type { TrackView } from "@mint/core/events";
import clsx from "clsx";
import { Artwork } from "../artwork";

/**
 * Big app header. `backdrop` blurs a real cover into the header wash so every page takes its
 * colour from the music on it rather than a fixed gradient.
 */
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
    <div className={clsx("relative isolate -mx-6 -mt-14 flex flex-col gap-6 overflow-hidden px-6 pt-20 pb-8 sm:flex-row sm:items-end", className)}>
      {backdrop && (
        <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
          <img src={backdrop} alt="" referrerPolicy="no-referrer" className="size-full scale-125 object-cover opacity-55 blur-3xl saturate-150" />
          <div className="absolute inset-0 bg-gradient-to-b from-surface/30 via-surface/70 to-surface" />
        </div>
      )}
      {art}
      <div className="min-w-0 flex-1">
        <h1 className="text-4xl leading-[0.95] font-extrabold tracking-[-0.035em] sm:text-7xl">{title}</h1>
        {sub && <div className="mt-4 text-muted">{sub}</div>}
        {children && <div className="mt-6">{children}</div>}
      </div>
    </div>
  );
}

/** Four real covers tiled into one, like a generated playlist cover. Falls back to `fallback`. */
export function CoverMosaic({ tracks, fallback }: { tracks: TrackView[]; fallback: React.ReactNode }) {
  // One tile per distinct cover, so a liked album doesn't fill the whole mosaic.
  const covers = [...new Map(tracks.filter((t) => t.artworkUrl).map((t) => [t.artworkUrl, t])).values()].slice(0, 4);
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
