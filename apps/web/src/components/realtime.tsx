"use client";

import type { RealtimeEvent, Stats, TrackView } from "@mint/core/events";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { endpointOnPage } from "@/lib/page-endpoint";

type Listener = (e: RealtimeEvent) => void;
type Status = "connecting" | "live" | "offline";

interface Hub {
  subscribe(fn: Listener): () => void;
  status(): Status;
  onStatus(fn: () => void): () => void;
}

const Ctx = createContext<Hub | null>(null);

function wsUrl() {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return endpointOnPage(configured, window.location);
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`;
}

/** One shared WebSocket per tab with exponential backoff reconnects. */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const statusListeners = useRef(new Set<() => void>());
  const status = useRef<Status>("connecting");

  const [hub] = useState<Hub>(() => ({
    subscribe(fn) {
      listeners.current.add(fn);
      return () => void listeners.current.delete(fn);
    },
    status: () => status.current,
    onStatus(fn) {
      statusListeners.current.add(fn);
      return () => void statusListeners.current.delete(fn);
    },
  }));

  useEffect(() => {
    let ws: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const setStatus = (s: Status) => {
      status.current = s;
      statusListeners.current.forEach((f) => f());
    };

    const connect = async () => {
      setStatus("connecting");
      // The gateway may be on another origin, so authenticate with a one-minute signed ticket.
      const ticket = await fetch("/api/realtime/ticket", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ ticket: string | null }>) : { ticket: null }))
        .then((r) => r.ticket)
        .catch(() => null);
      if (closed) return;
      const url = new URL(wsUrl());
      if (ticket) url.searchParams.set("ticket", ticket);
      ws = new WebSocket(url);
      ws.onopen = () => {
        attempt = 0;
        setStatus("live");
      };
      ws.onmessage = (msg) => {
        try {
          const event = JSON.parse(String(msg.data)) as RealtimeEvent;
          listeners.current.forEach((f) => f(event));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = (e) => {
        setStatus("offline");
        if (closed) return;
        // 4401 = session expired; reconnect as a visitor rather than hammering.
        const delay = Math.min(30_000, 1000 * 2 ** attempt++) + Math.random() * 500;
        timer = setTimeout(() => void connect(), e.code === 4401 ? 2000 : delay);
      };
    };
    void connect();

    const onVisible = () => {
      if (document.visibilityState === "visible" && ws?.readyState === WebSocket.CLOSED) {
        clearTimeout(timer);
        attempt = 0;
        void connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      ws?.close();
    };
  }, []);

  return <Ctx.Provider value={hub}>{children}</Ctx.Provider>;
}

function useHub() {
  const hub = useContext(Ctx);
  if (!hub) throw new Error("RealtimeProvider missing");
  return hub;
}

export function useRealtimeStatus(): Status {
  const hub = useHub();
  return useSyncExternalStore(hub.onStatus, hub.status, () => "connecting");
}

export function useRealtime(handler: Listener) {
  const hub = useHub();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => hub.subscribe((e) => ref.current(e)), [hub]);
}

export function useLiveStats(initial: Stats): Stats {
  const [stats, setStats] = useState(initial);
  useRealtime((e) => {
    if (e.type === "stats") setStats(e.data);
  });
  return stats;
}

/**
 * Keeps a list of tracks in sync with live "track" events.
 * `keep` decides whether an updated track belongs in the list (e.g. still in-flight).
 */
export function useLiveTracks(
  initial: TrackView[],
  opts: { keep: (t: TrackView) => boolean; accept?: (t: TrackView) => boolean; limit?: number },
) {
  const [tracks, setTracks] = useState(initial);
  const [flash, setFlash] = useState<Record<string, number>>({});
  // Reset when the server sends a fresh list (router.refresh), without an effect round-trip.
  const [source, setSource] = useState(initial);
  if (source !== initial) {
    setSource(initial);
    setTracks(initial);
  }
  useRealtime((e) => {
    if (e.type !== "track") return;
    const t = e.data;
    setTracks((prev) => {
      const idx = prev.findIndex((p) => p.id === t.id);
      if (idx === -1) {
        if (!opts.keep(t) || (opts.accept && !opts.accept(t))) return prev;
        return [t, ...prev].slice(0, opts.limit ?? 200);
      }
      if (prev[idx]!.stage !== t.stage) setFlash((f) => ({ ...f, [t.id]: Date.now() }));
      if (!opts.keep(t)) return prev.filter((p) => p.id !== t.id);
      const next = prev.slice();
      next[idx] = t;
      return next;
    });
  });
  return { tracks, flash };
}
