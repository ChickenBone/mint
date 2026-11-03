"use client";

import clsx from "clsx";
import { Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
import { Artwork } from "./artwork";
import { PREVIEW_SECONDS, usePlayer } from "./player";

export function PlayerBar({ className }: { className?: string }) {
  const p = usePlayer();
  const t = p.current;
  const VolIcon = p.volume === 0 ? VolumeX : p.volume < 0.5 ? Volume1 : Volume2;
  return (
    <div
      className={clsx(
        "grid h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t border-line bg-bg px-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]",
        className,
      )}
      aria-label="Preview player"
      role="region"
    >
      <div className="flex min-w-0 items-center gap-3">
        {t ? (
          <>
            <Artwork track={t} className="size-14" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{t.title}</p>
              <p className="truncate text-xs text-muted">{t.artist}</p>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">Pick any song to hear a 30-second preview.</p>
        )}
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <div className="flex items-center gap-4">
          <button type="button" onClick={p.previous} disabled={!t} aria-label="Previous" className="text-muted transition hover:text-fg disabled:opacity-40">
            <SkipBack className="size-4" fill="currentColor" />
          </button>
          <button
            type="button"
            onClick={() => p.toggle()}
            disabled={!t}
            aria-label={p.playing ? "Pause" : "Play"}
            className="grid size-9 place-items-center rounded-full bg-fg text-bg transition hover:scale-105 disabled:opacity-40"
          >
            {p.playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="size-4 translate-x-px" fill="currentColor" />}
          </button>
          <button type="button" onClick={p.next} disabled={!t} aria-label="Next" className="text-muted transition hover:text-fg disabled:opacity-40">
            <SkipForward className="size-4" fill="currentColor" />
          </button>
        </div>
        <div className="hidden w-full max-w-md items-center gap-2 text-[11px] text-faint tabular md:flex">
          <span className="w-8 text-right">0:{Math.floor(p.time).toString().padStart(2, "0")}</span>
          <input
            type="range"
            min={0}
            max={PREVIEW_SECONDS}
            step={0.1}
            value={p.time}
            onChange={(e) => p.seek(Number(e.target.value))}
            disabled={!t}
            aria-label="Seek"
            className="h-1 flex-1 cursor-pointer accent-mint"
          />
          <span className="w-8">0:30</span>
        </div>
        {p.error && <p className="text-xs text-danger" role="status">{p.error}</p>}
      </div>

      <div className="hidden items-center justify-end gap-2 md:flex">
        <button type="button" onClick={() => p.setVolume(p.volume === 0 ? 0.8 : 0)} aria-label={p.volume === 0 ? "Unmute" : "Mute"} className="text-muted hover:text-fg">
          <VolIcon className="size-4" />
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={p.volume}
          onChange={(e) => p.setVolume(Number(e.target.value))}
          aria-label="Volume"
          className="h-1 w-28 cursor-pointer accent-mint"
        />
      </div>
    </div>
  );
}
