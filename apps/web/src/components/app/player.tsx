"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ListMusic, MoreHorizontal, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, X } from "lucide-react";
import { Artwork } from "@/components/artwork";
import { formatDuration } from "@/lib/format";
import { PLAYER_CHANNEL, playerItemSchema, playerStateSchema, type MusicView, type PlayerCommand, type PlayerItem, type PlayerState } from "@/lib/player-protocol";

type Menu = { item: PlayerItem; x: number; y: number; path: string; returnTo: HTMLElement | null };
interface PlayerContext {
  ready: boolean;
  state: PlayerState;
  command: (command: PlayerCommand) => void;
  menu: (item: PlayerItem, point: { x: number; y: number }, returnTo?: HTMLElement | null) => void;
}
const Context = createContext<PlayerContext | null>(null);
interface ShellContext {
  registerFrame: (element: HTMLIFrameElement | null) => void; generation: number; music: boolean; ready: boolean; failed: boolean;
  queueOpen: boolean; setQueueOpen: (open: boolean) => void; reload: () => void;
}
const ShellContext = createContext<ShellContext | null>(null);
export const usePlayer = () => useContext(Context);
const empty: PlayerState = { playing: false, time: 0, duration: 0, volume: 100, shuffle: false, repeat: 0, track: null, queue: [], queueTotal: 0, queueOffset: 0 };
const timestamp = (ms: number) => ms > 0 ? formatDuration(Math.floor(ms / 1000)) : "0:00";

export function MusicNavigation() {
  const path = usePathname(), params = useSearchParams();
  const view = params.get("view") ?? "home";
  return <nav aria-label="Music views" className="flex min-w-0 items-center gap-1 text-xs font-semibold sm:text-sm">
    {(["home", "library", "search"] as const).map((key) => {
      const active = path === "/app/music" && view === key;
      return <Link key={key} href={key === "home" ? "/app/music" : `/app/music?view=${key}`} aria-current={active ? "page" : undefined}
        className={`rounded-full px-3 py-2 hover:bg-hover hover:text-fg ${active ? "bg-elevated text-fg" : "text-muted"}`}>{key === "home" ? "Discover" : key === "library" ? "Browse" : "Search"}</Link>;
    })}
  </nav>;
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const registerFrame = useCallback((element: HTMLIFrameElement | null) => { frame.current = element; }, []);
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<PlayerState>(empty);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Menu | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const music = pathname === "/app/music";
  const rawView = params.get("view");
  const view: MusicView = rawView === "search" || rawView === "library" || rawView === "now-playing" ? rawView : "home";

  const command = useCallback((command: PlayerCommand) => {
    if (!ready || !frame.current?.contentWindow) { setError("The music engine is still starting. Try again in a moment."); return; }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.current.delete(id);
      setError("The music engine did not respond. Reload the player and try again.");
      setFailed(true);
    }, 20_000);
    pending.current.set(id, timer);
    frame.current.contentWindow.postMessage({ channel: PLAYER_CHANNEL, type: "command", id, command }, location.origin);
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
      if (data.type === "result" && typeof data.id === "string" && pending.current.has(data.id)) {
        clearTimeout(pending.current.get(data.id));
        pending.current.delete(data.id);
        if (!data.ok) setError(typeof data.message === "string" ? data.message.slice(0, 500) : "This playback action failed. Try again.");
      }
      if (data.type === "menu") {
        const item = playerItemSchema.safeParse(data.item);
        const rect = frame.current?.getBoundingClientRect();
        if (item.success && rect && Number.isFinite(data.point?.x) && Number.isFinite(data.point?.y)) {
          setSelection({ item: item.data, x: rect.x + data.point.x, y: rect.y + data.point.y, path: location.pathname, returnTo: frame.current });
        }
      }
    }
    window.addEventListener("message", receive);
    const timers = pending.current;
    return () => { window.removeEventListener("message", receive); timers.forEach(clearTimeout); timers.clear(); };
  }, []);

  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => { setFailed(true); setError("The music engine could not start. Reload the player, or check that the web image includes its player assets."); }, 30_000);
    return () => clearTimeout(timer);
  }, [ready, generation]);
  useEffect(() => {
    if (ready && music) command({ action: "navigate", view });
  }, [ready, music, view, command]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.target !== document.body || !state.track) return;
      event.preventDefault();
      command({ action: "toggle" });
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [command, state.track]);

  const closeMenu = useCallback(() => { selection?.returnTo?.focus(); setSelection(null); }, [selection]);
  const showMenu: PlayerContext["menu"] = (item, point, returnTo) => setSelection({ item, ...point, path: pathname, returnTo: returnTo ?? null });
  const browse = (item: PlayerItem) => { router.push("/app/music?view=library"); command({ action: "browse", item }); };
  const reload = () => {
    pending.current.forEach(clearTimeout); pending.current.clear();
    setReady(false); setFailed(false); setError(null); setState(empty); setGeneration((n) => n + 1);
  };

  return (
    <Context.Provider value={{ ready, state, command, menu: showMenu }}>
      <ShellContext.Provider value={{ registerFrame, generation, music, ready, failed, queueOpen, setQueueOpen, reload }}>
        {children}
      </ShellContext.Provider>
      {(error || selection) && createPortalSafe(
        <div className="contents">
          {error && <div role="alert" className="fixed top-3 right-3 left-3 z-[100] mx-auto flex max-w-2xl items-center gap-3 rounded-lg bg-elevated p-4 text-sm text-fg shadow-[0_12px_30px_-8px_#000] ring-1 ring-line">
            <p className="flex-1">{error}</p>
            {failed && <button onClick={reload} className="shrink-0 rounded-full bg-mint px-3 py-2 font-semibold text-mint-ink">Reload player</button>}
            <button aria-label="Dismiss message" onClick={() => setError(null)} className="rounded-full p-2 hover:bg-hover"><X className="size-4" /></button>
          </div>}
          {selection && selection.path === pathname && <TrackMenu selection={selection} close={closeMenu} command={command} browse={browse} />}
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
  const { registerFrame, generation, music, ready, failed, queueOpen, setQueueOpen, reload } = useContext(ShellContext)!;
  const player = usePlayer()!;
  const closeQueue = useCallback(() => {
    setQueueOpen(false);
    document.querySelector<HTMLButtonElement>('button[aria-label="Queue"]')?.focus();
  }, [setQueueOpen]);
  return <div className="relative min-h-0 flex-1">
    <main className="h-full overflow-y-auto px-4 pb-12 pt-5 scrollbar-thin sm:px-6" hidden={music}>{children}</main>
    <div className={`absolute inset-0 ${music ? "" : "invisible pointer-events-none"}`} aria-hidden={!music} inert={!music}>
      <iframe key={generation} ref={registerFrame} src="/listen/engine" title="Music library, powered by Plexamp"
        allow="autoplay" className="h-full w-full border-0" />
      {!ready && <div className="absolute inset-0 grid place-items-center bg-surface p-8 text-center">
        <div><p className="text-xl font-semibold">{failed ? "Music needs a moment" : "Opening your music…"}</p>
          <p className="mt-2 text-muted">Plexamp stays connected while you move around Mint.</p>
          {failed && <button onClick={reload} className="mt-5 rounded-full bg-mint px-5 py-3 font-semibold text-mint-ink">Reload player</button>}
        </div>
      </div>}
    </div>
    {queueOpen && <QueuePanel state={player.state} command={player.command} close={closeQueue} />}
  </div>;
}

export function PlayerBar() {
  const { state, ready, command } = usePlayer()!;
  const { queueOpen, setQueueOpen } = useContext(ShellContext)!;
  const track = state.track;
  return <section aria-label="Music player" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-surface px-3 py-2 lg:col-span-2 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,1.3fr)_minmax(0,1fr)] lg:gap-6 lg:px-5 lg:py-3">
    <div className="flex min-w-0 items-center gap-3">
      <Artwork track={{ artworkUrl: track?.thumb ?? "" }} className="size-12 shrink-0 rounded" />
      <div className="min-w-0">
        <Link href="/app/music?view=now-playing" className="block truncate text-sm font-semibold hover:underline">{track?.title ?? "Your music, ready when you are"}</Link>
        <p className="truncate text-xs text-muted">{track?.artist ?? (ready ? "Choose a song to start listening" : "Connecting to your library…")}</p>
      </div>
    </div>
    <div className="flex items-center justify-center gap-2 lg:flex-col lg:gap-1">
      <div className="flex items-center justify-center gap-1">
        <Transport label="Shuffle" active={state.shuffle} disabled={!ready || !track} onClick={() => command({ action: "shuffle" })} className="hidden sm:inline-flex"><Shuffle /></Transport>
        <Transport label="Previous track" disabled={!ready || !track} onClick={() => command({ action: "previous" })} className="hidden sm:inline-flex"><SkipBack /></Transport>
        <button aria-label={state.playing ? "Pause" : "Play"} disabled={!ready || !track} onClick={() => command({ action: "toggle" })}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-mint text-mint-ink transition hover:bg-mint-strong disabled:cursor-not-allowed disabled:opacity-40">
          {state.playing ? <Pause className="size-5" fill="currentColor" /> : <Play className="size-5" fill="currentColor" />}
        </button>
        <Transport label="Next track" disabled={!ready || !track} onClick={() => command({ action: "next" })}><SkipForward /></Transport>
        <Transport label={state.repeat === 1 ? "Repeat one" : "Repeat"} active={state.repeat > 0} disabled={!ready || !track} onClick={() => command({ action: "repeat" })} className="hidden sm:inline-flex">{state.repeat === 1 ? <Repeat1 /> : <Repeat />}</Transport>
      </div>
      <label className="hidden w-full items-center gap-2 text-[11px] text-muted tabular lg:flex">
        <span className="w-9 text-right">{timestamp(state.time)}</span><span className="sr-only">Seek</span>
        <input aria-label="Seek" type="range" min="0" max={state.duration || 1} step="1000" value={Math.min(state.time, state.duration)}
          disabled={!ready || !track} onChange={(event) => command({ action: "seek", value: Number(event.target.value) })} className="h-4 min-w-0 flex-1 cursor-pointer accent-mint" />
        <span className="w-9">{timestamp(state.duration)}</span>
      </label>
    </div>
    <div className="col-span-2 flex min-w-0 items-center gap-2 lg:col-span-1 lg:justify-end">
      <label className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-muted tabular lg:hidden">
        <span>{timestamp(state.time)}</span><span className="sr-only">Seek</span>
        <input aria-label="Seek" type="range" min="0" max={state.duration || 1} step="1000" value={Math.min(state.time, state.duration)}
          disabled={!ready || !track} onChange={(event) => command({ action: "seek", value: Number(event.target.value) })} className="h-4 min-w-0 flex-1 accent-mint" />
        <span>{timestamp(state.duration)}</span>
      </label>
      <Transport label="Queue" active={queueOpen} disabled={!ready} onClick={() => setQueueOpen(!queueOpen)}><ListMusic /></Transport>
      <label className="hidden max-w-36 items-center gap-2 lg:flex">
        <Volume2 className="size-4 shrink-0 text-muted" /><span className="sr-only">Volume</span>
        <input aria-label="Volume" type="range" min="0" max="100" value={state.volume} disabled={!ready}
          onChange={(event) => command({ action: "volume", value: Number(event.target.value) })} className="h-4 min-w-0 w-24 accent-mint" />
      </label>
    </div>
  </section>;
}

function Transport({ children, label, active, disabled, onClick, className = "" }: {
  children: React.ReactNode; label: string; active?: boolean; disabled?: boolean; onClick: () => void; className?: string;
}) {
  return <button aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}
    className={`size-10 shrink-0 items-center justify-center rounded-full transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40 [&>svg]:size-4 ${active ? "text-mint" : "text-muted hover:text-fg"} ${className || "inline-flex"}`}>{children}</button>;
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

function QueuePanel({ state, command, close }: { state: PlayerState; command: PlayerContext["command"]; close: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [close]);
  return <aside aria-label="Play queue" className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-line bg-surface p-4 sm:w-80">
    <div className="flex items-center justify-between"><h2 className="text-xl font-bold">Queue</h2><button ref={closeRef} aria-label="Close queue" onClick={close} className="rounded-full p-2 hover:bg-hover"><X className="size-5" /></button></div>
    <div className="my-4 flex items-center justify-between text-xs text-muted"><span>{state.queueTotal} {state.queueTotal === 1 ? "track" : "tracks"}</span>
      {state.queueTotal > 1 && <button onClick={() => command({ action: "clear" })} className="rounded-full px-3 py-2 hover:bg-hover hover:text-fg">Clear upcoming</button>}
    </div>
    {state.queueTotal > state.queue.length && <p className="mb-3 text-xs text-muted">Showing tracks {state.queueOffset + 1}–{state.queueOffset + state.queue.length} around your current song.</p>}
    <ol className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      {state.queue.map((track) => <li key={track.queueId} className={`group flex items-center gap-2 rounded-md p-2 hover:bg-hover ${track.queueId === state.track?.queueId ? "text-mint" : "text-fg"}`}>
        <button onClick={() => command({ action: "skip", queueId: track.queueId! })} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Play ${track.title}`} aria-current={track.queueId === state.track?.queueId ? "true" : undefined}>
          <Artwork track={{ artworkUrl: track.thumb ?? "" }} className="size-10 shrink-0 rounded" />
          <span className="min-w-0"><span className="block truncate text-sm font-semibold">{track.title}</span><span className="block truncate text-xs text-muted">{track.artist}</span></span>
        </button>
        <button aria-label={`Remove ${track.title} from queue`} onClick={() => command({ action: "remove", queueId: track.queueId! })} className="rounded-full p-2 text-muted hover:bg-elevated hover:text-fg"><X className="size-4" /></button>
      </li>)}
    </ol>
    {!state.queue.length && <p className="py-8 text-sm text-muted">Play a song or album to start your queue.</p>}
  </aside>;
}

export function TrackMenuButton({ item }: { item: PlayerItem }) {
  const player = usePlayer();
  if (!player) return null;
  return <button aria-label={`More options for ${item.title}`} aria-haspopup="menu" onClick={(event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    player.menu(item, { x: rect.x, y: rect.bottom }, event.currentTarget);
  }} className="rounded-full p-2 text-muted hover:bg-elevated hover:text-fg"><MoreHorizontal className="size-4" /></button>;
}
