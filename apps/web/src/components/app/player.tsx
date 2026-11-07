"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ListMusic, Mic2, MonitorSpeaker, MoreHorizontal, Volume2, VolumeX, X } from "lucide-react";
import { Artwork } from "@/components/artwork";
import { playerItemSchema, type PlayerCommand, type PlayerItem, type PlayerState } from "@/lib/player-protocol";
import { analysisSchema } from "@mint/core/analysis";
import { authorizeOffline, clearOffline, listOffline, offlineAudio, offlineSettings } from "@/lib/offline";
import { startDeviceBridge } from "@/lib/device-client";
import { randomId } from "@/lib/id";
import { ListeningHistory } from "@/lib/listening-history";
import { TrackMusicActions } from "./track-music-actions";
import { NativePlayer } from "@/lib/native-player";
import { collectionParams, itemCollection } from "@/lib/browser-catalog";
import { LyricsPanel, PlayerPanel, QueueContents } from "./player-panels";
import { PlaybackControls, SeekControl, Transport } from "./player-controls";
import { NowPlaying } from "./now-playing";
import { useAccountPlayback } from "./account-playback";
import { ArtistLink } from "./music-links";
import { MusicItem } from "./music-item";
import { playerSheetArtworkOrigin, playerSheetDestination, playerSheetProgress, playerSheetReleaseVelocity, stepPlayerSheetSpring } from "./player-sheet-gesture";

type Menu = { item: PlayerItem; x: number; y: number; path: string; returnTo: HTMLElement | null };
type SheetGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  startProgress: number;
  travel: number;
  origin: HTMLElement;
  captureTarget: HTMLElement;
  scrollCollapse: boolean;
  active: boolean;
  samples: { y: number; time: number }[];
};
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
  sheetActive: boolean;
  measureSheetArtwork: () => void;
  panel: "queue" | "lyrics" | null; setPanel: (panel: "queue" | "lyrics" | null) => void;
  returnTo: string; rememberReturn: () => void;
  restorePageScroll: () => void;
  expandPlayer: (opener?: HTMLElement | null) => void;
  collapsePlayer: () => void;
  onSheetPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onSheetPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onSheetPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onSheetPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onSheetLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onSheetClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
}
const ShellContext = createContext<ShellContext | null>(null);
export const usePlayer = () => useContext(Context);
const empty: PlayerState = { playing: false, time: 0, duration: 0, volume: 100, shuffle: false, repeat: 0, track: null, queue: [], queueTotal: 0, queueOffset: 0 };

export function SearchShortcut() {
  const pathname = usePathname(), router = useRouter();
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches("input,textarea,select,button,[role=button],[role=menuitem]"))) return;
      const shortcut = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey ||
        event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey;
      if (!shortcut) return;
      event.preventDefault();
      if (pathname === "/app/search") window.dispatchEvent(new Event("mint:focus-search"));
      else router.push("/app/search");
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [pathname, router]);
  return null;
}

export function PlayerProvider({ children, memberId }: { children: React.ReactNode; memberId: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const nowPlaying = pathname === "/app/now-playing";
  const first = useRef<HTMLAudioElement>(null), second = useRef<HTMLAudioElement>(null);
  const engine = useRef<NativePlayer | null>(null);
  const selectionRequest = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<PlayerState>(empty);
  const ready = state.dsp !== undefined;
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Menu | null>(null);
  const [returnTo, setReturnTo] = useState("/app/library");
  const returnToRef = useRef(returnTo);
  const [sheetActive, setSheetActive] = useState(nowPlaying);
  const sheetProgress = useRef(0);
  const sheetFrame = useRef<number | null>(null);
  const sheetTarget = useRef(0);
  const gesture = useRef<SheetGesture | null>(null);
  const suppressClick = useRef(false);
  const suppressClickTimer = useRef<number | null>(null);
  const focusReturn = useRef<HTMLElement | null>(null);
  const pageScrollPosition = useRef(0);
  const pendingFocusRestore = useRef(false);
  const [panelSelection, setPanelSelection] = useState<{ surface: string; value: ShellContext["panel"] } | null>(null);
  const surface = `${pathname}?${params.toString()}`;
  const requestedPanel = pathname === "/app/now-playing" && (params.get("tab") === "lyrics" || params.get("tab") === "queue") ? params.get("tab") as "lyrics" | "queue" : null;
  const panel = panelSelection?.surface === surface ? panelSelection.value : requestedPanel;
  const setPanel = useCallback((value: ShellContext["panel"]) => setPanelSelection({ surface, value }), [surface]);
  const nowPlayingRef = useRef(nowPlaying);
  const restorePageScroll = useCallback(() => {
    const content = document.querySelector<HTMLElement>(".listening-content");
    if (content) content.scrollTop = pageScrollPosition.current;
  }, []);
  useEffect(() => {
    nowPlayingRef.current = nowPlaying;
    returnToRef.current = returnTo;
  }, [nowPlaying, returnTo]);
  const rememberReturn = useCallback(() => {
    const destination = `${location.pathname}${location.search}`;
    returnToRef.current = destination;
    setReturnTo(destination);
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pageScrollPosition.current = document.querySelector<HTMLElement>(".listening-content")?.scrollTop ?? 0;
    setSheetActive(true);
  }, []);

  const writeSheetProgress = useCallback((progress: number) => {
    sheetProgress.current = progress;
    document.documentElement.style.setProperty("--player-progress", String(progress));
    document.documentElement.toggleAttribute("data-player-sheet-moving", progress !== 1);
  }, []);

  const measureSheet = useCallback(() => {
    const dock = document.querySelector<HTMLElement>(".player-dock");
    const offset = dock ? dock.getBoundingClientRect().top : window.innerHeight;
    document.documentElement.style.setProperty("--player-collapse-offset", `${Math.max(0, offset)}px`);
  }, []);

  const measureSheetArtwork = useCallback(() => {
    measureSheet();
    const root = document.documentElement;
    const progress = sheetProgress.current;
    root.style.setProperty("--player-progress", "1");
    let mini: DOMRect | undefined;
    let expanded: DOMRect | undefined;
    try {
      mini = document.querySelector<HTMLElement>(".player-mini-artwork")?.getBoundingClientRect();
      expanded = document.querySelector<HTMLElement>(".player-expanded-artwork .now-playing-art")?.getBoundingClientRect();
    } finally {
      writeSheetProgress(progress);
    }

    if (!mini || !expanded) {
      root.style.setProperty("--player-art-from-x", "0px");
      root.style.setProperty("--player-art-from-y", "0px");
      root.style.setProperty("--player-art-from-scale", "1");
      return;
    }

    const collapseOffset = Number.parseFloat(root.style.getPropertyValue("--player-collapse-offset")) || 0;
    const origin = playerSheetArtworkOrigin(
      { x: mini.left, y: mini.top, width: mini.width, height: mini.height },
      { x: expanded.left, y: expanded.top, width: expanded.width, height: expanded.height },
      collapseOffset,
    );
    root.style.setProperty("--player-art-from-x", `${origin.x}px`);
    root.style.setProperty("--player-art-from-y", `${origin.y}px`);
    root.style.setProperty("--player-art-from-scale", String(origin.scale));
    root.style.setProperty("--player-art-expanded-x", `${expanded.left}px`);
    root.style.setProperty("--player-art-expanded-y", `${expanded.top}px`);
    root.style.setProperty("--player-art-expanded-width", `${expanded.width}px`);
  }, [measureSheet, writeSheetProgress]);

  const finishSheet = useCallback((destination: number, navigate: boolean) => {
    sheetTarget.current = destination;
    writeSheetProgress(destination);
    if (destination === 1) {
      setSheetActive(true);
      if (navigate && !nowPlayingRef.current) router.push("/app/now-playing", { scroll: false });
      return;
    }

    setSheetActive(false);
    if (navigate && nowPlayingRef.current) {
      pendingFocusRestore.current = true;
      router.replace(returnToRef.current, { scroll: false });
    } else {
      requestAnimationFrame(() => {
        const preferred = focusReturn.current;
        const fallback = document.querySelector<HTMLElement>('[aria-label="Expand player"]');
        (preferred?.isConnected ? preferred : fallback)?.focus({ preventScroll: true });
      });
    }
  }, [router, writeSheetProgress]);

  const settleSheet = useCallback((destination: number, velocity = 0, navigate = true) => {
    if (sheetFrame.current !== null) cancelAnimationFrame(sheetFrame.current);
    sheetFrame.current = null;
    measureSheetArtwork();
    sheetTarget.current = destination;
    setSheetActive(true);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      sheetFrame.current = null;
      finishSheet(destination, navigate);
      return;
    }

    let spring = { position: sheetProgress.current, velocity };
    let previous = performance.now();
    const frame = (time: number) => {
      const elapsed = Math.min(time - previous, 32);
      previous = time;
      spring = stepPlayerSheetSpring(spring, destination, elapsed);
      writeSheetProgress(spring.position);
      if (Math.abs(spring.position - destination) < 0.001 && Math.abs(spring.velocity) < 0.01) {
        sheetFrame.current = null;
        finishSheet(destination, navigate);
      } else {
        sheetFrame.current = requestAnimationFrame(frame);
      }
    };
    sheetFrame.current = requestAnimationFrame(frame);
  }, [finishSheet, measureSheetArtwork, writeSheetProgress]);

  const expandPlayer = useCallback((opener?: HTMLElement | null) => {
    if (!nowPlayingRef.current) {
      const destination = `${pathname}${location.search}`;
      returnToRef.current = destination;
      setReturnTo(destination);
      pageScrollPosition.current = document.querySelector<HTMLElement>(".listening-content")?.scrollTop ?? 0;
    }
    focusReturn.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    settleSheet(1);
  }, [pathname, settleSheet]);

  const collapsePlayer = useCallback(() => settleSheet(0), [settleSheet]);

  const onSheetPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0 || gesture.current) return;
    const target = event.target instanceof Element ? event.target : null;
    const handle = target?.closest("[data-player-drag-handle]");
    const dragRegion = target?.closest("[data-player-drag-region]");
    const dragSurface = target?.closest("[data-player-drag-surface]");
    const scrollTarget = target?.closest("[data-player-sheet-scroll]");
    const scrollRegion = scrollTarget instanceof HTMLElement ? scrollTarget : null;
    if (!handle && !dragRegion && !dragSurface && !scrollRegion) return;
    if (target?.closest("button,input,select,textarea,[role=button],[role=menuitem],[contenteditable=true]") && !handle) return;
    if (scrollRegion && (scrollRegion.scrollTop > 0 || !nowPlayingRef.current)) return;
    if (nowPlayingRef.current) measureSheetArtwork();
    suppressClick.current = false;
    if (suppressClickTimer.current !== null) window.clearTimeout(suppressClickTimer.current);
    const time = performance.now();
    const currentTarget = event.currentTarget;
    const captureTarget = target?.closest<HTMLElement>("a[href]") ?? currentTarget;
    if (!scrollRegion) {
      try { captureTarget.setPointerCapture(event.pointerId); } catch { /* The pointer may already have been canceled. */ }
    }
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startProgress: sheetProgress.current,
      travel: Math.max(1, Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--player-collapse-offset")) || window.innerHeight),
      origin: currentTarget,
      captureTarget,
      scrollCollapse: Boolean(scrollRegion),
      active: false,
      samples: [{ y: event.clientY, time }],
    };
  }, [measureSheetArtwork]);

  const onSheetPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const deltaX = event.clientX - current.startX;
    const deltaY = event.clientY - current.startY;
    if (!current.active) {
      if (Math.abs(deltaX) < 6 && Math.abs(deltaY) < 6) return;
      if (Math.abs(deltaY) <= Math.abs(deltaX) * 1.15) {
        gesture.current = null;
        return;
      }
      if (current.scrollCollapse && deltaY < 0) {
        gesture.current = null;
        return;
      }
      if (window.getSelection() && !window.getSelection()?.isCollapsed) {
        gesture.current = null;
        return;
      }
      if (sheetFrame.current !== null) cancelAnimationFrame(sheetFrame.current);
      sheetFrame.current = null;
      current.active = true;
      current.startProgress = sheetProgress.current;
      current.startY = event.clientY;
      current.samples = [];
      setSheetActive(true);
      if (!nowPlayingRef.current) {
        focusReturn.current = current.origin;
        const destination = `${pathname}${location.search}`;
        returnToRef.current = destination;
        setReturnTo(destination);
        pageScrollPosition.current = document.querySelector<HTMLElement>(".listening-content")?.scrollTop ?? 0;
      }
      if (!current.captureTarget.hasPointerCapture(event.pointerId)) {
        try { current.captureTarget.setPointerCapture(event.pointerId); } catch { /* The browser may have taken over scrolling. */ }
      }
      if (!current.scrollCollapse && event.nativeEvent.cancelable) event.preventDefault();
    }
    const time = performance.now();
    current.samples.push({ y: event.clientY, time });
    while (current.samples.length > 2 && time - (current.samples[0]?.time ?? time) > 120) current.samples.shift();
    writeSheetProgress(playerSheetProgress(current.startProgress, current.startY, event.clientY, current.travel));
  }, [pathname, writeSheetProgress]);

  const suppressNextClick = useCallback(() => {
    suppressClick.current = true;
    if (suppressClickTimer.current !== null) window.clearTimeout(suppressClickTimer.current);
    suppressClickTimer.current = window.setTimeout(() => { suppressClick.current = false; }, 500);
  }, []);

  const onSheetPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    gesture.current = null;
    if (!current.active) return;
    suppressNextClick();
    const velocity = playerSheetReleaseVelocity(current.samples, current.travel, performance.now());
    settleSheet(playerSheetDestination(sheetProgress.current, velocity), velocity);
  }, [settleSheet, suppressNextClick]);

  const onSheetPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    gesture.current = null;
    if (!current.active) return;
    suppressNextClick();
    settleSheet(playerSheetDestination(sheetProgress.current, 0), 0);
  }, [settleSheet, suppressNextClick]);

  const onSheetLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    gesture.current = null;
    if (current.active) {
      suppressNextClick();
      settleSheet(playerSheetDestination(sheetProgress.current, 0), 0);
    }
  }, [settleSheet, suppressNextClick]);

  const onSheetClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClick.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick.current = false;
    if (suppressClickTimer.current !== null) window.clearTimeout(suppressClickTimer.current);
  }, []);

  const command = useCallback((command: PlayerCommand): Promise<boolean> => {
    if (!engine.current) { setError("The player is still starting. Try again in a moment."); return Promise.resolve(false); }
    setError(null);
    const id = randomId();
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
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !selection && (nowPlaying || sheetActive)) {
        event.preventDefault();
        collapsePlayer();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [collapsePlayer, nowPlaying, selection, sheetActive]);
  const previousRoute = useRef(false);
  useEffect(() => {
    if (previousRoute.current === nowPlaying) return;
    previousRoute.current = nowPlaying;
    if (nowPlaying) {
      if (sheetProgress.current < 0.999) settleSheet(1, 0, false);
    } else if (sheetProgress.current > 0.001) {
      settleSheet(0, 0, false);
    }
  }, [nowPlaying, settleSheet]);
  useEffect(() => {
    if (nowPlaying || !pendingFocusRestore.current) return;
    pendingFocusRestore.current = false;
    requestAnimationFrame(() => {
      const preferred = focusReturn.current;
      const fallback = document.querySelector<HTMLElement>('[aria-label="Expand player"]');
      (preferred?.isConnected ? preferred : fallback)?.focus({ preventScroll: true });
    });
  }, [nowPlaying]);
  useEffect(() => {
    const app = document.querySelector<HTMLElement>(".app-shell");
    if (!app) return;
    app.inert = nowPlaying;
    return () => { app.inert = false; };
  }, [nowPlaying]);
  useEffect(() => {
    const dock = document.querySelector<HTMLElement>(".player-dock");
    measureSheet();
    const observer = dock && "ResizeObserver" in window ? new ResizeObserver(measureSheetArtwork) : null;
    if (dock) observer?.observe(dock);
    const resize = () => {
      measureSheetArtwork();
      const current = gesture.current;
      if (!current) return;
      gesture.current = null;
      if (current.active) {
        suppressNextClick();
        settleSheet(playerSheetDestination(sheetProgress.current, 0), 0);
      }
    };
    const visibility = () => {
      if (document.visibilityState !== "hidden") return;
      const current = gesture.current;
      gesture.current = null;
      if (sheetFrame.current !== null) cancelAnimationFrame(sheetFrame.current);
      sheetFrame.current = null;
      finishSheet(current?.active ? playerSheetDestination(sheetProgress.current, 0) : sheetTarget.current, true);
    };
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibility);
      if (sheetFrame.current !== null) cancelAnimationFrame(sheetFrame.current);
      if (suppressClickTimer.current !== null) window.clearTimeout(suppressClickTimer.current);
    };
  }, [finishSheet, measureSheet, measureSheetArtwork, settleSheet, suppressNextClick]);
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
      <ShellContext.Provider value={{
        nowPlaying, sheetActive, measureSheetArtwork, ready, panel, setPanel, returnTo, rememberReturn, restorePageScroll, expandPlayer, collapsePlayer,
        onSheetPointerDown, onSheetPointerMove, onSheetPointerUp, onSheetPointerCancel, onSheetLostPointerCapture, onSheetClickCapture,
      }}>
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
  const shell = useContext(ShellContext)!;
  const { nowPlaying, sheetActive, ready, panel, setPanel, measureSheetArtwork, restorePageScroll } = shell;
  const player = usePlayer()!;
  useLayoutEffect(() => {
    if (sheetActive || nowPlaying) measureSheetArtwork();
  }, [measureSheetArtwork, nowPlaying, player.state.track?.id, sheetActive]);
  useLayoutEffect(() => {
    if (!nowPlaying) restorePageScroll();
  }, [nowPlaying, restorePageScroll]);
  const closeQueue = useCallback(() => {
    setPanel(null);
    document.querySelector<HTMLButtonElement>(`button[aria-label="${panel === "queue" ? "Queue" : "Lyrics"}"]`)?.focus();
  }, [setPanel, panel]);
  return <div className="relative min-h-0 flex-1">
    {!nowPlaying && <main id="listening-content" tabIndex={-1} className="listening-content h-full overflow-y-auto scrollbar-thin">{children}</main>}
    {!nowPlaying && panel === "queue" && <PlayerPanel title="Queue" close={closeQueue}><QueueContents state={player.state} command={player.command} /></PlayerPanel>}
    {!nowPlaying && panel === "lyrics" && <PlayerPanel title="Lyrics" close={closeQueue}><LyricsPanel state={player.state} command={player.command} /></PlayerPanel>}
    {(nowPlaying || sheetActive) && createPortalSafe(
      <NowPlaying
        state={player.state}
        ready={ready}
        command={player.command}
        panel={panel}
        setPanel={setPanel}
        interactive={nowPlaying}
        onCollapse={shell.collapsePlayer}
        onPointerDown={shell.onSheetPointerDown}
        onPointerMove={shell.onSheetPointerMove}
        onPointerUp={shell.onSheetPointerUp}
        onPointerCancel={shell.onSheetPointerCancel}
        onLostPointerCapture={shell.onSheetLostPointerCapture}
        onClickCapture={shell.onSheetClickCapture}
        onMore={(track, button) => {
          const rect = button.getBoundingClientRect(); player.menu(track, { x: rect.x, y: rect.bottom }, button);
        }}
      />,
    )}
  </div>;
}

export function PlayerBar() {
  const { state, ready, command } = usePlayer()!;
  const shell = useContext(ShellContext)!;
  const { panel, setPanel, nowPlaying, sheetActive, rememberReturn, expandPlayer } = shell;
  const account = useAccountPlayback(state.playing, state.time);
  const mirror = account && !account.here ? account : null;
  const view = mirror?.state ?? state;
  const transport = mirror?.control ?? command;
  const track = view.track;
  const place = mirror?.deviceName ?? (account?.here ? account.deviceName : null);
  const where = place && track ? `${view.playing ? "Playing" : "Paused"} on ${place}` : null;
  const preview = (milliseconds: number | null) => (mirror ?? account)?.preview(milliseconds);
  const previousVolume = useRef(100);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || !view.track) return;
      if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,button,a,[role=tab],[role=menuitem],[role=button],[contenteditable=true]")) return;
      event.preventDefault();
      void transport({ action: "toggle" });
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [transport, view.track]);
  return <section
    aria-label="Music player"
    aria-hidden={nowPlaying}
    data-sheet-active={sheetActive || undefined}
    data-player-drag-surface
    inert={nowPlaying}
    onPointerDown={shell.onSheetPointerDown}
    onPointerMove={shell.onSheetPointerMove}
    onPointerUp={shell.onSheetPointerUp}
    onPointerCancel={shell.onSheetPointerCancel}
    onLostPointerCapture={shell.onSheetLostPointerCapture}
    onClickCapture={shell.onSheetClickCapture}
    onClick={(event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("a,button,input,select,textarea,[role=button]")) expandPlayer(event.currentTarget);
    }}
    className="player-dock relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-line bg-surface px-3 py-3 md:col-span-2 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,1.3fr)_minmax(0,1fr)] lg:gap-6 lg:px-6"
  >
    <MusicItem item={track} data-player-drag-surface className="flex min-w-0 items-center gap-3">
      <Link href="/app/now-playing" onClick={rememberReturn} aria-label="Expand player"
        onKeyDown={(event) => { if (event.key === "ArrowUp") { event.preventDefault(); expandPlayer(event.currentTarget); } }}
        className="player-mini-artwork shrink-0 rounded"><Artwork track={{ artworkUrl: track?.thumb ?? "" }} className="size-10 rounded lg:size-12" /></Link>
      <div className="min-w-0">
        <Link href="/app/now-playing" onClick={rememberReturn} className="block truncate text-sm font-semibold hover:underline">{track?.title ?? "Nothing playing"}</Link>
        <p className="mt-1 truncate text-xs text-muted">{track ? <><ArtistLink item={track} />{where ? <span className="text-mint"> · {where}</span> : null}</> : ready ? "Choose a song to play" : "Connecting…"}</p>
      </div>
      {track && <div className="hidden xl:block"><TrackMenuButton item={track} /></div>}
    </MusicItem>
    <div className="flex items-center justify-end gap-2 lg:col-start-2 lg:row-start-1 lg:flex-col lg:gap-1">
      <PlaybackControls state={view} ready={mirror ? Boolean(track) : ready} command={transport} />
      <Link href="/app/now-playing?tab=queue" onClick={rememberReturn} aria-label="Open queue" className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg lg:hidden"><ListMusic className="size-5" /></Link>
      <div className="hidden w-full lg:block"><SeekControl key={track?.queueId ?? track?.id ?? "empty"} state={view} ready={mirror ? Boolean(track) : ready} command={transport} previewMs={mirror?.scrubMs ?? account?.scrubMs} onPreview={preview} /></div>
    </div>
    <div className="hidden min-w-0 items-center gap-2 lg:col-start-3 lg:row-start-1 lg:flex lg:justify-end">
      <Transport label="Lyrics" active={panel === "lyrics"} disabled={!ready || !track} onClick={() => setPanel(panel === "lyrics" ? null : "lyrics")}><Mic2 /></Transport>
      <Transport label="Queue" active={panel === "queue"} disabled={!ready} onClick={() => setPanel(panel === "queue" ? null : "queue")}><ListMusic /></Transport>
      <Link href="/app/settings?section=devices" aria-label="Devices" title="Devices" className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"><MonitorSpeaker className="size-5" /></Link>
      <div className="flex max-w-36 items-center gap-1">
        <Transport label={view.volume ? "Mute" : "Unmute"} disabled={mirror ? !track : !ready} onClick={() => {
          if (view.volume) previousVolume.current = view.volume;
          void transport({ action: "volume", value: view.volume ? 0 : previousVolume.current });
        }}>{view.volume ? <Volume2 /> : <VolumeX />}</Transport>
        <input aria-label="Volume" type="range" min="0" max="100" value={view.volume} disabled={mirror ? !track : !ready}
          onChange={(event) => void transport({ action: "volume", value: Number(event.target.value) })} className="h-8 min-w-0 w-20 accent-mint" />
      </div>
    </div>
    <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-line lg:hidden"><div className="h-full bg-mint" style={{ width: `${view.duration ? Math.min(100, (mirror?.scrubMs ?? account?.scrubMs ?? view.time) / view.duration * 100) : 0}%` }} /></div>
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
