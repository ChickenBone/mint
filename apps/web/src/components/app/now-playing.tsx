"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { ArrowDown, ListMusic, Mic2, MonitorSpeaker, MoreHorizontal, Settings2, Volume2 } from "lucide-react";
import { Artwork, ArtworkAtmosphere } from "../artwork";
import type { PlayerCommand, PlayerItem, PlayerState } from "@/lib/player-protocol";
import { LyricsPanel, QueueContents } from "./player-panels";
import { AlbumLink, ArtistLink } from "./music-links";
import { MusicItem } from "./music-item";
import { PlaybackControls, SeekControl } from "./player-controls";
import { getTabTargetIndex } from "@/components/ui/interactive";

type Panel = "queue" | "lyrics";
const tabs = [
  { id: "queue", label: "Queue", icon: ListMusic },
  { id: "lyrics", label: "Lyrics", icon: Mic2 },
] as const;

export function NowPlaying({
  state, ready, command, panel, setPanel, interactive, onCollapse, onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
  onLostPointerCapture, onClickCapture, onMore,
}: {
  state: PlayerState; ready: boolean; command: (command: PlayerCommand) => Promise<boolean>;
  panel: Panel | null; setPanel: (panel: Panel) => void;
  interactive: boolean;
  onCollapse: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  onMore: (track: PlayerItem, button: HTMLButtonElement) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const selected = panel ?? "queue";
  const [visited, setVisited] = useState<Panel[]>([selected]);
  const select = (next: Panel) => {
    setPanel(next);
    setVisited((previous) => previous.includes(next) ? previous : [...previous, next]);
  };
  const track = state.track;
  useEffect(() => {
    if (!interactive) return;
    heading.current?.focus({ preventScroll: true });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(
        'a[href],button:not(:disabled),input:not(:disabled),[tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) { event.preventDefault(); dialog.current.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1);
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && (activeIndex === 0 || activeIndex < 0)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (activeIndex === focusable.length - 1 || activeIndex < 0)) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, [interactive]);
  return <div
    ref={dialog}
    role="dialog"
    aria-modal={interactive}
    aria-label="Now Playing"
    aria-hidden={!interactive}
    tabIndex={-1}
    data-player-drag-surface
    className="player-sheet"
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerCancel}
    onLostPointerCapture={onLostPointerCapture}
    onClickCapture={onClickCapture}
  >
    {track && <div className="player-transition-artwork player-drag-region" data-player-drag-region aria-hidden>
      <Artwork track={{ artworkUrl: track.thumb ?? "" }} eager className="now-playing-art w-full" />
    </div>}
    <div className="player-sheet-content" inert={!interactive}>
    <main id="listening-content" tabIndex={-1} aria-label="Now playing" className="now-playing music-atmosphere relative flex flex-col overflow-hidden">
    <ArtworkAtmosphere src={track?.thumb} />
    <header data-player-drag-region className="player-drag-region relative flex shrink-0 items-center justify-between gap-3 px-5 pt-4 sm:px-8">
      <h1 ref={heading} tabIndex={-1} className="rounded text-base font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint">Now Playing</h1>
      <div className="flex items-center gap-1">
        <Link href="/app/settings?section=playback" aria-label="Playback and sound settings" className="grid size-11 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"><Settings2 className="size-5" /></Link>
        <Link href="/app/settings?section=devices" aria-label="Devices" className="inline-flex size-11 items-center justify-center gap-2 rounded-full text-sm text-muted hover:bg-hover hover:text-fg sm:w-auto sm:px-3">
          <MonitorSpeaker className="size-4" /><span className="hidden sm:inline">Devices</span>
        </Link>
        <button type="button" onClick={onCollapse} aria-label="Collapse now playing" className="inline-flex size-11 items-center justify-center gap-2 rounded-full text-sm text-muted hover:bg-hover hover:text-fg sm:w-auto sm:px-3">
          <ArrowDown className="size-4" /><span className="hidden sm:inline">Collapse</span>
        </button>
      </div>
    </header>
    {!track ? <div className="mx-auto max-w-md px-6 py-20 text-center">
      <ListMusic className="mx-auto mb-5 size-10 text-muted" />
      <h2 className="text-2xl font-bold">Nothing playing</h2>
      <p className="mt-3 text-sm leading-relaxed text-muted">Pick a song to start listening.</p>
      <Link href="/app/library" className="mt-6 inline-flex min-h-11 items-center rounded-full bg-mint px-6 font-semibold text-mint-ink hover:bg-mint-strong">Browse music</Link>
    </div> : <div className="now-playing-grid">
      <section aria-label="Current song" className="mx-auto flex w-full min-w-0 max-w-lg flex-col px-5 pb-6 pt-5 sm:px-8">
        <MusicItem item={track} data-player-drag-surface className="player-expanded-artwork mx-auto w-full max-w-[min(38dvh,23rem)] xl:max-w-[min(48dvh,28rem)]"><Artwork key={track.thumb ?? track.id} track={{ artworkUrl: track.thumb ?? "" }} eager className="now-playing-art w-full rounded-lg shadow-[0_16px_40px_-16px_#000]" /></MusicItem>
        <div data-player-drag-surface className="mt-6 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl">{track.title}</h2>
            <p className="mt-2 break-words text-base text-muted"><ArtistLink item={track} /></p>
            {track.album && <p className="mt-1 truncate text-sm text-faint"><AlbumLink item={track} /></p>}
          </div>
          <button type="button" aria-label={`More options for ${track.title}`} aria-haspopup="menu" onClick={(event) => onMore(track, event.currentTarget)}
            className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"><MoreHorizontal className="size-5" /></button>
        </div>
        <div className="mt-5 hidden xl:block">
          <SeekControl key={track.queueId ?? track.id} state={state} ready={ready} command={command} />
          <div className="mt-3"><PlaybackControls state={state} ready={ready} command={command} expanded /></div>
          <div className="mt-5 flex items-center justify-between gap-4">
            <p className="text-xs text-muted" role="status">{state.transitioning ? "Blending into the next song" : state.playing ? "Playing" : "Paused"}</p>
            <label className="flex w-28 shrink-0 items-center gap-2">
              <Volume2 className="size-4 shrink-0 text-muted" /><span className="sr-only">Volume</span>
              <input aria-label="Volume" type="range" min="0" max="100" value={state.volume} disabled={!ready}
                onChange={(event) => command({ action: "volume", value: Number(event.target.value) })} className="h-8 min-w-0 w-full accent-mint" />
            </label>
          </div>
        </div>
      </section>
      <section aria-label="Queue and lyrics" className="min-h-0 min-w-0 border-t border-line xl:flex xl:flex-col xl:border-l xl:border-t-0">
        <div role="tablist" aria-label="Queue and lyrics" className="sticky top-0 z-10 flex shrink-0 gap-1 border-b border-line bg-surface px-4 sm:px-6">
          {tabs.map(({ id, label, icon: Icon }, index) => <button key={id} type="button" role="tab" id={`listening-${id}`} aria-selected={selected === id} aria-controls={`listening-panel-${id}`} tabIndex={selected === id ? 0 : -1}
            onClick={() => select(id)} onKeyDown={(event) => {
              const target = getTabTargetIndex(tabs.map(() => ({ disabled: false })), index, event.key);
              if (target === undefined) return;
              const next = tabs[target];
              if (!next) return;
              event.preventDefault(); select(next.id);
              document.getElementById(`listening-${next.id}`)?.focus();
            }} className={`relative inline-flex min-h-14 flex-1 items-center justify-center gap-2 px-2 text-sm font-bold transition-colors hover:text-fg ${selected === id ? "text-fg" : "text-muted"}`}>
            <Icon className="size-4" />{label}
            {selected === id && <span className="absolute inset-x-3 bottom-0 h-0.5 bg-mint" />}
          </button>)}
        </div>
        {tabs.map(({ id, label }) => <div key={id} id={`listening-panel-${id}`} role="tabpanel" aria-labelledby={`listening-${id}`} hidden={selected !== id}
          tabIndex={0} data-player-sheet-scroll className="player-sheet-scroll min-h-0 flex-1 overflow-y-auto px-5 py-5 scrollbar-thin sm:px-8" aria-label={label}>
          {(visited.includes(id) || selected === id) && (id === "queue" ? <QueueContents state={state} command={command} /> : <LyricsPanel state={state} command={command} />)}
        </div>)}
      </section>
    </div>}
    {track && <footer aria-label="Now playing controls" className="shrink-0 border-t border-line bg-surface px-4 pb-3 pt-1 xl:hidden">
      <SeekControl key={track.queueId ?? track.id} state={state} ready={ready} command={command} />
      <PlaybackControls state={state} ready={ready} command={command} expanded />
    </footer>}
    </main>
    </div>
  </div>;
}
