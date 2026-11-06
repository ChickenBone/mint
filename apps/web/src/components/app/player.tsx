"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ListMusic, Mic2, MoreHorizontal, Volume2, VolumeX, X } from "lucide-react";
import { Artwork } from "@/components/artwork";
import { GlobalSearch } from "./global-search";
import { playerItemSchema, type PlayerCommand, type PlayerItem, type PlayerState } from "@/lib/player-protocol";
import { analysisSchema } from "@mint/core/analysis";
import { authorizeOffline, clearOffline, listOffline, offlineAudio, offlineSettings } from "@/lib/offline";
import { startDeviceBridge } from "@/lib/device-client";
import { ListeningHistory } from "@/lib/listening-history";
import { TrackMusicActions } from "./track-music-actions";
import { NativePlayer } from "@/lib/native-player";
import { collectionParams, itemCollection } from "@/lib/browser-catalog";
import { LyricsPanel, PlayerPanel, QueueContents } from "./player-panels";
import { PlaybackControls, SeekControl, Transport } from "./player-controls";
import { NowPlaying } from "./now-playing";
import { ArtistLink } from "./music-links";
import { MusicItem } from "./music-item";

type Menu = { item: PlayerItem; x: number; y: number; path: string; returnTo: HTMLElement | null };
interface PlayerContext {
  ready: boolean;
  busy: boolean;
  state: PlayerState;
  command: (command: PlayerCommand) => Promise<boolean>;
  menu: (item: PlayerItem, point: { x: number; y: number }, returnTo?: HTMLElement | null) => void;
}
const Context = createContext<PlayerContext | null>(null);
interface ShellContext {
  nowPlaying: boolean; ready: boolean;
  panel: "queue" | "lyrics" | null; setPanel: (panel: "queue" | "lyrics" | null) => void;
  returnTo: string; rememberReturn: () => void;
}
const ShellContext = createContext<ShellContext | null>(null);
export const usePlayer = () => useContext(Context);
const empty: PlayerState = { playing: false, time: 0, duration: 0, volume: 100, shuffle: false, repeat: 0, track: null, queue: [], queueTotal: 0, queueOffset: 0 };

export function MusicNavigation() {
  return <nav aria-label="Search" className="flex min-w-0 flex-1 justify-end lg:justify-start"><GlobalSearch /></nav>;
}

export function PlayerProvider({ children, memberId }: { children: React.ReactNode; memberId: string }) {
  const first = useRef<HTMLAudioElement>(null), second = useRef<HTMLAudioElement>(null);
  const engine = useRef<NativePlayer | null>(null);
  const selectionRequest = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<PlayerState>(empty);
  const ready = state.dsp !== undefined;
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Menu | null>(null);
  const [returnTo, setReturnTo] = useState("/app/library");
  const [panelSelection, setPanelSelection] = useState<{ surface: string; value: ShellContext["panel"] } | null>(null);
  const pathname = usePathname();
  const params = useSearchParams();
  const surface = `${pathname}?${params.toString()}`;
  const requestedPanel = pathname === "/app/now-playing" && (params.get("tab") === "lyrics" || params.get("tab") === "queue") ? params.get("tab") as "lyrics" | "queue" : null;
  const panel = panelSelection?.surface === surface ? panelSelection.value : requestedPanel;
  const setPanel = useCallback((value: ShellContext["panel"]) => setPanelSelection({ surface, value }), [surface]);
  const router = useRouter();
  const nowPlaying = pathname === "/app/now-playing";
  const rememberReturn = useCallback(() => setReturnTo(`${location.pathname}${location.search}`), []);

  const command = useCallback((command: PlayerCommand): Promise<boolean> => {
    if (!engine.current) { setError("The player is still starting. Try again in a moment."); return Promise.resolve(false); }
    setError(null);
    const id = crypto.randomUUID();
    if (["play", "collection", "next-in-queue", "add-to-queue"].includes(command.action)) { selectionRequest.current = id; setBusy(true); }
    return engine.current.execute(command).then(() => true).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setError(error instanceof Error ? error.message : "This playback action failed. Try again.");
      return false;
    }).finally(() => {
      if (selectionRequest.current === id) { selectionRequest.current = null; setBusy(false); }
    });
  }, []);

  useEffect(() => {
    if (!first.current || !second.current) return;
    const history = new ListeningHistory((event) => {
      if (!navigator.onLine) return;
      void fetch("/api/music/history", { method: "POST", cache: "no-store", keepalive: true,
        headers: { "content-type": "application/json" }, body: JSON.stringify(event) }).then((response) => {
        if (!response.ok) throw new Error("Listening history could not be saved.");
      }).catch((error: unknown) => { console.error("Listening history write failed", error); setError("This play could not be saved to listening history. Playback is unaffected."); });
    });
    const player = new NativePlayer({ memberId, elements: [first.current, second.current], update: (state) => { setState(state); history.update(state); }, error: setError,
      source: async (track, format) => {
        try {
          const local = await offlineAudio(memberId, track.id);
          if (local) return local;
        } catch (error) {
          console.error("Offline music storage unavailable", error);
          setError("Device storage is unavailable. Mint will stream this song while connected.");
        }
        if (!navigator.onLine) throw new Error("This song is not downloaded, or offline access expired. Reconnect or open the offline player.");
        return `/api/player/audio/${track.id}${format === "mp3" ? "?format=mp3" : ""}`;
      },
      analysis: async (id) => {
        if (!navigator.onLine) return null;
        const response = await fetch(`/api/player/analysis/${id}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error("Track analysis could not load. Smart Fades will use a short fixed fallback.");
        const body = await response.json();
        return body.result ? analysisSchema.parse(body.result) : null;
      },
    });
    engine.current = player;
    const controller = new AbortController();
    const items = async (ids: string[], signal?: AbortSignal) => {
      const result: PlayerItem[] = [];
      for (let start = 0; start < ids.length; start += 5000) {
        signal?.throwIfAborted();
        const response = await fetch("/api/player/items", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: ids.slice(start, start + 5000) }), signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "The device queue could not load.");
        result.push(...body.items.map((item: unknown) => playerItemSchema.parse(item)));
      }
      return result;
    };
    const devices = startDeviceBridge({ memberId, getState: () => player.getDeviceState(), error: setError,
      execute: async (command, signal) => {
        signal?.throwIfAborted();
        if (command.action === "handoff") throw new Error("Use the explicit handoff command.");
        if (command.action === "queue-edit") {
          if (command.edit.action === "append") {
            const [track] = await items([command.edit.trackId], signal);
            await player.execute({ action: "add-to-queue", item: track! });
          } else if (command.edit.action === "remove") await player.execute({ action: "remove", queueId: command.edit.entryId });
          else await player.execute({ action: "move", queueId: command.edit.entryId, before: command.edit.before });
        } else if (command.action === "queue") {
          if (!command.trackIds.length) { await player.execute({ action: "items", items: [] }); return; }
          const previous = player.getState();
          const tracks = await items(command.trackIds, signal); signal?.throwIfAborted();
          const cancel = () => player.pause(); signal?.addEventListener("abort", cancel, { once: true });
          try {
            await player.execute({ action: "items", items: tracks, index: command.currentIndex, paused: !previous.playing,
              position: tracks[command.currentIndex]?.id === previous.track?.id ? previous.time : 0 });
            signal?.throwIfAborted();
          } finally { signal?.removeEventListener("abort", cancel); }
        } else if (command.action === "play") await player.execute({ action: "resume" });
        else if (command.action === "seek") await player.execute({ action: "seek", value: command.value * 1000 });
        else await player.execute(command);
      },
      applyHandoff: async (handoff, signal) => {
        if (handoff.queueContext) {
          await player.execute({ action: "context", context: handoff.queueContext, position: handoff.position * 1000, paused: true, repeat: handoff.repeat });
        } else {
          const tracks = await items(handoff.queue, signal);
          signal?.throwIfAborted();
          await player.execute({ action: "items", items: tracks, index: handoff.currentIndex, position: handoff.position * 1000,
            paused: true, shuffle: handoff.shuffle, repeat: handoff.repeat });
        }
        signal?.throwIfAborted();
        const cancel = () => player.pause();
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          if (handoff.playing) {
            await player.execute({ action: "resume" }); signal?.throwIfAborted();
            if (!player.getState().playing) throw new Error("The destination did not start playing. Tap Play on that device first.");
          }
        } finally { signal?.removeEventListener("abort", cancel); }
      },
    });
    let lastRenewed = 0;
    const downloadedAccess = async () => {
      const settings = await offlineSettings();
      return settings?.grant.memberId === memberId && settings.grant.expiresAt > Date.now() &&
        (await listOffline(memberId)).some((song) => song.id === player.getState().track?.id);
    };
    const verify = async () => {
      try {
        const response = await fetch("/api/player/session", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (controller.signal.aborted) return;
        if (response.status === 401) { player.revoke("Playback access has expired. Sign in again."); await clearOffline(); }
        else if (!response.ok) player.revoke("Mint could not verify playback access. Check your connection and press Play to retry.");
        else if ((await response.json()).memberId !== memberId) { player.revoke("The signed-in account changed. Reload Mint before listening."); await clearOffline(); }
        else if (Date.now() - lastRenewed > 60_000) {
          if ("indexedDB" in window) await authorizeOffline(memberId, controller.signal);
          lastRenewed = Date.now();
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        try {
          if (await downloadedAccess()) return;
        } catch (storageError) { console.error("Offline access check failed", storageError); }
        console.error("Playback verification failed", error);
        player.revoke("Mint could not verify playback access. Reconnect, or open Downloads to use saved music.");
      }
    };
    void verify();
    const timer = setInterval(() => { void verify(); }, 15_000);
    const channel = "BroadcastChannel" in window ? new BroadcastChannel("mint-access") : null;
    if (channel) channel.onmessage = (event) => { if (event.data?.type === "sign-out") player.revoke("You signed out in another Mint tab."); };
    const pagehide = () => { player.pause(); history.flush(); };
    const privacyChanged = () => history.reset();
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("mint:private-session", privacyChanged);
    return () => {
      controller.abort(); clearInterval(timer); window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("mint:private-session", privacyChanged);
      history.flush(); channel?.close(); devices.dispose(); player.dispose(); engine.current = null;
    };
  }, [memberId]);
  useEffect(() => {
    if (!nowPlaying) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !selection) router.push(returnTo);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [nowPlaying, router, returnTo, selection]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || !state.track) return;
      if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,button,a,[role=tab],[role=menuitem],[role=button],[contenteditable=true]")) return;
      event.preventDefault();
      command({ action: "toggle" });
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [command, state.track]);

  const closeMenu = useCallback(() => {
    const returnTo = selection?.returnTo;
    setSelection(null);
    requestAnimationFrame(() => returnTo?.focus());
  }, [selection]);
  const showMenu: PlayerContext["menu"] = (item, point, returnTo) => setSelection({ item, ...point, path: surface, returnTo: returnTo ?? null });
  const browse = (item: PlayerItem) => {
    if (item.type === "playlist") {
      router.push(`/app/collection/${encodeURIComponent(item.id)}`);
      return;
    }
    const query = new URLSearchParams({ type: item.type === "artist" ? "album" : "track" });
    const route = item.type === "artist" ? "artists" : "albums";
    router.push(`/app/library/${route}/${encodeURIComponent(item.id)}?${query}`);
  };

  return (
    <Context.Provider value={{ ready, busy, state, command, menu: showMenu }}>
      <ShellContext.Provider value={{ nowPlaying, ready, panel, setPanel, returnTo, rememberReturn }}>
        {children}
      </ShellContext.Provider>
      {(error || selection) && createPortalSafe(
        <div className="contents">
          {error && <div role="alert" className="fixed top-3 right-3 left-3 z-[100] mx-auto flex max-w-2xl items-center gap-3 rounded-lg bg-elevated p-4 text-sm text-fg shadow-[0_12px_30px_-8px_#000] ring-1 ring-line">
            <p className="flex-1">{error}</p>
            <button aria-label="Dismiss message" onClick={() => setError(null)} className="rounded-full p-2 hover:bg-hover"><X className="size-4" /></button>
          </div>}
          {selection && selection.path === surface && <TrackMenu selection={selection} close={closeMenu} command={command} browse={browse} />}
        </div>,
      )}
      <div className="hidden" data-player-mounted={ready ? "ready" : "loading"} />
      <audio ref={first} id="mint-browser-audio" hidden />
      <audio ref={second} id="mint-browser-standby" hidden />
    </Context.Provider>
  );
}

function createPortalSafe(children: React.ReactNode) {
  return typeof document === "undefined" ? null : createPortal(children, document.body);
}
export function MusicStage({ children }: { children: React.ReactNode }) {
  const { nowPlaying, ready, panel, setPanel, returnTo } = useContext(ShellContext)!;
  const player = usePlayer()!;
  const closeQueue = useCallback(() => {
    setPanel(null);
    document.querySelector<HTMLButtonElement>(`button[aria-label="${panel === "queue" ? "Queue" : "Lyrics"}"]`)?.focus();
  }, [setPanel, panel]);
  return <div className="relative min-h-0 flex-1">
    {!nowPlaying && <main id="listening-content" tabIndex={-1} className="listening-content h-full overflow-y-auto scrollbar-thin">{children}</main>}
    {nowPlaying && <NowPlaying state={player.state} ready={ready} command={player.command} panel={panel} setPanel={setPanel} returnTo={returnTo} onMore={(track, button) => {
      const rect = button.getBoundingClientRect(); player.menu(track, { x: rect.x, y: rect.bottom }, button);
    }} />}
    {!nowPlaying && panel === "queue" && <PlayerPanel title="Queue" close={closeQueue}><QueueContents state={player.state} command={player.command} /></PlayerPanel>}
    {!nowPlaying && panel === "lyrics" && <PlayerPanel title="Lyrics" close={closeQueue}><LyricsPanel state={player.state} command={player.command} /></PlayerPanel>}
  </div>;
}

export function PlayerBar() {
  const { state, ready, command } = usePlayer()!;
  const { panel, setPanel, nowPlaying, rememberReturn } = useContext(ShellContext)!;
  const track = state.track;
  const previousVolume = useRef(100);
  if (nowPlaying) return null;
  return <section aria-label="Music player" className="player-dock relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-line bg-surface px-3 py-3 md:col-span-2 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,1.3fr)_minmax(0,1fr)] lg:gap-6 lg:px-6 lg:py-3">
    <MusicItem item={track} className="flex min-w-0 items-center gap-3">
      <Link href="/app/now-playing" onClick={rememberReturn} aria-label="Open now playing" className="shrink-0 rounded transition-transform active:scale-95"><Artwork track={{ artworkUrl: track?.thumb ?? "" }} className="size-10 rounded lg:size-12" /></Link>
      <div className="min-w-0">
        <Link href="/app/now-playing" onClick={rememberReturn} className="block truncate text-sm font-semibold hover:underline">{track?.title ?? "Your music, ready when you are"}</Link>
        <p className="mt-1 truncate text-xs text-muted">{track ? <ArtistLink item={track} /> : ready ? "Choose a song to start listening" : "Connecting to your library…"}</p>
      </div>
      {track && <div className="hidden xl:block"><TrackMenuButton item={track} /></div>}
    </MusicItem>
    <div className="flex items-center justify-end gap-2 lg:col-start-2 lg:row-start-1 lg:flex-col lg:gap-1">
      <PlaybackControls state={state} ready={ready} command={command} />
      <Link href="/app/now-playing?tab=queue" onClick={rememberReturn} aria-label="Open queue" className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg lg:hidden"><ListMusic className="size-5" /></Link>
      <div className="hidden w-full lg:block"><SeekControl key={track?.queueId ?? "empty"} state={state} ready={ready} command={command} /></div>
    </div>
    <div className="hidden min-w-0 items-center gap-2 lg:flex lg:col-start-3 lg:row-start-1 lg:justify-end">
      <Transport label="Lyrics" active={panel === "lyrics"} disabled={!ready || !track} onClick={() => setPanel(panel === "lyrics" ? null : "lyrics")}><Mic2 /></Transport>
      <Transport label="Queue" active={panel === "queue"} disabled={!ready} onClick={() => setPanel(panel === "queue" ? null : "queue")}><ListMusic /></Transport>
      <div className="flex max-w-36 items-center gap-1">
        <Transport label={state.volume ? "Mute" : "Unmute"} disabled={!ready} onClick={() => {
          if (state.volume) previousVolume.current = state.volume;
          command({ action: "volume", value: state.volume ? 0 : previousVolume.current });
        }}>{state.volume ? <Volume2 /> : <VolumeX />}</Transport>
        <input aria-label="Volume" type="range" min="0" max="100" value={state.volume} disabled={!ready}
          onChange={(event) => command({ action: "volume", value: Number(event.target.value) })} className="h-8 min-w-0 w-20 accent-mint" />
      </div>
    </div>
    <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-line lg:hidden"><div className="h-full bg-mint" style={{ width: `${state.duration ? Math.min(100, state.time / state.duration * 100) : 0}%` }} /></div>
  </section>;
}

function TrackMenu({ selection, close, command, browse }: {
  selection: Menu; close: () => void; command: PlayerContext["command"]; browse: (item: PlayerItem) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: Math.max(8, Math.min(selection.x, window.innerWidth - 272)), top: 8 });
  const item = selection.item;
  const router = useRouter();
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const place = () => setPosition({
      left: Math.max(8, Math.min(selection.x, innerWidth - menu.offsetWidth - 8)),
      top: Math.max(8, Math.min(selection.y, innerHeight - menu.offsetHeight - 8)),
    });
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close(); return; }
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    return () => { observer.disconnect(); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", key); window.removeEventListener("resize", close); };
  }, [selection, close]);
  const act = (action: PlayerCommand) => { close(); command(action); };
  const menuClass = "w-full rounded px-3 py-2.5 text-left text-sm text-fg hover:bg-hover focus:bg-hover";
  return <div ref={ref} role="menu" aria-label={`Actions for ${item.title}`} style={position}
    onContextMenu={(event) => event.preventDefault()} className="fixed z-[110] max-h-[calc(100dvh-16px)] w-64 overflow-y-auto rounded-lg bg-elevated p-1.5 shadow-[0_14px_40px_-8px_#000] ring-1 ring-line">
    <p className="truncate border-b border-line px-3 py-3 text-xs font-semibold text-muted">{item.title}</p>
    <button role="menuitem" className={menuClass} onClick={() => act({ action: "play", item })}>Play {item.type === "track" ? "now" : item.type}</button>
    {item.type !== "track" && <button role="menuitem" className={menuClass} onClick={() => act({ action: "play", item, shuffle: true })}>Shuffle {item.type}</button>}
    {item.type === "track" && item.artistId && <button role="menuitem" className={menuClass} onClick={() => act({ action: "play", shuffle: true,
      item: { id: item.artistId!, type: "artist", title: item.artist ?? "Artist" } })}>Shuffle this artist</button>}
    <button role="menuitem" className={menuClass} onClick={() => act({ action: "next-in-queue", item })}>Play next</button>
    <button role="menuitem" className={menuClass} onClick={() => act({ action: "add-to-queue", item })}>Add to queue</button>
    <button role="menuitem" className={menuClass} onClick={() => {
      close();
      const params = collectionParams(itemCollection(item));
      params.set("tab", "downloads");
      if (item.type === "track") params.set("track", item.id);
      params.set("title", item.title);
      router.push(`/app/collection?${params}`);
    }}>Download {item.type === "track" ? "song" : item.type}</button>
    {item.type !== "track" && <button role="menuitem" className={menuClass} onClick={() => { close(); browse(item); }}>Open {item.type}</button>}
    {item.albumId && <button role="menuitem" className={menuClass} onClick={() => {
      close(); browse({ id: item.albumId!, type: "album", title: item.album ?? "Album", artist: item.artist });
    }}>Go to album</button>}
    {item.artistId && <button role="menuitem" className={menuClass} onClick={() => {
      close(); browse({ id: item.artistId!, type: "artist", title: item.artist ?? "Artist" });
    }}>Go to artist</button>}
    {item.queueId && <button role="menuitem" className={menuClass} onClick={() => act({ action: "remove", queueId: item.queueId! })}>Remove from queue</button>}
    <TrackMusicActions key={item.id} item={item} close={close} />
  </div>;
}

export function TrackMenuButton({ item }: { item: PlayerItem }) {
  const player = usePlayer();
  if (!player) return null;
  return <button aria-label={`More options for ${item.title}`} aria-haspopup="menu" onClick={(event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    player.menu(item, { x: rect.x, y: rect.bottom }, event.currentTarget);
  }} className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-elevated hover:text-fg"><MoreHorizontal className="size-4" /></button>;
}
