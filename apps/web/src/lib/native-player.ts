import { z } from "zod";
import { BrowserDSP } from "./browser-dsp";
import { itemCollection, loadCollection, shuffled } from "./browser-catalog";
import { defaultDsp, dspSchema, playerItemSchema, type PlayerCommand, type PlayerItem, type PlayerState } from "./player-protocol";

const snapshotSchema = z.object({
  version: z.literal(1), queue: z.array(playerItemSchema.extend({ type: z.literal("track"), id: z.uuid(), queueId: z.string().regex(/^\d+$/) })).max(50_000),
  index: z.number().int().nonnegative(), time: z.number().finite().nonnegative(),
  shuffle: z.boolean(), repeat: z.number().int().min(0).max(2), volume: z.number().min(0).max(100), dsp: dspSchema,
  order: z.array(z.string()).max(50_000),
});

export class NativePlayer {
  private queue: PlayerItem[] = [];
  private order: string[] = [];
  private index = 0;
  private sequence = 0;
  private shuffle = false;
  private repeat = 0;
  private element: HTMLAudioElement;
  private dsp: BrowserDSP;
  private request?: AbortController;
  private transitionGeneration = 0;
  private transitioning = false;
  private transitionPending = false;
  private prepared?: string;
  private failedPreload?: string;
  private fadeTimer?: ReturnType<typeof setTimeout>;
  private listeners: Array<() => void> = [];
  private disposed = false;
  private restoredTime = 0;
  private lastSaved = 0;
  private mediaTrack?: string;
  private storageKey: string;
  private storage?: Storage;

  constructor(private options: {
    memberId: string; elements: [HTMLAudioElement, HTMLAudioElement];
    update: (state: PlayerState) => void; error: (message: string) => void;
    fetcher?: typeof fetch; storage?: Storage;
  }) {
    this.storageKey = `mint:player:v3:${options.memberId}`;
    this.element = options.elements[0];
    this.dsp = new BrowserDSP(options.elements);
    try { this.storage = options.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined); }
    catch (error) { this.report(new Error(`Browser storage is unavailable. Playback will not be saved: ${error instanceof Error ? error.message : "check privacy settings."}`)); }
    for (const element of options.elements) {
      element.preload = "metadata";
      for (const name of ["playing", "pause", "timeupdate", "durationchange", "volumechange", "waiting", "seeked"]) {
        this.listen(element, name, () => {
          if (element !== this.element || this.disposed) return;
          this.emit();
          if (name === "timeupdate") {
            if (Date.now() - this.lastSaved > 5000) this.persist();
            void this.transition().catch((error: unknown) => this.report(error));
          }
        });
      }
      this.listen(element, "ended", () => { if (element === this.element && !this.disposed) void this.next(true).catch((error: unknown) => this.report(error)); });
      this.listen(element, "error", () => {
        if (this.disposed) return;
        if (element !== this.element) { this.failedPreload = this.prepared; this.prepared = undefined; this.options.error("The next track could not preload. Playback will try it normally when this song ends."); return; }
        this.cancelTransition(); element.pause();
        this.options.error("This track could not play. Check its file mapping, permissions and browser codec support.");
        this.emit();
      });
    }
    this.restore();
    this.installMediaSession();
    this.emit();
  }

  private listen(target: EventTarget, name: string, handler: EventListener) {
    target.addEventListener(name, handler);
    this.listeners.push(() => target.removeEventListener(name, handler));
  }

  private report(error: unknown) { if (!this.disposed) this.options.error(error instanceof Error ? error.message : "Playback failed. Try again."); }

  getState(): PlayerState {
    const track = this.queue[this.index] ?? null;
    const loaded = Boolean(this.element.getAttribute("src"));
    const offset = Math.max(0, this.index - 100);
    return {
      playing: loaded && !this.element.paused, time: loaded ? Math.round(this.element.currentTime * 1000) || 0 : this.restoredTime,
      duration: loaded && Number.isFinite(this.element.duration) ? Math.round(this.element.duration * 1000) : track?.duration ?? 0,
      volume: this.element.volume * 100, shuffle: this.shuffle, repeat: this.repeat, track,
      queue: this.queue.slice(offset, offset + 1000), queueTotal: this.queue.length, queueOffset: offset,
      dsp: this.dsp.settings, dspAvailable: typeof window !== "undefined" && Boolean(window.AudioContext), transitioning: this.transitioning,
    };
  }

  private emit() {
    if (this.disposed) return;
    const state = this.getState();
    this.options.update(state);
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    if (state.track && this.mediaTrack !== state.track.queueId && typeof MediaMetadata !== "undefined") {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.track.title, artist: state.track.artist, album: state.track.album,
        artwork: state.track.thumb ? [{ src: state.track.thumb }] : [],
      });
      this.mediaTrack = state.track.queueId;
    }
    navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
    if (navigator.mediaSession.setPositionState && state.duration > 0 && state.time <= state.duration) {
      navigator.mediaSession.setPositionState({ duration: state.duration / 1000, position: state.time / 1000, playbackRate: 1 });
    }
  }

  private restore() {
    const storage = this.storage;
    if (!storage) return;
    try {
      const saved = storage.getItem(this.storageKey);
      if (!saved) return;
      const snapshot = snapshotSchema.parse(JSON.parse(saved));
      const ids = new Set(snapshot.queue.map((track) => track.queueId));
      if ((snapshot.queue.length && snapshot.index >= snapshot.queue.length) || ids.size !== snapshot.queue.length ||
          snapshot.order.length !== ids.size || new Set(snapshot.order).size !== ids.size || snapshot.order.some((id) => !ids.has(id))) {
        throw new Error("The saved queue is inconsistent.");
      }
      this.queue = snapshot.queue; this.index = snapshot.index; this.order = snapshot.order;
      this.sequence = Math.max(0, ...snapshot.queue.map((track) => Number(track.queueId)));
      this.shuffle = snapshot.shuffle; this.repeat = snapshot.repeat; this.restoredTime = snapshot.time;
      for (const element of this.options.elements) element.volume = snapshot.volume / 100;
      this.dsp.settings = snapshot.dsp;
      if ((typeof window === "undefined" || !window.AudioContext) && (snapshot.dsp.enabled || snapshot.dsp.compressor || snapshot.dsp.crossfade > 0)) {
        this.dsp.settings = { ...defaultDsp, bands: [...defaultDsp.bands] };
        this.options.error("Saved sound processing is not supported in this browser. Sound processing is off; standard playback remains available.");
      }
    } catch (error) {
      this.options.error(`Your saved player could not restore. ${error instanceof Error ? error.message : "Check browser storage."}`);
    }
  }

  persist() {
    if (!this.storage || this.disposed) return;
    const state = this.getState();
    try {
      this.storage.setItem(this.storageKey, JSON.stringify({
        version: 1, queue: this.queue, order: this.order, index: this.index, time: state.time,
        shuffle: this.shuffle, repeat: this.repeat, volume: state.volume, dsp: this.dsp.settings,
      }));
      this.lastSaved = Date.now();
    } catch (error) {
      this.lastSaved = Date.now();
      this.options.error(`Playback continues, but the queue could not be saved. ${error instanceof Error ? error.message : "Check browser storage space."}`);
    }
  }

  private installMediaSession() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const actions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => { void this.execute({ action: "toggle" }, true).catch((error: unknown) => this.report(error)); },
      pause: () => this.pause(),
      nexttrack: () => { void this.execute({ action: "next" }).catch((error: unknown) => this.report(error)); },
      previoustrack: () => { void this.execute({ action: "previous" }).catch((error: unknown) => this.report(error)); },
      seekto: (details) => { if (details.seekTime !== undefined) this.seek(details.seekTime * 1000); },
    };
    for (const [action, handler] of Object.entries(actions) as Array<[MediaSessionAction, MediaSessionActionHandler]>) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
        this.listeners.push(() => navigator.mediaSession.setActionHandler(action, null));
      } catch (error) { console.warn(`Media action ${action} is unavailable`, error); }
    }
  }

  private cancelTransition() {
    this.transitionGeneration++; clearTimeout(this.fadeTimer);
    this.transitioning = false; this.transitionPending = false; this.prepared = undefined; this.failedPreload = undefined;
    for (const element of this.options.elements) if (element !== this.element) {
      element.pause(); element.removeAttribute("src"); element.load();
    }
    this.dsp.select(this.element);
  }

  pause() {
    this.request?.abort(); this.cancelTransition(); this.element.pause(); this.emit(); this.persist();
  }

  revoke(message: string) {
    this.pause();
    this.element.removeAttribute("src"); this.element.load(); this.restoredTime = 0;
    this.options.error(message); this.emit();
  }

  private seek(ms: number) {
    if (!Number.isFinite(ms)) throw new Error("Invalid seek position");
    this.cancelTransition();
    if (this.element.getAttribute("src")) this.element.currentTime = Math.max(0, Math.min(ms, this.getState().duration) / 1000);
    else this.restoredTime = Math.max(0, Math.min(ms, this.getState().duration));
    this.emit();
  }

  private async resume() {
    if (!this.queue[this.index]) throw new Error("Choose a song to start listening.");
    if (!this.element.getAttribute("src")) return this.select(this.index, this.restoredTime);
    const generation = this.transitionGeneration;
    await this.dsp.initialize();
    if (generation !== this.transitionGeneration || this.disposed) return;
    await this.element.play();
    this.emit();
  }

  private async select(index: number, time = 0, paused = false) {
    const track = this.queue[index];
    if (!track) throw new Error("This queue item is no longer available.");
    this.cancelTransition(); this.index = index; this.restoredTime = 0;
    this.element.src = `/api/player/audio/${track.id}`;
    if (time > 0) this.element.currentTime = Math.min(time, track.duration || time) / 1000;
    this.emit();
    if (!paused) await this.resume();
    this.emit();
  }

  private async next(ended = false) {
    if (ended && this.repeat === 1) return this.select(this.index);
    const next = this.index + 1;
    if (next < this.queue.length) return this.select(next);
    if (this.repeat === 2 && this.queue.length) return this.select(0);
    this.pause();
  }

  private async transition() {
    const seconds = this.dsp.settings.crossfade, remaining = this.element.duration - this.element.currentTime;
    if (!seconds || this.transitioning || this.transitionPending || this.element.paused || this.repeat === 1 ||
        !Number.isFinite(remaining) || remaining <= 0 || remaining > seconds + 5) return;
    const index = this.index + 1 < this.queue.length ? this.index + 1 : this.repeat === 2 ? 0 : -1;
    if (index < 0 || index === this.index) return;
    const track = this.queue[index]!, standby = this.options.elements.find((element) => element !== this.element)!;
    if (this.failedPreload === track.queueId) return;
    if (this.prepared !== track.queueId) {
      standby.src = `/api/player/audio/${track.id}`; standby.preload = "auto"; standby.load(); this.prepared = track.queueId;
    }
    if (remaining > seconds || standby.readyState < 3) return;
    const generation = this.transitionGeneration, from = this.element;
    this.transitionPending = true;
    try {
      await this.dsp.initialize();
      if (generation !== this.transitionGeneration || this.disposed) return;
      await standby.play();
      if (generation !== this.transitionGeneration || this.disposed) return;
      const duration = Math.min(seconds, remaining, (standby.duration || seconds * 2) / 2);
      this.dsp.fade(from, standby, duration);
      this.element = standby; this.index = index; this.prepared = undefined; this.transitioning = true;
      this.emit();
      this.fadeTimer = setTimeout(() => {
        from.pause(); from.removeAttribute("src"); from.load();
        this.transitioning = false; this.dsp.select(this.element); this.emit();
      }, duration * 1000);
    } catch (error) {
      if (generation === this.transitionGeneration) {
        standby.pause(); this.transitioning = false; this.dsp.select(this.element);
        this.failedPreload = track.queueId;
        throw new Error(`Smooth transition failed: ${error instanceof Error ? error.message : "Try standard playback."}`);
      }
    } finally { if (generation === this.transitionGeneration) this.transitionPending = false; }
  }

  async execute(command: PlayerCommand, forcePlay = false): Promise<void> {
    if (this.disposed) throw new Error("The player has closed.");
    if (!["state", "volume", "dsp"].includes(command.action)) this.request?.abort();
    switch (command.action) {
      case "collection":
      case "play":
      case "next-in-queue":
      case "add-to-queue": {
        const request = this.request = new AbortController();
        const collection = command.action === "collection" ? command.collection : itemCollection(command.item);
        const all = await loadCollection(collection, request.signal, this.options.fetcher);
        request.signal.throwIfAborted();
        const selected = command.action === "collection" ? command.id : command.item.type === "track" ? command.item.id : undefined;
        const rows = command.action === "next-in-queue" || command.action === "add-to-queue"
          ? command.item.type === "track" ? all.filter((track) => track.id === command.item.id) : all : all;
        if (!rows.length) throw new Error("No downloaded tracks are available for this selection.");
        const entries = rows.map((track) => ({ ...track, queueId: String(++this.sequence) }));
        this.cancelTransition();
        if (command.action === "next-in-queue" || command.action === "add-to-queue") {
          const current = this.queue[this.index], at = command.action === "next-in-queue" ? this.index + 1 : this.queue.length;
          this.queue.splice(at, 0, ...entries);
          const originalAt = command.action === "next-in-queue" && current ? this.order.indexOf(current.queueId!) + 1 : this.order.length;
          this.order.splice(originalAt, 0, ...entries.map((track) => track.queueId));
          if (!current) await this.select(0, 0, true);
        } else {
          if (selected && !entries.some((track) => track.id === selected)) throw new Error("This song is no longer in the selected collection.");
          this.order = entries.map((track) => track.queueId); this.shuffle = Boolean(command.shuffle);
          this.queue = this.shuffle ? shuffled(entries) : entries;
          const index = this.shuffle || !selected ? 0 : this.queue.findIndex((track) => track.id === selected);
          await this.select(index);
        }
        request.signal.throwIfAborted();
        break;
      }
      case "toggle": if (forcePlay || this.element.paused) await this.resume(); else this.pause(); break;
      case "next": await this.next(); break;
      case "previous": if (this.element.currentTime > 3) this.seek(0); else await this.select(Math.max(0, this.index - 1)); break;
      case "seek": this.seek(command.value); break;
      case "volume":
        if (!Number.isFinite(command.value)) throw new Error("Invalid volume");
        for (const element of this.options.elements) element.volume = Math.max(0, Math.min(1, command.value / 100));
        break;
      case "repeat": this.cancelTransition(); this.repeat = (this.repeat + 1) % 3; break;
      case "shuffle": {
        const current = this.queue[this.index];
        this.cancelTransition(); this.shuffle = !this.shuffle;
        const positions = new Map(this.order.map((id, i) => [id, i]));
        this.queue = this.shuffle ? [...this.queue.slice(0, this.index + 1), ...shuffled(this.queue.slice(this.index + 1))]
          : this.queue.slice().sort((a, b) => positions.get(a.queueId!)! - positions.get(b.queueId!)!);
        this.index = Math.max(0, this.queue.indexOf(current!));
        break;
      }
      case "clear": {
        this.cancelTransition(); this.queue = this.queue.slice(0, this.index + 1);
        const remaining = new Set(this.queue.map((track) => track.queueId));
        this.order = this.order.filter((id) => remaining.has(id)); break;
      }
      case "skip": {
        const index = this.queue.findIndex((track) => track.queueId === command.queueId);
        if (index < 0) throw new Error("This queue item is no longer available.");
        await this.select(index); break;
      }
      case "remove": {
        const index = this.queue.findIndex((track) => track.queueId === command.queueId);
        if (index < 0) throw new Error("This queue item is no longer available.");
        const current = this.queue[this.index], paused = this.element.paused;
        this.cancelTransition(); this.queue.splice(index, 1); this.order = this.order.filter((id) => id !== command.queueId);
        if (!this.queue.length) {
          this.element.pause(); this.element.removeAttribute("src"); this.element.load(); this.index = 0; this.restoredTime = 0;
        } else if (index === this.index) await this.select(Math.min(index, this.queue.length - 1), 0, paused);
        else this.index = this.queue.indexOf(current!);
        break;
      }
      case "move": {
        const from = this.queue.findIndex((track) => track.queueId === command.queueId);
        const to = this.queue.findIndex((track) => track.queueId === command.before);
        if (from <= this.index || to <= this.index) throw new Error("Only upcoming songs can be reordered.");
        if (from === to) break;
        const target = this.queue[to]!;
        this.cancelTransition();
        const [track] = this.queue.splice(from, 1);
        this.queue.splice(this.queue.indexOf(target), 0, track!); this.order = this.queue.map((item) => item.queueId!);
        break;
      }
      case "dsp": this.cancelTransition(); await this.dsp.configure(command.settings); break;
      case "state": break;
    }
    this.emit(); this.persist();
  }

  dispose() {
    this.persist(); this.request?.abort(); this.disposed = true;
    this.listeners.forEach((remove) => remove()); this.cancelTransition();
    for (const element of this.options.elements) { element.pause(); element.removeAttribute("src"); element.load(); }
    this.dsp.dispose();
  }
}
