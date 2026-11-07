import { createAudioPlayer } from "expo-audio";
import type { MediaSource, PlaylistPort, PlaylistStatus } from "./engine";

export async function createPlaylist(): Promise<{
  port: PlaylistPort;
  subscribe: (listener: (status: PlaylistStatus) => void) => () => void;
}> {
  const audio = createAudioPlayer(null, { updateInterval: 250 });
  let sources: MediaSource[] = [], index = 0, intended = false;
  let loop: "none" | "single" | "all" = "none";
  let controller: AbortController | null = null, objectUrl: string | null = null;
  let loading = false, disposed = false;
  let pendingSeek: number | null = null;
  const listeners = new Set<(status: PlaylistStatus) => void>();
  const notify = (error?: unknown) => {
    for (const listener of listeners) listener({ currentIndex: index, currentTime: audio.currentTime, duration: audio.duration,
      playing: audio.playing, isLoaded: audio.isLoaded, isBuffering: loading || audio.isBuffering, error });
  };
  const load = async () => {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    const source = sources[index];
    if (!source) return;
    loading = true;
    notify();
    audio.pause();
    try {
      // Browser audio elements cannot attach bearer headers. Fetch one bounded,
      // authenticated track into a blob; no native suspension guarantees on web.
      const response = await fetch(source.uri, { headers: source.headers, signal: request.signal, credentials: "omit", redirect: "error" });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Listening permission expired. Sign in again." : "This song could not load.");
      if (!/^audio\//i.test(response.headers.get("content-type") ?? "")) throw new Error("The server did not return audio.");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Browser audio streaming is unavailable.");
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 128 * 1024 * 1024) throw new Error("This song exceeds the web playback buffer. Use the native app.");
          chunks.push(new Uint8Array(value));
        }
      } finally { await reader.cancel(); }
      if (request.signal.aborted || disposed) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(new Blob(chunks, { type: response.headers.get("content-type")! }));
      audio.replace({ uri: objectUrl });
      if (pendingSeek !== null) {
        const target = pendingSeek;
        pendingSeek = null;
        await audio.seekTo(target);
      }
      if (intended) audio.play();
    } catch (error) {
      if (!request.signal.aborted && !disposed) { intended = false; notify(error); }
    } finally {
      if (controller === request) { loading = false; notify(); }
    }
  };
  const subscription = audio.addListener("playbackStatusUpdate", (status) => {
    if (status.error) { intended = false; notify(new Error(status.error)); return; }
    if (status.didJustFinish && intended && loop !== "single") {
      if (index + 1 < sources.length || loop === "all") { index = (index + 1) % sources.length; void load(); }
      else intended = false;
    }
    notify();
  });
  const port: PlaylistPort = {
    get currentIndex() { return index; },
    get currentTime() { return audio.currentTime; },
    get trackCount() { return sources.length; },
    get playing() { return audio.playing; },
    get loop() { return loop; },
    set loop(value) { loop = value; audio.loop = value === "single"; },
    add(source) { sources.push(source); },
    remove(position) {
      sources.splice(position, 1);
      if (position < index) index--;
      else if (position === index) { index = Math.min(index, sources.length - 1); void load(); }
    },
    clear() {
      controller?.abort(); intended = false; pendingSeek = null; audio.pause(); audio.replace(null); sources = []; index = 0;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    },
    play() { intended = true; if (audio.isLoaded && !loading) audio.play(); else void load(); },
    pause() { intended = false; audio.pause(); },
    next() {
      if (index + 1 < sources.length) { index++; void load(); }
      else if (loop === "all") { index = 0; void load(); }
    },
    previous() {
      if (index > 0) { index--; void load(); }
      else if (loop === "all") { index = sources.length - 1; void load(); }
    },
    skipTo(position) { index = position; void load(); },
    seekTo(seconds) {
      if (loading) { pendingSeek = seconds; return Promise.resolve(); }
      return audio.seekTo(seconds);
    },
    setActiveForLockScreen(active, metadata) { audio.setActiveForLockScreen(active, metadata); },
    destroy() {
      disposed = true; controller?.abort(); subscription.remove(); audio.pause(); audio.setActiveForLockScreen(false); audio.release();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      listeners.clear();
    },
  };
  return { port, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
