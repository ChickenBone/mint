"use client";

import React, { useState } from "react";
import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from "lucide-react";
import { formatDuration } from "@/lib/format";
import type { PlayerCommand, PlayerState } from "@/lib/player-protocol";

const timestamp = (ms: number) => ms >= 1000 ? formatDuration(Math.floor(ms / 1000)) : "0:00";

export function Transport({ children, label, active, disabled, onClick, className = "inline-flex" }: {
  children: React.ReactNode; label: string; active?: boolean; disabled?: boolean; onClick: () => void; className?: string;
}) {
  return <button type="button" aria-label={label} title={label} aria-pressed={active} disabled={disabled} onClick={onClick}
    className={`relative size-11 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40 [&>svg]:size-5 ${active ? "text-mint" : "text-muted hover:text-fg"} ${className}`}>{children}{active && <span aria-hidden="true" className="absolute bottom-1 size-1 rounded-full bg-mint" />}</button>;
}

export function PlaybackControls({ state, ready, command, expanded = false }: {
  state: PlayerState; ready: boolean; command: (command: PlayerCommand) => void; expanded?: boolean;
}) {
  const disabled = !ready || !state.track;
  return <div className={`flex items-center justify-center ${expanded ? "gap-1 sm:gap-3" : "gap-1"}`}>
    <Transport label="Shuffle" active={state.shuffle} disabled={disabled} onClick={() => command({ action: "shuffle" })} className={expanded ? "inline-flex" : "hidden sm:inline-flex"}><Shuffle /></Transport>
    <Transport label="Previous track" disabled={disabled} onClick={() => command({ action: "previous" })} className={expanded ? "inline-flex" : "hidden sm:inline-flex"}><SkipBack /></Transport>
    <button type="button" aria-label={state.playing ? "Pause" : "Play"} disabled={disabled} onClick={() => command({ action: "toggle" })}
      className={`grid shrink-0 place-items-center rounded-full bg-fg text-bg transition-[background-color,transform] hover:bg-mint active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${expanded ? "size-16" : "size-11"}`}>
      {state.playing ? <Pause className={expanded ? "size-7" : "size-5"} fill="currentColor" /> : <Play className={expanded ? "size-7" : "size-5"} fill="currentColor" />}
    </button>
    <Transport label="Next track" disabled={disabled} onClick={() => command({ action: "next" })}><SkipForward /></Transport>
    <Transport label={state.repeat === 1 ? "Repeat one" : state.repeat === 2 ? "Repeat all" : "Repeat off"} active={state.repeat > 0} disabled={disabled} onClick={() => command({ action: "repeat" })} className={expanded ? "inline-flex" : "hidden sm:inline-flex"}>{state.repeat === 1 ? <Repeat1 /> : <Repeat />}</Transport>
  </div>;
}

export function SeekControl({ state, ready, command }: {
  state: PlayerState; ready: boolean; command: (command: PlayerCommand) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const seek = () => {
    if (draft !== null) command({ action: "seek", value: draft });
    setDraft(null);
  };
  return <label className="flex w-full items-center gap-2 text-[11px] text-muted tabular">
    <span className="w-9 shrink-0 text-right">{timestamp(draft ?? state.time)}</span><span className="sr-only">Seek</span>
    <input aria-label="Seek" aria-valuetext={`${timestamp(draft ?? state.time)} of ${timestamp(state.duration)}`} type="range" min="0" max={state.duration || 1} step="1000"
      value={Math.min(draft ?? state.time, state.duration)} disabled={!ready || !state.track || !state.duration}
      onChange={(event) => setDraft(Number(event.target.value))} onPointerUp={seek} onKeyUp={seek} onBlur={seek} onPointerCancel={() => setDraft(null)}
      className="h-8 min-w-0 flex-1 cursor-pointer accent-mint" />
    <span className="w-9 shrink-0">{timestamp(state.duration)}</span>
  </label>;
}
