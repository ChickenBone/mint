"use client";

import type { TrackView } from "@mint/core/events";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { artUrl, previewUrl } from "@/lib/media";

export const PREVIEW_SECONDS = 30;

interface PlayerState {
  current: TrackView | null;
  queue: TrackView[];
  playing: boolean;
  loading: boolean;
  error: string | null;
  time: number;
  volume: number;
}

interface PlayerApi extends PlayerState {
  /** Play `track`; `context` becomes the queue so next/previous walk the list it came from. */
  play(track: TrackView, context?: TrackView[]): void;
  toggle(track?: TrackView, context?: TrackView[]): void;
  next(): void;
  previous(): void;
  seek(sec: number): void;
  setVolume(v: number): void;
}

const Ctx = createContext<PlayerApi | null>(null);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [s, setS] = useState<PlayerState>({
    current: null,
    queue: [],
    playing: false,
    loading: false,
    error: null,
    time: 0,
    volume: 0.8,
  });
  const stateRef = useRef(s);
  useEffect(() => {
    stateRef.current = s;
  });

  const load = useCallback((track: TrackView, queue: TrackView[]) => {
    const el = audio.current;
    if (!el) return;
    setS((p) => ({ ...p, current: track, queue, loading: true, error: null, time: 0 }));
    el.src = previewUrl(track.id);
    el.play().catch((err: unknown) => {
      if ((err as DOMException)?.name === "AbortError") return;
      setS((p) => ({ ...p, loading: false, playing: false, error: "Preview couldn't play. Try again in a moment." }));
    });
  }, []);

  const step = useCallback(
    (dir: 1 | -1) => {
      const { current, queue } = stateRef.current;
      if (!current) return;
      const playable = queue.filter((t) => t.hasPreview);
      const i = playable.findIndex((t) => t.id === current.id);
      const nextTrack = playable[i + dir];
      if (nextTrack) load(nextTrack, queue);
      else if (dir === -1 && audio.current) audio.current.currentTime = 0;
    },
    [load],
  );

  useEffect(() => {
    const el = new Audio();
    el.preload = "none";
    el.volume = 0.8;
    audio.current = el;
    const on = (ev: string, fn: () => void) => el.addEventListener(ev, fn);
    on("playing", () => setS((p) => ({ ...p, playing: true, loading: false })));
    on("pause", () => setS((p) => ({ ...p, playing: false })));
    on("waiting", () => setS((p) => ({ ...p, loading: true })));
    on("timeupdate", () => {
      // Previews are cut at 30s on disk; this guards older or longer files.
      if (el.currentTime >= PREVIEW_SECONDS) el.dispatchEvent(new Event("ended"));
      setS((p) => ({ ...p, time: el.currentTime }));
    });
    on("ended", () => {
      el.pause();
      setS((p) => ({ ...p, playing: false, time: 0 }));
      step(1);
    });
    on("error", () => {
      if (!el.src) return;
      setS((p) => ({ ...p, playing: false, loading: false, error: "This preview isn't available yet." }));
    });
    return () => {
      el.pause();
      el.src = "";
    };
  }, [step]);

  // OS media controls (lock screen, keyboard media keys).
  const current = s.current;
  useEffect(() => {
    if (!("mediaSession" in navigator) || !current) return;
    const t = current;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album ?? "",
      artwork: t.hasArtwork ? [{ src: artUrl(t.id), sizes: "600x600", type: "image/jpeg" }] : [],
    });
    navigator.mediaSession.setActionHandler("play", () => void audio.current?.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.current?.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
    navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
  }, [current, step]);

  const api = useMemo<PlayerApi>(
    () => ({
      ...s,
      play: (track, context) => load(track, context ?? [track]),
      toggle: (track, context) => {
        const el = audio.current;
        if (!el) return;
        if (track && track.id !== stateRef.current.current?.id) return load(track, context ?? [track]);
        if (el.paused) void el.play().catch(() => undefined);
        else el.pause();
      },
      next: () => step(1),
      previous: () => step(-1),
      seek: (sec) => {
        if (audio.current) audio.current.currentTime = Math.max(0, Math.min(PREVIEW_SECONDS, sec));
      },
      setVolume: (v) => {
        if (audio.current) audio.current.volume = v;
        setS((p) => ({ ...p, volume: v }));
      },
    }),
    [s, load, step],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function usePlayer() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("PlayerProvider missing");
  return ctx;
}
