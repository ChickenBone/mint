import { z } from "zod";
import { artworkPath } from "@mint/core/artwork";
import { BrowserDSP } from "./browser-dsp";
import { itemCollection, loadCollection, shuffled } from "./browser-catalog";
import { defaultDsp, dspSchema, playerItemSchema, type PlayerCommand, type PlayerItem, type PlayerState } from "./player-protocol";
import type { TrackAnalysis } from "@mint/core/analysis";
import type { DeviceState } from "@mint/core/devices";
import { normalizationGain, smartTransition } from "./smart-fades";
import { fetchQueue, queueContextSchema, type QueueContext, type QueueEdit, type QueuePage } from "./progressive-queue";

const snapshotSchema = z.object({
  version: z.literal(1), queue: z.array(playerItemSchema.extend({ type: z.literal("track"), id: z.uuid(), queueId: z.union([z.string().regex(/^\d+$/), z.uuid()]) })).max(50_000),
  index: z.number().int().nonnegative(), time: z.number().finite().nonnegative(),
  shuffle: z.boolean(), repeat: z.number().int().min(0).max(2), volume: z.number().min(0).max(100), dsp: dspSchema,
  order: z.array(z.string()).max(50_000),
  format: z.enum(["original", "mp3"]).default("original"),
  context: queueContextSchema.optional(),
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
  private analysis = new Map<string, TrackAnalysis | null>();
  private analysisChecked = new Map<string, number>();
  private sources = new Map<HTMLAudioElement, string>();
  private transitionDetail = "Transitions off";
  private format: "original" | "mp3" = "original";
  private context?: QueueContext;
  private contextRestored = false;
  private windowLoad?: Promise<number>;

  constructor(private options: {
    memberId: string; elements: [HTMLAudioElement, HTMLAudioElement];
    update: (state: PlayerState) => void; error: (message: string) => void;
    fetcher?: typeof fetch; storage?: Storage;
    source?: (track: PlayerItem, format: "original" | "mp3") => Promise<string>;
    analysis?: (id: string) => Promise<TrackAnalysis | null>;
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

  private report(error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (!this.disposed) this.options.error(error instanceof Error ? error.message : "Playback failed. Try again.");
  }

  private isSameAlbumSequence(track: PlayerItem | null | undefined): boolean {
    if (!track || this.shuffle || !track.albumId || !track.album) return false;
    const prev = this.queue[this.index - 1];
    const next = this.queue[this.index + 1];
    return Boolean((prev && prev.albumId === track.albumId) || (next && next.albumId === track.albumId));
  }

  private computeNormalizationDb(track: PlayerItem | null | undefined): number {
    if (!track || !this.dsp.settings.normalize) return 0;
    return normalizationGain(this.analysis.get(track.id), this.dsp.settings.targetLufs, {
      mode: this.dsp.settings.normalizeMode,
      sameAlbumSequence: this.isSameAlbumSequence(track),
    });
  }

  getState(): PlayerState {
    const track = this.queue[this.index] ?? null;
    const loaded = Boolean(this.element.getAttribute("src"));
    const offset = this.context ? 0 : Math.max(0, this.index - 100);
    return {
      playing: loaded && !this.element.paused, time: loaded ? Math.round(this.element.currentTime * 1000) || 0 : this.restoredTime,
      duration: loaded && Number.isFinite(this.element.duration) ? Math.round(this.element.duration * 1000) : track?.duration ?? 0,
      volume: this.element.volume * 100, shuffle: this.shuffle, repeat: this.repeat, track,
      queue: this.queue.slice(offset, offset + 1000), queueTotal: this.context?.total ?? this.queue.length, queueOffset: this.context?.offset ?? offset,
      dsp: this.dsp.settings, dspAvailable: typeof window !== "undefined" && Boolean(window.AudioContext), transitioning: this.transitioning,
      transitionDetail: this.transitionDetail,
      normalizationDb: this.computeNormalizationDb(track),
      playbackFormat: this.format,
    };
  }

  getDeviceState(): DeviceState {
    const state = this.getState();
    return { playing: state.playing, time: state.time / 1000, duration: state.duration / 1000, volume: state.volume,
      trackId: state.track?.id ?? null, queue: this.queue.map((track) => track.id), currentIndex: this.index,
      queueContext: this.context ? { ...this.context, position: this.context.offset + this.index } : null,
      queueEntryIds: this.context ? this.queue.map((track) => track.queueId!) : null,
      shuffle: this.shuffle, repeat: this.repeat as 0 | 1 | 2 };
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
      this.queue = snapshot.queue.map((track) => ({ ...track, thumb: artworkPath(track.id) }));
      this.index = snapshot.index; this.order = snapshot.order;
      this.sequence = snapshot.queue.reduce((max, track) => Math.max(max, /^\d+$/.test(track.queueId) ? Number(track.queueId) : 0), 0);
      this.context = snapshot.context; this.contextRestored = Boolean(snapshot.context);
      this.shuffle = snapshot.shuffle; this.repeat = snapshot.repeat; this.restoredTime = snapshot.time;
      this.format = snapshot.format;
      for (const element of this.options.elements) element.volume = snapshot.volume / 100;
      this.dsp.settings = snapshot.dsp;
      if ((typeof window === "undefined" || !window.AudioContext) && (snapshot.dsp.enabled || snapshot.dsp.compressor || snapshot.dsp.crossfade > 0 || snapshot.dsp.normalize || snapshot.dsp.loudnessContour || snapshot.dsp.stereoMode !== "normal")) {
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
        format: this.format,
        ...(this.context ? { context: { ...this.context, position: this.context.offset + this.index } } : {}),
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
      this.releaseSource(element);
    }
    this.dsp.select(this.element);
  }

  pause() {
    this.request?.abort(); this.cancelTransition(); this.element.pause(); this.emit(); this.persist();
  }

  revoke(message: string) {
    this.pause();
    this.element.removeAttribute("src"); this.element.load(); this.restoredTime = 0;
    this.releaseSource(this.element);
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
    if (this.contextRestored && this.context) {
      const request = this.request = new AbortController();
      const page = await fetchQueue(`/${this.context.id}?position=${this.context.position}`, undefined, request.signal, this.options.fetcher);
      request.signal.throwIfAborted(); this.applyPage(page); this.contextRestored = false;
    }
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
    const generation = this.transitionGeneration;
    if (!await this.setSource(this.element, track, generation)) return;
    this.analyze(track, this.element);
    if (time > 0) this.element.currentTime = Math.min(time, track.duration || time) / 1000;
    this.emit();
    if (!paused) await this.resume();
    this.emit();
  }

  private releaseSource(element: HTMLAudioElement) {
    const url = this.sources.get(element);
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    this.sources.delete(element);
  }

  private async setSource(element: HTMLAudioElement, track: PlayerItem, generation: number) {
    const url = this.options.source ? await this.options.source(track, this.format) : `/api/player/audio/${track.id}${this.format === "mp3" ? "?format=mp3" : ""}`;
    if (generation !== this.transitionGeneration || this.disposed) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      return false;
    }
    this.releaseSource(element);
    this.sources.set(element, url); element.src = url;
    return true;
  }

  private analyze(track: PlayerItem, element: HTMLAudioElement) {
    const apply = () => {
      const current = element === this.element ? this.queue[this.index] : this.queue.find((item) => item.queueId === this.prepared);
      if (current?.id === track.id) this.dsp.normalize(element, this.computeNormalizationDb(track));
    };
    if (this.analysis.has(track.id) && Date.now() - (this.analysisChecked.get(track.id) ?? 0) < (this.analysis.get(track.id) ? 1800_000 : 60_000)) { apply(); return; }
    this.dsp.normalize(element, 0);
    if (this.options.analysis) {
      this.analysis.set(track.id, null);
      this.analysisChecked.set(track.id, Date.now());
      void this.options.analysis(track.id).then((value) => {
        if (this.disposed) return;
        this.analysis.set(track.id, value); apply(); this.emit();
      }).catch((error: unknown) => this.report(error));
    }
  }

  private async next(ended = false) {
    if (ended && this.repeat === 1) return this.select(this.index);
    if (this.context) {
      const absolute = this.context.offset + this.index + 1;
      if (absolute < this.context.total) await this.hydrate(absolute);
      else if (this.repeat === 2) { await this.hydrate(0); return this.select(0); }
      else { this.pause(); return; }
    }
    const next = this.index + 1;
    const target = next < this.queue.length ? next : this.repeat === 2 && this.queue.length ? 0 : -1;
    const standby = this.options.elements.find((element) => element !== this.element)!;
    if (ended && target >= 0 && this.prepared === this.queue[target]?.queueId && standby.readyState >= 3) {
      const previous = this.element, generation = ++this.transitionGeneration;
      this.element = standby; this.index = target; this.prepared = undefined;
      this.transitionPending = false; this.failedPreload = undefined;
      this.dsp.select(standby);
      previous.pause(); previous.removeAttribute("src"); previous.load(); this.releaseSource(previous);
      await this.dsp.initialize();
      if (generation !== this.transitionGeneration || this.disposed) return;
      await standby.play(); this.emit(); this.persist(); return;
    }
    if (next < this.queue.length) return this.select(next);
    if (this.repeat === 2 && this.queue.length) return this.select(0);
    this.pause();
  }

  private async transition() {
    const maxSeconds = this.dsp.settings.crossfade, remaining = this.element.duration - this.element.currentTime;
    if (this.transitioning || this.transitionPending || this.element.paused || this.repeat === 1 ||
        !Number.isFinite(remaining) || remaining <= 0) return;
    if (this.context && this.index + 1 === this.queue.length && this.context.offset + this.index + 1 < this.context.total) {
      await this.hydrate(this.context.offset + this.index + 1);
    }
    const index = this.index + 1 < this.queue.length ? this.index + 1 : !this.context && this.repeat === 2 ? 0 : -1;
    if (index < 0 || index === this.index) return;
    const track = this.queue[index]!, standby = this.options.elements.find((element) => element !== this.element)!;
    const current = this.queue[this.index]!;
    const plan = smartTransition({ from: current, to: track, outgoing: this.analysis.get(current.id), incoming: this.analysis.get(track.id),
      settings: this.dsp.settings, shuffled: this.shuffle, outgoingDuration: this.element.duration });
    this.transitionDetail = plan.reason;
    const seconds = plan.seconds, untilBoundary = plan.endAt - this.element.currentTime;
    if (untilBoundary > maxSeconds + 20) return;
    if (this.failedPreload === track.queueId) return;
    const generation = this.transitionGeneration, from = this.element;
    this.transitionPending = true;
    try {
      if (this.prepared !== track.queueId) {
        if (!await this.setSource(standby, track, generation)) return;
        standby.preload = "auto"; standby.load(); this.prepared = track.queueId; this.analyze(track, standby);
      }
      if (!seconds || untilBoundary > seconds || standby.readyState < 3) return;
      await this.dsp.initialize();
      if (generation !== this.transitionGeneration || this.disposed) return;
      if (plan.skipIntro > 0) standby.currentTime = plan.skipIntro;
      await standby.play();
      if (generation !== this.transitionGeneration || this.disposed) { standby.pause(); return; }
      const duration = Math.max(.05, Math.min(seconds, remaining, (standby.duration || seconds * 2) / 2));
      this.dsp.fade(from, standby, duration);
      this.element = standby; this.index = index; this.prepared = undefined; this.transitioning = true;
      this.emit();
      this.fadeTimer = setTimeout(() => {
        from.pause(); from.removeAttribute("src"); from.load();
        this.releaseSource(from);
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

  private applyPage(page: QueuePage, preserve?: string) {
    this.contextRestored = false;
    this.context = page.context; this.queue = page.items; this.order = this.queue.map((track) => track.queueId!);
    this.shuffle = page.context.shuffle;
    const retained = preserve ? this.queue.findIndex((track) => track.queueId === preserve) : -1;
    this.index = retained >= 0 ? retained : Math.max(0, page.context.position - page.context.offset);
  }

  private async hydrate(position: number): Promise<number> {
    if (!this.context) return position;
    if (position >= this.context.offset && position < this.context.offset + this.queue.length) return position - this.context.offset;
    if (this.windowLoad) {
      const id = this.context.id, generation = this.transitionGeneration;
      try { await this.windowLoad; }
      catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) throw error; }
      if (this.disposed || this.context?.id !== id || generation !== this.transitionGeneration) throw new DOMException("Queue selection changed", "AbortError");
      return this.hydrate(position);
    }
    const id = this.context.id, revision = this.context.revision, current = this.queue[this.index]?.queueId;
    const request = this.request = new AbortController();
    const work = (async () => {
      const page = await fetchQueue(`/${id}?position=${position}`, undefined, request.signal, this.options.fetcher);
      request.signal.throwIfAborted();
      if (this.disposed || this.context?.id !== id) throw new DOMException("Queue selection changed", "AbortError");
      if (page.context.revision !== revision) throw new Error("This queue changed on another device. Select the collection again before continuing.");
      this.applyPage(page, current); this.emit();
      return position - page.context.offset;
    })();
    this.windowLoad = work;
    try { return await work; } finally { this.windowLoad = undefined; }
  }

  private async editContext(edit: QueueEdit) {
    const context = this.context!, current = this.queue[this.index], state = this.getState();
    if (!current) throw new Error("Choose a song before editing the queue.");
    this.cancelTransition();
    const generation = this.transitionGeneration, request = this.request = new AbortController();
    const page = await fetchQueue(`/${context.id}`, { revision: context.revision, currentId: current.queueId, edit }, request.signal, this.options.fetcher);
    request.signal.throwIfAborted();
    if (generation !== this.transitionGeneration) throw new DOMException("Playback changed during queue editing", "AbortError");
    this.applyPage(page);
    if (!page.items.length) {
      this.pause(); this.context = undefined; this.restoredTime = 0; this.element.removeAttribute("src"); this.element.load(); this.releaseSource(this.element);
    } else if (this.queue[this.index]!.queueId !== current.queueId) await this.select(this.index, 0, !state.playing);
  }

  async execute(command: PlayerCommand, forcePlay = false): Promise<void> {
    if (this.disposed) throw new Error("The player has closed.");
    if (!["state", "volume", "dsp"].includes(command.action)) this.request?.abort();
    if (this.context && ["shuffle", "clear", "remove", "move", "add-to-queue", "next-in-queue"].includes(command.action)) {
      if (command.action === "shuffle") await this.editContext({ action: "shuffle", enabled: !this.shuffle });
      else if (command.action === "clear") await this.editContext({ action: "clear" });
      else if (command.action === "remove") await this.editContext({ action: "remove", entryId: command.queueId });
      else if (command.action === "move") await this.editContext({ action: "move", entryId: command.queueId, before: command.before });
      else if (command.action === "add-to-queue" || command.action === "next-in-queue") {
        const next = command.action === "next-in-queue";
        await this.editContext(command.item.type === "track"
          ? { action: "append", trackIds: [command.item.id], next }
          : { action: "append-collection", collection: itemCollection(command.item), next });
      }
      this.emit(); this.persist(); return;
    }
    switch (command.action) {
      case "context": {
        this.cancelTransition();
        const request = this.request = new AbortController();
        const page = await fetchQueue(`/${command.context.id}?position=${command.context.position}`, undefined, request.signal, this.options.fetcher);
        request.signal.throwIfAborted();
        this.applyPage(page); this.repeat = command.repeat;
        await this.select(this.index, command.position, command.paused);
        break;
      }
      case "items": {
        this.context = undefined; this.contextRestored = false;
        if (command.items.length > 50_000) throw new Error("A queue can contain at most 50,000 downloaded songs.");
        if (!command.items.length) {
          this.pause(); this.queue = []; this.order = []; this.index = 0; this.restoredTime = 0;
          this.element.removeAttribute("src"); this.element.load(); this.releaseSource(this.element); break;
        }
        const items = command.items.map((item) => playerItemSchema.extend({ id: z.uuid(), type: z.literal("track") }).parse(item));
        const index = command.index ?? 0;
        if (!Number.isSafeInteger(index) || index < 0 || index >= items.length) throw new Error("Invalid queue position.");
        if (command.position !== undefined && (!Number.isFinite(command.position) || command.position < 0)) throw new Error("Invalid playback position.");
        if (command.repeat !== undefined && ![0, 1, 2].includes(command.repeat)) throw new Error("Invalid repeat mode.");
        this.queue = items.map((item) => ({ ...item, queueId: String(++this.sequence) }));
        this.order = this.queue.map((item) => item.queueId!);
        this.shuffle = command.shuffle ?? false; this.repeat = command.repeat ?? this.repeat;
        await this.select(index, command.position, command.paused);
        break;
      }
      case "pause": this.pause(); break;
      case "resume": await this.resume(); break;
      case "format": {
        const state = this.getState(); this.format = command.format;
        if (state.track) await this.select(this.index, state.time, !state.playing);
        break;
      }
      case "collection":
      case "play":
      case "next-in-queue":
      case "add-to-queue": {
        const request = this.request = new AbortController();
        const collection = command.action === "collection" ? command.collection : itemCollection(command.item);
        if (command.action === "collection" || command.action === "play") {
          const page = await fetchQueue("", { collection, shuffle: Boolean(command.shuffle),
            trackId: command.action === "collection" ? command.id : command.item.type === "track" ? command.item.id : undefined,
            occurrenceId: command.action === "collection" ? command.occurrenceId : command.item.occurrenceId,
          }, request.signal, this.options.fetcher);
          request.signal.throwIfAborted();
          this.cancelTransition(); this.applyPage(page); this.contextRestored = false;
          await this.select(this.index);
          break;
        }
        const all = await loadCollection(collection, request.signal, this.options.fetcher);
        request.signal.throwIfAborted();
        const rows = command.item.type === "track" ? all.filter((track) => track.id === command.item.id) : all;
        if (!rows.length) throw new Error("No downloaded tracks are available for this selection.");
        const entries = rows.map((track) => ({ ...track, queueId: String(++this.sequence) }));
        this.cancelTransition();
        const current = this.queue[this.index], at = command.action === "next-in-queue" ? this.index + 1 : this.queue.length;
        this.queue.splice(at, 0, ...entries);
        const originalAt = command.action === "next-in-queue" && current ? this.order.indexOf(current.queueId!) + 1 : this.order.length;
        this.order.splice(originalAt, 0, ...entries.map((track) => track.queueId));
        if (!current) await this.select(0, 0, true);
        request.signal.throwIfAborted();
        break;
      }
      case "toggle": if (forcePlay || this.element.paused) await this.resume(); else this.pause(); break;
      case "next": await this.next(); break;
      case "previous":
        if (this.element.currentTime > 3) this.seek(0);
        else if (this.context) {
          const position = Math.max(0, this.context.offset + this.index - 1);
          await this.select(await this.hydrate(position));
        } else await this.select(Math.max(0, this.index - 1));
        break;
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
      case "dsp": {
        this.cancelTransition(); await this.dsp.configure(command.settings);
        this.transitionDetail = command.settings.fadeMode === "off" || !command.settings.crossfade ? "Transitions off"
          : command.settings.fadeMode === "smart" ? "Smart Fades · waiting for the next track boundary" : "Fixed equal-power crossfade";
        const track = this.queue[this.index];
        if (track) this.dsp.normalize(this.element, this.computeNormalizationDb(track));
        break;
      }
      case "state": break;
    }
    this.emit(); this.persist();
  }

  dispose() {
    this.persist(); this.request?.abort(); this.disposed = true;
    this.listeners.forEach((remove) => remove()); this.cancelTransition();
    for (const element of this.options.elements) { element.pause(); element.removeAttribute("src"); element.load(); this.releaseSource(element); }
    this.dsp.dispose();
  }
}
