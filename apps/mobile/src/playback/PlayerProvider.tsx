import { ApiError } from "@mint/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Platform } from "react-native";
import { useAuth } from "../auth";
import { useApi } from "../api";
import { createOfflineFiles } from "../offline/files";
import { OfflineStore, OFFLINE_BUDGET, type OfflineState } from "../offline/store";
import { accountScope, registerPlaybackCleanup } from "./account-cleanup";
import { PlaybackEngine } from "./engine";
import { createPlaylist } from "./playlist";
import { emptyPlayerState, type MobileTrack, type PlayerCollection, type PlayerState, type RepeatMode } from "./types";

export type { MobileTrack, PlayerCollection, QueueEntry } from "./types";
export interface PlayerController {
  state: PlayerState;
  expanded: boolean;
  open(): void;
  close(): void;
  capabilities: { nativeBackground: boolean; offline: boolean; dsp: false; gapless: false };
  offline: OfflineState;
  format: "original" | "mp3";
  setFormat(format: "original" | "mp3"): Promise<void>;
  playTrack(track: MobileTrack): Promise<void>;
  playCollection(collection: PlayerCollection, options?: { shuffle?: boolean; id?: string; occurrenceId?: string }): Promise<void>;
  toggle(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setShuffle(enabled: boolean): Promise<void>;
  setRepeat(mode: RepeatMode): Promise<void>;
  addToQueue(track: MobileTrack): Promise<void>;
  removeFromQueue(id: string): Promise<void>;
  moveInQueue(id: string, before: string): Promise<void>;
  clearUpcoming(): Promise<void>;
  download(track: MobileTrack): Promise<void>;
  removeDownload(id: string): Promise<void>;
  retryDownload(id: string): Promise<void>;
  clearDownloads(): Promise<void>;
}
const PlayerContext = createContext<PlayerController | null>(null);
const emptyOffline: OfflineState = { entries: [], status: "loading", bytes: 0, budgetBytes: OFFLINE_BUDGET, error: null };

export function PlayerProvider({ children }: { children: ReactNode }) {
  const auth = useAuth(), api = useApi();
  const apiRef = useRef(api);
  useEffect(() => { apiRef.current = api; }, [api]);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const offlineRef = useRef<OfflineStore | null>(null);
  const [state, setState] = useState<PlayerState>(emptyPlayerState);
  const [offline, setOffline] = useState<OfflineState>(emptyOffline);
  const [expanded, setExpanded] = useState(false);
  const [format, setFormatState] = useState<"original" | "mp3">("original");
  const formatRef = useRef<"original" | "mp3">("original");
  const open = useCallback(() => setExpanded(true), []);
  const close = useCallback(() => setExpanded(false), []);
  const scopeServer = auth.serverUrl, scopeUser = auth.user?.id;

  useEffect(() => {
    if (!scopeServer || !scopeUser) return;
    let cancelled = false, removeStatus: (() => void) | undefined;
    let engine: PlaybackEngine | null = null, downloads: OfflineStore | null = null;
    const requireApi = () => {
      if (!apiRef.current || apiRef.current.serverUrl !== scopeServer) throw new Error("Sign in to listen.");
      return apiRef.current;
    };
    void (async () => {
      try {
        const scope = await accountScope(scopeServer, scopeUser);
        if (cancelled) return;
        const native = await createPlaylist();
        if (cancelled) { native.port.destroy(); return; }
        downloads = new OfflineStore(createOfflineFiles(scope), {
          entitlement: (signal) => requireApi().offlineEntitlement(signal),
          source: (id) => requireApi().mediaSource(id),
        }, AsyncStorage, `mint.offline.v1.${scope}`, scopeUser);
        offlineRef.current = downloads;
        const localDownloads = downloads;
        downloads.subscribe(() => { if (!cancelled) setOffline(localDownloads.state); });
        if (Platform.OS !== "web") await downloads.restoreWithRenewal((error) => error instanceof ApiError && error.status === 0)
          .catch((error: unknown) => localDownloads.error(error, true));
        else setOffline({ ...emptyOffline, status: "unavailable" });
        if (cancelled) { native.port.destroy(); return; }
        engine = new PlaybackEngine(native.port, {
          openQueue: (input, signal) => requireApi().openQueue(input, signal),
          queuePage: (id, position, signal) => requireApi().queuePage(id, position, signal),
          artworkUrl: (path) => requireApi().artworkUrl(path),
          source: async (track) => {
            const local = Platform.OS !== "web" && formatRef.current === "original" ? await localDownloads.source(track.id) : null;
            return local ?? { ...requireApi().mediaSource(track.id, formatRef.current), name: track.title };
          },
          validate: async (signal) => {
            try { await requireApi().preferences(signal); }
            catch (error) {
              if (error instanceof ApiError && error.status === 0 && localDownloads.state.entries.some((entry) => entry.status === "ready")) {
                const selected = engine?.state.track;
                if (selected && await localDownloads.source(selected.id)) return;
              }
              throw error;
            }
          },
          metadata: async (id, signal) => {
            const { track } = await requireApi().trackInfo(id, signal);
            return { id: track.id, title: track.title, artist: track.artist, album: track.album ?? undefined,
              duration: track.duration ?? track.existingDuration ?? undefined, thumb: requireApi().artworkUrl(`/api/artwork/${id}`) };
          },
        }, AsyncStorage, `mint.queue.v1.${scope}`, randomUUID);
        const localEngine = engine;
        engineRef.current = engine;
        engine.subscribe(() => { if (!cancelled) setState(localEngine.state); });
        removeStatus = native.subscribe((status) => localEngine.onStatus(status));
        registerPlaybackCleanup(scope, async () => {
          await Promise.all([localEngine.revoke(), localDownloads.revoke()]);
        });
        await engine.restore();
        if (!cancelled) setState(engine.state);
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Audio could not start. Reopen the app.";
          engine?.fail(error);
          if (!engine) setState({ ...emptyPlayerState, error: message });
          downloads?.error(error, true);
        }
      }
    })();
    return () => {
      cancelled = true;
      removeStatus?.();
      engine?.dispose();
      engineRef.current = null;
      // Account cleanup is awaited by AuthProvider. A route change never gets here.
    };
  }, [scopeServer, scopeUser]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const engine = engineRef.current, downloads = offlineRef.current;
      if (!engine) return;
      if (next !== "active") { engine.persist(); return; }
      void apiRef.current?.preferences().catch((error: unknown) => {
        if (!(error instanceof ApiError && error.status === 0)) engine.fail(error);
      });
      if (Platform.OS !== "web" && downloads) {
        void downloads.renew().catch(async (error: unknown) => {
          if (!(error instanceof ApiError && error.status === 0)) { downloads.error(error); engine.fail(error); }
          else if (engine.state.track && downloads.state.entries.some((entry) => entry.id === engine.state.track?.id && entry.status === "ready")) {
            await downloads.source(engine.state.track.id).catch((failure: unknown) => engine.fail(failure));
          }
        });
      }
    });
    return () => subscription.remove();
  }, []);

  const act = useCallback(async (action: (engine: PlaybackEngine) => void | Promise<void>) => {
    const engine = engineRef.current;
    if (!engine) throw new Error("Audio is still starting. Try again in a moment.");
    try { await action(engine); }
    catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      engine.reportError(error);
      throw error;
    }
  }, []);
  const downloadAct = useCallback(async (action: (store: OfflineStore) => Promise<void>) => {
    if (Platform.OS === "web") throw new Error("Downloads are available in the Android and iOS app.");
    const store = offlineRef.current;
    if (!store) throw new Error("Download storage is still starting.");
    try { await action(store); }
    catch (error) { store.error(error); throw error; }
  }, []);
  const value = useMemo<PlayerController>(() => ({
    state, offline, expanded, open, close, format,
    setFormat: async (next) => {
      if (engineRef.current?.state.queueLoading) throw new Error("Wait for the full queue to prepare before changing audio format.");
      const previous = formatRef.current;
      formatRef.current = next;
      try {
        await act((engine) => engine.reloadSources());
        setFormatState(next);
      } catch (error) { formatRef.current = previous; throw error; }
    },
    capabilities: { nativeBackground: Platform.OS !== "web", offline: Platform.OS !== "web", dsp: false, gapless: false },
    playTrack: (track) => act((engine) => engine.playTrack(track)),
    playCollection: (collection, options) => act((engine) => engine.playCollection(collection, options)),
    toggle: () => act((engine) => engine.toggle()), next: () => act((engine) => engine.next()),
    previous: () => act((engine) => engine.previous()), seek: (seconds) => act((engine) => engine.seek(seconds)),
    setShuffle: (enabled) => act((engine) => engine.setShuffle(enabled)), setRepeat: (mode) => act((engine) => engine.setRepeat(mode)),
    addToQueue: (track) => act((engine) => engine.addToQueue(track)), removeFromQueue: (id) => act((engine) => engine.removeFromQueue(id)),
    moveInQueue: (id, before) => act((engine) => engine.moveInQueue(id, before)), clearUpcoming: () => act((engine) => engine.clearUpcoming()),
    download: (track) => downloadAct((store) => store.download(track)), removeDownload: (id) => downloadAct((store) => store.remove(id)),
    retryDownload: (id) => downloadAct((store) => store.retry(id)), clearDownloads: () => downloadAct((store) => store.clear()),
  }), [act, downloadAct, state, offline, expanded, open, close, format]);
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}
export function usePlayer(): PlayerController {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("usePlayer must be used inside PlayerProvider.");
  return value;
}
