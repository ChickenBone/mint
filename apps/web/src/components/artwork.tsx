import type { TrackView } from "@mint/core/events";
import clsx from "clsx";
import { Music2 } from "lucide-react";

/** Square cover art served from the preview volume; falls back to a quiet tile. */
export function Artwork({ track, className }: { track: Pick<TrackView, "id" | "hasArtwork" | "album" | "title">; className?: string; sizes?: string }) {
  return (
    <div className={clsx("relative aspect-square shrink-0 overflow-hidden rounded-md bg-elevated", className)}>
      {track.hasArtwork ? (
        <img
          src={`/api/art/${track.id}`}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
        />
      ) : (
        <div className="grid size-full place-items-center text-faint">
          <Music2 className="size-1/3" aria-hidden />
        </div>
      )}
    </div>
  );
}
