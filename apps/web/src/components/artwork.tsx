"use client";

import type { TrackView } from "@mint/core/events";
import clsx from "clsx";
import { Music2 } from "lucide-react";
import { useState } from "react";

/** Plex-first library artwork (or an explicit playlist cover); unavailable art gets a quiet tile. */
export function Artwork({ track, className, eager }: { track: Pick<TrackView, "artworkUrl">; className?: string; eager?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = track.artworkUrl && failed !== track.artworkUrl ? track.artworkUrl : null;
  return (
    <div className={clsx("relative aspect-square shrink-0 overflow-hidden rounded-md bg-elevated", className)}>
      {src ? (
        <img
          src={src}
          alt=""
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
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
