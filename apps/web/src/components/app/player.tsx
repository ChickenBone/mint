"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ListMusic, Mic2, MoreHorizontal, SlidersHorizontal, Volume2, X } from "lucide-react";
import { Artwork } from "@/components/artwork";
import { PLAYER_CHANNEL, playerItemSchema, playerStateSchema, type MusicView, type PlayerCommand, type PlayerItem, type PlayerState } from "@/lib/player-protocol";
import { AudioPanel, LyricsPanel, PlayerPanel, QueueContents } from "./player-panels";
import { PlaybackControls, SeekControl, Transport } from "./player-controls";
import { NowPlaying } from "./now-playing";
import { CollectionActions } from "./collection-actions";
import { InstallApp } from "../install-app";

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
  registerFrame: (element: HTMLIFrameElement | null) => void; generation: number; music: boolean; nowPlaying: boolean; ready: boolean; failed: boolean;
  panel: "queue" | "audio" | "lyrics" | null; setPanel: (panel: "queue" | "audio" | "lyrics" | null) => void; reload: () => void;
  returnTo: string; rememberReturn: () => void;
}
const ShellContext = createContext<ShellContext | null>(null);
export const usePlayer = () => useContext(Context);
const empty: PlayerState = { playing: false, time: 0, duration: 0, volume: 100, shuffle: false, repeat: 0, track: null, queue: [], queueTotal: 0, queueOffset: 0 };

export function MusicNavigation() {
  const path = usePathname(), params = useSearchParams();
  const view = params.get("view") ?? "home";
  return <nav aria-label="Music views" className="flex min-w-0 items-center gap-1 text-xs font-semibold sm:text-sm">
    {(["home", "library", "search"] as const).map((key) => {
      const active = path === "/app/music" && view === key;
      return <Link key={key} href={key === "home" ? "/app/music" : `/app/music?view=${key}`} aria-current={active ? "page" : undefined}
        className={`rounded-full px-3 py-2 hover:bg-hover hover:text-fg ${active ? "bg-elevated text-fg" : "text-muted"}`}>{key === "home" ? "Discover" : key === "library" ? "Browse" : "Search"}</Link>;
    })}
    <InstallApp compact />
  </nav>;
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const registerFrame = useCallback((element: HTMLIFrameElement | null) => { frame.current = element; }, []);
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; resolve: (ok: boolean) => void }>());
  const selectionRequest = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<PlayerState>(empty);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Menu | null>(null);
  const [returnTo, setReturnTo] = useState("/app/music?view=library");
  const [panelSelection, setPanelSelection] = useState<{ surface: string; value: ShellContext["panel"] } | null>(null);
  const pathname = usePathname();
  const params = useSearchParams();
  const surface = `${pathname}?${params.toString()}`;
  const panel = panelSelection?.surface === surface ? panelSelection.value : null;
  const setPanel = useCallback((value: ShellContext["panel"]) => setPanelSelection({ surface, value }), [surface]);
  const router = useRouter();
  const music = pathname === "/app/music";
  const rawView = params.get("view");
  const view: MusicView = rawView === "search" || rawView === "library" || rawView === "now-playing" ? rawView : "home";
  const nowPlaying = music && view === "now-playing";
  const rememberReturn = useCallback(() => setReturnTo(`${location.pathname}${location.search}`), []);

  const command = useCallback((command: PlayerCommand): Promise<boolean> => {
    if (!ready || !frame.current?.contentWindow) { setError("The music engine is still starting. Try again in a moment."); return Promise.resolve(false); }
    const id = crypto.randomUUID();
    if (["play", "collection", "sonic"].includes(command.action)) { selectionRequest.current = id; setBusy(true); }
    const target = frame.current.contentWindow;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.current.delete(id);
        resolve(false);
        if (selectionRequest.current === id) { selectionRequest.current = null; setBusy(false); }
        setError("The music engine did not respond. Reload the player and try again.");
        setFailed(true);
      }, command.action === "collection" || command.action === "sonic" ? 60_000 : 20_000);
      pending.current.set(id, { timer, resolve });
      target.postMessage({ channel: PLAYER_CHANNEL, type: "command", id, command }, location.origin);
    });
  }, [ready]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.channel !== PLAYER_CHANNEL) return;
      const data = event.data;
      if (data.type === "ready") { setReady(true); setFailed(false); setError(null); }
      if (data.type === "state") {
        const parsed = playerStateSchema.safeParse(data.state);
        if (parsed.success) setState(parsed.data);
        else { console.error("Invalid music engine state", parsed.error.issues); setError("The music engine returned incompatible data. Reload Mint after updating both web and worker."); }
      }
      if (data.type === "error" && typeof data.message === "string") setError(data.message.slice(0, 500));
      if (data.type === "dismiss-menu") setSelection(null);
      if (data.type === "now-playing" && new URLSearchParams(location.search).get("view") !== "now-playing") {
        rememberReturn(); router.push("/app/music?view=now-playing");
      }
      if (data.type === "result" && typeof data.id === "string" && pending.current.has(data.id)) {
        const request = pending.current.get(data.id)!;
        clearTimeout(request.timer);
        request.resolve(data.ok === true);
        pending.current.delete(data.id);
        if (selectionRequest.current === data.id) { selectionRequest.current = null; setBusy(false); }
        if (data.ok !== true) setError(typeof data.message === "string" ? data.message.slice(0, 500) : "This playback action failed. Try again.");
      }
      if (data.type === "menu") {
        const item = playerItemSchema.safeParse(data.item);
        const rect = frame.current?.getBoundingClientRect();
        if (item.success && rect && Number.isFinite(data.point?.x) && Number.isFinite(data.point?.y)) {
          setSelection({ item: item.data, x: rect.x + data.point.x, y: rect.y + data.point.y, path: `${location.pathname}?${new URLSearchParams(location.search).toString()}`, returnTo: frame.current });
        }
      }
    }
    window.addEventListener("message", receive);
    const timers = pending.current;
    return () => { window.removeEventListener("message", receive); timers.forEach(({ timer, resolve }) => { clearTimeout(timer); resolve(false); }); timers.clear(); };
  }, [router, rememberReturn]);

  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => { setFailed(true); setError("The music engine could not start. Reload the player, or check that the web image includes its player assets."); }, 30_000);
    return () => clearTimeout(timer);
  }, [ready, generation]);
  useEffect(() => {
    if (!ready || !music) return;
    const timer = setTimeout(() => { if (!nowPlaying) void command({ action: "navigate", view }); }, 0);
    return () => clearTimeout(timer);
  }, [ready, music, nowPlaying, view, command]);
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

  const closeMenu = useCallback(() => { selection?.returnTo?.focus(); setSelection(null); }, [selection]);
  const showMenu: PlayerContext["menu"] = (item, point, returnTo) => setSelection({ item, ...point, path: surface, returnTo: returnTo ?? null });
  const browse = (item: PlayerItem) => { router.push("/app/music?view=library"); command({ action: "browse", item }); };
  const reload = () => {
    pending.current.forEach(({ timer, resolve }) => { clearTimeout(timer); resolve(false); }); pending.current.clear();
    setReady(false); setBusy(false); selectionRequest.current = null; setFailed(false); setError(null); setState(empty); setGeneration((n) => n + 1);
  };

  return (
    <Context.Provider value={{ ready, busy, state, command, menu: showMenu }}>
      <ShellContext.Provider value={{ registerFrame, generation, music, nowPlaying, ready, failed, panel, setPanel, reload, returnTo, rememberReturn }}>
        {children}
      </ShellContext.Provider>
      {(error || selection) && createPortalSafe(
        <div className="contents">
          {error && <div role="alert" className="fixed top-3 right-3 left-3 z-[100] mx-auto flex max-w-2xl items-center gap-3 rounded-lg bg-elevated p-4 text-sm text-fg shadow-[0_12px_30px_-8px_#000] ring-1 ring-line">
            <p className="flex-1">{error}</p>
            {failed && <button onClick={reload} className="shrink-0 rounded-full bg-mint px-3 py-2 font-semibold text-mint-ink">Reload player</button>}
            <button aria-label="Dismiss message" onClick={() => setError(null)} className="rounded-full p-2 hover:bg-hover"><X className="size-4" /></button>
          </div>}
          {selection && selection.path === surface && <TrackMenu selection={selection} close={closeMenu} command={command} browse={browse} />}
        </div>,
      )}
      <div className="hidden" data-player-mounted={ready ? "ready" : "loading"} />
    </Context.Provider>
  );
}

function createPortalSafe(children: React.ReactNode) {
  return typeof document === "undefined" ? null : createPortal(children, document.body);
}
export function MusicStage({ children }: { children: React.ReactNode }) {
  const { registerFrame, generation, music, nowPlaying, ready, failed, panel, setPanel, reload, returnTo } = useContext(ShellContext)!;
  const player = usePlayer()!;
  const closeQueue = useCallback(() => {
    setPanel(null);
    document.querySelector<HTMLButtonElement>(`button[aria-label="${panel === "queue" ? "Queue" : panel === "lyrics" ? "Lyrics" : "Audio settings"}"]`)?.focus();
  }, [setPanel, panel]);
  return <div className="relative min-h-0 flex-1">
    <main className="h-full overflow-y-auto px-4 pb-12 pt-5 scrollbar-thin sm:px-6" hidden={music}>{children}</main>
    <div className={`absolute inset-0 flex flex-col ${music && !nowPlaying ? "" : "invisible pointer-events-none"}`} aria-hidden={!music || nowPlaying} inert={!music || nowPlaying}>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-6"><CollectionActions collection={{ kind: "library" }} />
        <span className="hidden text-xs text-muted md:block">Made for your music.</span></div>
      <iframe key={generation} ref={registerFrame} src="/listen/engine" title="Music library, powered by Plexamp"
        allow="autoplay" className="min-h-0 w-full flex-1 border-0" />
      {!ready && <div className="absolute inset-0 grid place-items-center bg-surface p-8 text-center">
        <div><p className="text-xl font-semibold">{failed ? "Music needs a moment" : "Opening your music…"}</p>
          <p className="mt-2 text-muted">Your player stays connected while you move around Mint.</p>
          {failed && <button onClick={reload} className="mt-5 rounded-full bg-mint px-5 py-3 font-semibold text-mint-ink">Reload player</button>}
        </div>
      </div>}
    </div>
    {nowPlaying && <NowPlaying state={player.state} ready={ready} command={player.command} panel={panel} setPanel={setPanel} returnTo={returnTo} onMore={(track, button) => {
      const rect = button.getBoundingClientRect(); player.menu(track, { x: rect.x, y: rect.bottom }, button);
    }} />}
    {!nowPlaying && panel === "queue" && <PlayerPanel title="Queue" close={closeQueue}><QueueContents state={player.state} command={player.command} /></PlayerPanel>}
    {!nowPlaying && panel === "audio" && <PlayerPanel title="Audio settings" close={closeQueue}><AudioPanel state={player.state} command={player.command} /></PlayerPanel>}
    {!nowPlaying && panel === "lyrics" && <PlayerPanel title="Lyrics" close={closeQueue}><LyricsPanel state={player.state} command={player.command} /></PlayerPanel>}
  </div>;
}

export function PlayerBar() {
  const { state, ready, command } = usePlayer()!;
  const { panel, setPanel, nowPlaying, rememberReturn } = useContext(ShellContext)!;
  const track = state.track;
  if (nowPlaying) return null;
  return <section aria-label="Music player" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-surface px-3 py-2 lg:col-span-2 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,1.3fr)_minmax(0,1fr)] lg:gap-6 lg:px-5 lg:py-3">
    <div className="flex min-w-0 items-center gap-3">
      <Link href="/app/music?view=now-playing" onClick={rememberReturn} aria-label="Open now playing" className="shrink-0 rounded transition-transform active:scale-95"><Artwork track={{ artworkUrl: track?.thumb ?? "" }} className="size-12 rounded" /></Link>
      <div className="min-w-0">
        <Link href="/app/music?view=now-playing" onClick={rememberReturn} className="block truncate text-sm font-semibold hover:underline">{track?.title ?? "Your music, ready when you are"}</Link>
        <p className="truncate text-xs text-muted">{track?.artist ?? (ready ? "Choose a song to start listening" : "Connecting to your library…")}</p>
      </div>
    </div>
    <div className="flex items-center justify-center gap-2 lg:flex-col lg:gap-1">
      <PlaybackControls state={state} ready={ready} command={command} />
      <div className="hidden w-full lg:block"><SeekControl key={track?.queueId ?? "empty"} state={state} ready={ready} command={command} /></div>
    </div>
    <div className="col-span-2 flex min-w-0 items-center gap-2 lg:col-span-1 lg:justify-end">
      <div className="min-w-0 flex-1 lg:hidden"><SeekControl key={track?.queueId ?? "empty"} state={state} ready={ready} command={command} /></div>
      <Transport label="Lyrics" active={panel === "lyrics"} disabled={!ready || !track} onClick={() => setPanel(panel === "lyrics" ? null : "lyrics")}><Mic2 /></Transport>
      <Transport label="Audio settings" active={panel === "audio"} disabled={!ready} onClick={() => setPanel(panel === "audio" ? null : "audio")}><SlidersHorizontal /></Transport>
      <Transport label="Queue" active={panel === "queue"} disabled={!ready} onClick={() => setPanel(panel === "queue" ? null : "queue")}><ListMusic /></Transport>
      <label className="hidden max-w-36 items-center gap-2 xl:flex">
        <Volume2 className="size-4 shrink-0 text-muted" /><span className="sr-only">Volume</span>
        <input aria-label="Volume" type="range" min="0" max="100" value={state.volume} disabled={!ready}
          onChange={(event) => command({ action: "volume", value: Number(event.target.value) })} className="h-4 min-w-0 w-24 accent-mint" />
      </label>
    </div>
  </section>;
}

function TrackMenu({ selection, close, command, browse }: {
  selection: Menu; close: () => void; command: PlayerContext["command"]; browse: (item: PlayerItem) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: Math.max(8, Math.min(selection.x, window.innerWidth - 272)), top: 8 });
  const item = selection.item;
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    setPosition({ left: Math.max(8, Math.min(selection.x, innerWidth - menu.offsetWidth - 8)), top: Math.max(8, Math.min(selection.y, innerHeight - menu.offsetHeight - 8)) });
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close(); return; }
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", key); window.removeEventListener("resize", close); };
  }, [selection, close]);
  const act = (action: PlayerCommand) => { close(); command(action); };
  const menuClass = "w-full rounded px-3 py-2.5 text-left text-sm text-fg hover:bg-hover focus:bg-hover";
  return <div ref={ref} role="menu" aria-label={`Actions for ${item.title}`} style={position}
    onContextMenu={(event) => event.preventDefault()} className="fixed z-[110] max-h-[calc(100dvh-16px)] w-64 overflow-y-auto rounded-lg bg-elevated p-1.5 shadow-[0_14px_40px_-8px_#000] ring-1 ring-line">
    <p className="truncate border-b border-line px-3 py-3 text-xs font-semibold text-muted">{item.title}</p>
    <button role="menuitem" className={menuClass} onClick={() => act({ action: "play", item })}>Play {item.type === "track" ? "now" : item.type}</button>
    {item.type !== "track" && <button role="menuitem" className={menuClass} onClick={() => act({ action: "play", item, shuffle: true })}>Shuffle {item.type}</button>}
    {item.type === "track" && item.grandparentKey && <button role="menuitem" className={menuClass} onClick={() => act({ action: "play", shuffle: true,
      item: { key: item.grandparentKey!, ratingKey: item.grandparentKey!.split("/").pop()!, type: "artist", title: item.artist ?? "Artist" } })}>Shuffle this artist</button>}
    <button role="menuitem" className={menuClass} onClick={() => act({ action: "next-in-queue", item })}>Play next</button>
    <button role="menuitem" className={menuClass} onClick={() => act({ action: "add-to-queue", item })}>Add to queue</button>
    {item.type !== "track" && <button role="menuitem" className={menuClass} onClick={() => { close(); browse(item); }}>Open {item.type}</button>}
    {item.parentKey && <button role="menuitem" className={menuClass} onClick={() => {
      close(); browse({ key: `${item.parentKey}/children`, ratingKey: item.parentKey!.split("/").pop()!, type: "album", title: item.album ?? "Album", artist: item.artist });
    }}>Go to album</button>}
    {item.grandparentKey && <button role="menuitem" className={menuClass} onClick={() => {
      close(); browse({ key: `${item.grandparentKey}/children`, ratingKey: item.grandparentKey!.split("/").pop()!, type: "artist", title: item.artist ?? "Artist" });
    }}>Go to artist</button>}
    {item.queueId && <button role="menuitem" className={menuClass} onClick={() => act({ action: "remove", queueId: item.queueId! })}>Remove from queue</button>}
  </div>;
}

export function TrackMenuButton({ item }: { item: PlayerItem }) {
  const player = usePlayer();
  if (!player) return null;
  return <button aria-label={`More options for ${item.title}`} aria-haspopup="menu" onClick={(event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    player.menu(item, { x: rect.x, y: rect.bottom }, event.currentTarget);
  }} className="rounded-full p-2 text-muted hover:bg-elevated hover:text-fg"><MoreHorizontal className="size-4" /></button>;
}
