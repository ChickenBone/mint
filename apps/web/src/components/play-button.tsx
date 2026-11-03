"use client";

import type { TrackView } from "@mint/core/events";
import clsx from "clsx";
import { Loader2, Pause, Play } from "lucide-react";
import { usePlayer } from "./player";

export function useIsCurrent(id: string) {
  const p = usePlayer();
  return { isCurrent: p.current?.id === id, playing: p.current?.id === id && p.playing, loading: p.current?.id === id && p.loading };
}

export function PlayButton({
  track,
  context,
  size = "md",
  className,
}: {
  track: TrackView;
  context?: TrackView[];
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const player = usePlayer();
  const { playing, loading } = useIsCurrent(track.id);
  const disabled = !track.hasPreview;
  const Icon = loading ? Loader2 : playing ? Pause : Play;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        player.toggle(track, context);
      }}
      aria-label={disabled ? `No preview yet for ${track.title}` : `${playing ? "Pause" : "Play"} preview of ${track.title}`}
      className={clsx(
        "grid shrink-0 place-items-center rounded-full bg-mint text-mint-ink shadow-[0_8px_20px_-6px_rgb(0_0_0/0.6)] transition duration-200 ease-out-expo hover:scale-105 hover:bg-mint-strong active:scale-95 disabled:cursor-not-allowed disabled:bg-hover disabled:text-faint disabled:shadow-none disabled:hover:scale-100",
        size === "sm" && "size-8",
        size === "md" && "size-11",
        size === "lg" && "size-14",
        className,
      )}
    >
      <Icon
        className={clsx(size === "lg" ? "size-6" : size === "md" ? "size-5" : "size-4", !playing && !loading && "translate-x-px", loading && "animate-spin")}
        fill={loading ? "none" : "currentColor"}
        aria-hidden
      />
    </button>
  );
}
