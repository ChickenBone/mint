import { albumPlayerId, artistPlayerId, ApiError } from "@mint/client";
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
import { startNativeDeviceBridge, type NativeDeviceBridge } from "./device-bridge";
import { PlaybackDiagnostics, emptyDiagnostics, type DiagnosticsSnapshot } from "./diagnostics";
import { DiagnosticsPreference } from "./diagnostics-preference";
import { emptyPlayerState, type MobileTrack, type PlayerCollection, type PlayerState, type RepeatMode } from "./types";

export type { MobileTrack, PlayerCollection, QueueEntry } from "./types";
export interface PlayerController {
  state: PlayerState;
  expanded: boolean;
  open(): void;
  close(): void;
  localDeviceId(): string | null;
  handoffTo(id: string): Promise<void>;
  deviceError: string | null;
  capabilities: { nativeBackground: boolean; offline: boolean; dsp: false; gapless: false };
  offline: OfflineState;
  format: "original" | "mp3";
  setFormat(format: "original" | "mp3"): Promise<void>;
  diagnosticsEnabled: boolean;
  diagnosticsWarning: string | null;
  diagnostics: DiagnosticsSnapshot;
  setDiagnosticsEnabled(enabled: boolean): Promise<void>;
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
  const deviceRef = useRef<NativeDeviceBridge | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const offlineRef = useRef<OfflineStore | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot>(emptyDiagnostics);
  const [recorder] = useState(() => new PlaybackDiagnostics(undefined, setDiagnostics));
  const diagnosticsRef = useRef(recorder);
  const diagnosticsPreferenceRef = useRef<DiagnosticsPreference | null>(null);
  const [diagnosticsEnabled, setDiagnosticsEnabledState] = useState(false);
  const [diagnosticsWarning, setDiagnosticsWarning] = useState<string | null>(null);
  const [diagnosticsOwner, setDiagnosticsOwner] = useState<string | null>(null);
  const startupErrorRef = useRef<Error | null>(null);
  const [state, setState] = useState<PlayerState>(emptyPlayerState);
  const [offline, setOffline] = useState<OfflineState>(emptyOffline);
  const [expanded, setExpanded] = useState(false);
  const [format, setFormatState] = useState<"original" | "mp3">("original");
  const formatRef = useRef<"original" | "mp3">("original");
  const open = useCallback(() => setExpanded(true), []);
  const close = useCallback(() => setExpanded(false), []);
  const scopeServer = auth.serverUrl, scopeUser = auth.user?.id;

  useEffect(() => {
    const localDiagnostics = diagnosticsRef.current;
    localDiagnostics.setEnabled(false);
    if (!scopeServer || !scopeUser) return;
    startupErrorRef.current = null;
    let cancelled = false, removeStatus: (() => void) | undefined;
    let engine: PlaybackEngine | null = null, downloads: OfflineStore | null = null, bridge: NativeDeviceBridge | null = null;
    const requireApi = () => {
      if (!apiRef.current || apiRef.current.serverUrl !== scopeServer) throw new Error("Sign in to listen.");
      return apiRef.current;
    };
    void (async () => {
      try {
        const scope = await accountScope(scopeServer, scopeUser);
        if (cancelled) return;
        const preference = new DiagnosticsPreference(AsyncStorage, scope, (enabled, warning) => {
          if (cancelled) return;
          diagnosticsRef.current.setEnabled(enabled);
          setDiagnosticsOwner(JSON.stringify([scopeServer, scopeUser]));
          setDiagnosticsEnabledState(enabled);
          setDiagnosticsWarning(warning ?? null);
          setDiagnostics(emptyDiagnostics());
        });
        diagnosticsPreferenceRef.current = preference;
        await preference.restore();
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
          openQueue: (input, signal) => diagnosticsRef.current.request("queue request", () => requireApi().openQueue(input, signal)),
          queuePage: (id, position, signal) => diagnosticsRef.current.request("queue page", () => requireApi().queuePage(id, position, signal)),
          artworkUrl: (path) => requireApi().artworkUrl(path),
          source: async (track) => {
            const local = Platform.OS !== "web" && formatRef.current === "original" ? await localDownloads.source(track.id) : null;
            if (!cancelled) localDiagnostics.source(track.id, local ? "offline" : formatRef.current === "mp3" ? "MP3 stream" : "original stream");
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
              artistId: track.artist ? artistPlayerId(track.artist) : undefined,
              albumId: track.album ? albumPlayerId(track.artist, track.album) : undefined,
              duration: track.duration ?? track.existingDuration ?? undefined, thumb: requireApi().artworkUrl(`/api/artwork/${id}`) };
          },
        }, AsyncStorage, `mint.queue.v1.${scope}`, randomUUID);
        const localEngine = engine;
        engineRef.current = engine;
        engine.subscribe(() => {
          if (cancelled) return;
          setState(localEngine.state);
          if (localDiagnostics.trackChanged(localEngine.state)) setDiagnostics(emptyDiagnostics());
        });
        removeStatus = native.subscribe((status) => {
          if (cancelled) return;
          localEngine.onStatus(status);
          if (diagnosticsRef.current.status(status, localEngine.state, native.port.trackCount)) {
            setDiagnostics(diagnosticsRef.current.read());
          }
        });
        registerPlaybackCleanup(scope, async () => {
          if (!cancelled) {
            localDiagnostics.setEnabled(false);
            setDiagnosticsEnabledState(false);
            setDiagnosticsOwner(null);
            setDiagnostics(emptyDiagnostics());
          }
          await preference.dispose();
          bridge?.dispose();
          await Promise.all([localEngine.revoke(), localDownloads.revoke()]);
        });
        await engine.restore();
        if (!cancelled) {
          setState(engine.state);
          bridge = startNativeDeviceBridge({
            api: requireApi(), state: () => localEngine.getDeviceState(),
            kind: Platform.OS === "web" ? "web" : "native",
            execute: (command, signal) => localEngine.executeDevice(command, signal),
            apply: (handoff, signal) => localEngine.applyDeviceHandoff(handoff, signal),
            error: (message) => { if (!cancelled) setDeviceError(message); },
          });
          deviceRef.current = bridge;
          if (AppState.currentState !== "active") bridge.sleep();
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Audio could not start. Reopen the app.";
          engine?.fail(error);
          if (!engine) {
            startupErrorRef.current = new Error(message);
            setState({ ...emptyPlayerState, error: message });
          }
          if (downloads) downloads.error(error, true);
          else setOffline({ ...emptyOffline, status: "unavailable", error: message });
        }
      }
    })();
    return () => {
      cancelled = true;
      void diagnosticsPreferenceRef.current?.dispose();
      diagnosticsPreferenceRef.current = null;
      localDiagnostics.setEnabled(false);
      setDiagnosticsEnabledState(false);
      setDiagnosticsOwner(null);
      setDiagnostics(emptyDiagnostics());
      setState(emptyPlayerState);
      removeStatus?.();
      bridge?.dispose();
      deviceRef.current = null;
      setDeviceError(null);
      engine?.dispose();
      engineRef.current = null;
      // Account cleanup is awaited by AuthProvider. A route change never gets here.
    };
  }, [scopeServer, scopeUser]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const engine = engineRef.current, downloads = offlineRef.current;
      if (!engine) return;
      if (next !== "active") { engine.persist(); deviceRef.current?.sleep(); return; }
      deviceRef.current?.wake();
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

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const hide = () => deviceRef.current?.sleep();
    const show = () => deviceRef.current?.wake();
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => { window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show); };
  }, []);

  const act = useCallback(async (action: (engine: PlaybackEngine) => void | Promise<void>) => {
    const engine = engineRef.current;
    if (!engine) throw startupErrorRef.current ?? new Error("Audio is still starting. Try again in a moment.");
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
    if (!store) throw startupErrorRef.current ?? new Error("Download storage is still starting.");
    try { await action(store); }
    catch (error) { store.error(error); throw error; }
  }, []);
  const value = useMemo<PlayerController>(() => ({
    state, offline, expanded, open, close, format,
    deviceError,
    localDeviceId: () => deviceRef.current?.deviceId ?? null,
    handoffTo: async (id) => {
      if (!deviceRef.current) throw new Error("The player is still connecting. Try again shortly.");
      const connection = apiRef.current;
      if (!connection) throw new Error("Sign in to choose a player.");
      const rows = await connection.devices();
      const source = rows.find((row) => row.online && row.state.playing && row.state.queueLength > 0);
      if (!source || source.id === deviceRef.current.deviceId) {
        await deviceRef.current.handoffTo(id);
        return;
      }
      const wait = async (commandId: string) => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if (apiRef.current !== connection) throw new Error("Account changed during the playback move.");
          const command = await connection.deviceCommandStatus(commandId);
          if (command.status === "succeeded") return;
          if (command.status === "failed" || command.status === "expired") throw new Error(command.error || "Playback move was not confirmed.");
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error("Device did not confirm the playback move.");
      };
      const transferred = await connection.transferDevice(id);
      await wait(transferred.id);
      const pause = await connection.completeDeviceTransfer(transferred.id);
      await wait(pause.id);
    },
    diagnosticsEnabled: diagnosticsEnabled && diagnosticsOwner === JSON.stringify([scopeServer, scopeUser]),
    diagnosticsWarning: diagnosticsOwner === JSON.stringify([scopeServer, scopeUser]) ? diagnosticsWarning : null,
    diagnostics: diagnosticsOwner === JSON.stringify([scopeServer, scopeUser]) ? diagnostics : emptyDiagnostics(),
    setDiagnosticsEnabled: async (enabled) => {
      const preference = diagnosticsPreferenceRef.current;
      if (!preference) throw new Error("Sign in and wait for playback to start before changing diagnostics.");
      await preference.set(enabled);
    },
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
  }), [act, downloadAct, state, offline, expanded, open, close, format, deviceError, diagnosticsEnabled, diagnosticsWarning, diagnostics, diagnosticsOwner, scopeServer, scopeUser]);
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}
export function usePlayer(): PlayerController {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("usePlayer must be used inside PlayerProvider.");
  return value;
}
