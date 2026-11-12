import { emptyPlayerState, type MobileTrack, type PlayerCollection, type PlayerState, type QueueContext, type QueueEntry, type QueuePage, type RepeatMode } from "./types";
import { editUpcoming, queueEntries, shuffleUpcoming } from "./queue";
import { confirmsHandoff, deviceStateSchema, handoffSchema, type DeviceCommand, type DeviceHandoff, type DeviceState } from "@mint/client";

export interface MediaSource { uri: string; headers?: Record<string, string>; name?: string }
export interface PlaylistStatus {
  currentIndex: number; currentTime: number; duration: number; playing: boolean;
  isBuffering: boolean; isLoaded: boolean; error?: unknown;
}
export interface PlaylistPort {
  readonly currentIndex: number;
  readonly currentTime: number;
  readonly trackCount: number;
  readonly playing: boolean;
  loop: "none" | "single" | "all";
  add(source: MediaSource): void;
  remove(index: number): void;
  clear(): void;
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  skipTo(index: number): void;
  seekTo(seconds: number): Promise<void>;
  setActiveForLockScreen(active: boolean, metadata?: { title: string; artist?: string; albumTitle?: string; artworkUrl?: string }): void;
  destroy(): void;
}
export interface PlaybackApi {
  openQueue(input: { collection: PlayerCollection; shuffle: boolean; trackId?: string; occurrenceId?: string }, signal: AbortSignal): Promise<QueuePage>;
  queuePage(id: string, position: number, signal: AbortSignal): Promise<QueuePage>;
  source(track: MobileTrack): Promise<MediaSource>;
  artworkUrl(path?: string): string | undefined;
  validate(signal: AbortSignal): Promise<void>;
  metadata?(id: string, signal: AbortSignal): Promise<MobileTrack>;
}
export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
interface Snapshot {
  version: 1;
  entries: QueueEntry[];
  index: number;
  time: number;
  repeat: RepeatMode;
  shuffle: boolean;
  context?: QueueContext | null;
  order?: string[];
}

export class PlaybackEngine {
  state: PlayerState = { ...emptyPlayerState };
  private entries: QueueEntry[] = [];
  private context: QueueContext | null = null;
  private request = new AbortController();
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private edited = false;
  private originalOrder: QueueEntry[] = [];
  private saving: Promise<void> = Promise.resolve();
  private lastSaved = 0;
  private metadata = new Map<string, QueueEntry>();
  private metadataRequest = -1;
  private identities = new Set<string>();
  private bufferingSince = 0;
  private bufferingTimeout: ReturnType<typeof setTimeout> | null = null;
  private transportValidation: Promise<void> | null = null;
  private lastTransportValidation = 0;
  private editing = false;
  private failed = false;

  constructor(
    private playlist: PlaylistPort,
    private api: PlaybackApi,
    private storage: QueueStorage,
    private scope: string,
    private uuid: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.state;
  getDeviceState(): DeviceState {
    const position = this.playlist.currentIndex;
    const offset = this.context && !this.edited ? Math.max(0, position - 20) : 0;
    const entries = this.context && !this.edited ? this.entries.slice(offset, offset + 100) : this.entries;
    return deviceStateSchema.parse({
      playing: this.state.playing, time: this.state.time, duration: this.state.duration, volume: 100,
      trackId: this.entries[position]?.id ?? null, queue: entries.map((entry) => entry.id),
      currentIndex: Math.max(0, position - offset), shuffle: this.state.shuffle,
      repeat: this.state.repeat === "one" ? 1 : this.state.repeat === "all" ? 2 : 0,
      queueContext: this.context && !this.edited ? { ...this.context, offset, position, shuffle: this.state.shuffle } : null,
      queueEntryIds: this.context && !this.edited ? entries.map((entry) => entry.occurrenceId) : null,
    });
  }
  async executeDevice(command: DeviceCommand, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (command.action === "pause") { this.playlist.pause(); this.publish({ playing: false }); }
    else if (command.action === "play") { if (!this.state.playing) await this.toggle(signal); }
    else if (command.action === "next") await this.next();
    else if (command.action === "previous") await this.previous();
    else if (command.action === "seek") await this.seek(command.value);
    else if (command.action === "clear") { this.begin(); this.playlist.pause(); this.playlist.clear(); this.entries = []; this.publish(emptyPlayerState); }
    else throw new Error("This installed player supports playback moves and transport controls, not remote volume or queue editing.");
    signal?.throwIfAborted();
  }
  async applyDeviceHandoff(input: DeviceHandoff, signal: AbortSignal) {
    const target = handoffSchema.parse(input);
    signal.throwIfAborted();
    const generation = this.begin();
    const cancel = () => {
      if (generation !== this.generation) return;
      this.generation++; this.request.abort(); this.playlist.pause(); this.publish({ playing: false, loading: false });
    };
    const current = () => {
      signal.throwIfAborted();
      if (this.disposed || generation !== this.generation) throw new Error("Playback changed during the move.");
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await this.api.validate(this.request.signal);
      current();
      if (target.queueContext) {
        const context = target.queueContext;
        if (context.total > 50_000) throw new Error("This native queue exceeds 50,000 songs.");
        const first = await this.api.queuePage(context.id, 0, this.request.signal);
        if (first.context.revision !== context.revision || first.context.total !== context.total) throw new Error("The playback queue changed. Try moving it again.");
        current();
        await this.replace(queueEntries(first), Math.min(context.position, first.items.length - 1), false);
        current();
        this.context = context;
        this.publish({ shuffle: target.shuffle });
        await this.prepareRemaining(context, generation, first.items.length, context.position < first.items.length, context.position, false);
      } else {
        const entries: QueueEntry[] = [];
        for (const id of target.queue) {
          signal.throwIfAborted();
          if (!this.api.metadata) throw new Error("Song details are unavailable.");
          const track = await this.api.metadata(id, this.request.signal);
          current();
          entries.push({ ...track, occurrenceId: this.uuid() });
        }
        await this.replace(entries, target.currentIndex, false);
        this.publish({ shuffle: target.shuffle });
      }
      current();
      this.setRepeat(target.repeat === 1 ? "one" : target.repeat === 2 ? "all" : "off");
      await this.playlist.seekTo(target.position);
      current();
      this.publish({ time: target.position, playing: false });
      if (target.playing) this.playlist.play();
      // Status from the audio port, not play() admission, confirms destination playback.
      while (!confirmsHandoff(this.getDeviceState(), target) || (target.playing && this.state.loading)) {
        signal.throwIfAborted();
        if (this.disposed || generation !== this.generation || this.state.error) throw new Error(this.state.error || "Playback changed during the move.");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      this.persist();
    } catch (error) {
      if (generation === this.generation) { this.playlist.pause(); this.publish({ playing: false, loading: false }); }
      throw error;
    } finally { signal.removeEventListener("abort", cancel); }
  }
  private publish(patch: Partial<PlayerState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  fail(error: unknown) {
    if (this.disposed) return;
    this.failed = true;
    this.clearBufferingTimeout();
    this.playlist.pause();
    this.publish({ error: error instanceof Error ? error.message : "Playback failed. Try again.", loading: false, playing: false });
  }
  reportError(error: unknown) {
    this.publish({ error: error instanceof Error ? error.message : "This action failed. Try again.", loading: false });
  }
  private begin() {
    this.clearBufferingTimeout();
    this.request.abort();
    this.request = new AbortController();
    this.generation++;
    this.context = null;
    this.edited = false;
    this.metadata.clear();
    this.metadataRequest = -1;
    this.publish({ loading: true, error: null, queueLoading: false });
    return this.generation;
  }
  private remember(entries: QueueEntry[]) {
    for (const entry of entries) this.metadata.set(entry.occurrenceId, entry);
    while (this.metadata.size > 300) {
      const key = this.metadata.keys().next().value!;
      if (key === this.state.track?.occurrenceId) {
        const track = this.metadata.get(key)!;
        this.metadata.delete(key);
        this.metadata.set(key, track);
      } else this.metadata.delete(key);
    }
  }
  private updateQueue() {
    const index = this.playlist.currentIndex;
    const entry = this.entries[index];
    const track = entry ? this.metadata.get(entry.occurrenceId) ?? entry : null;
    this.publish({
      track,
      queue: this.entries.slice(index + 1, index + 101).map((item) => this.metadata.get(item.occurrenceId) ?? item),
      queueTotal: this.context?.total ?? this.entries.length,
    });
  }
  async restore() {
    const generation = this.generation;
    const raw = await this.storage.getItem(this.scope);
    if (!raw || this.disposed || generation !== this.generation) return;
    const value: unknown = JSON.parse(raw);
    if (!validSnapshot(value)) {
      await this.storage.removeItem(this.scope);
      throw new Error("The saved queue was invalid and has been removed.");
    }
    this.publish({ track: value.entries[value.index]! });
    await this.api.validate(this.request.signal);
    if (this.disposed || generation !== this.generation) return;
    await this.replace(value.entries, value.index, false);
    if (this.disposed || generation !== this.generation) return;
    this.setRepeat(value.repeat);
    this.context = value.context ?? null;
    try { await this.hydrateCurrent(); }
    catch (error) {
      if (!isConnectionFailure(error)) throw error;
      this.reportError(new Error("Offline song details are shown from the saved queue."));
    }
    if (this.disposed || generation !== this.generation) return;
    this.publish({ shuffle: value.shuffle });
    await this.playlist.seekTo(value.time);
    this.publish({ time: value.time, playing: false, loading: false });
    if (this.context && this.entries.length < this.context.total) {
      await this.prepareRemaining(this.context, generation, this.entries.length, true, value.index, false);
    } else if (value.order) {
      const byId = new Map(this.entries.map((entry) => [entry.occurrenceId, entry]));
      this.originalOrder = value.order.map((id) => byId.get(id)!);
    }
  }
  private async replace(entries: QueueEntry[], index: number, play: boolean) {
    const generation = this.generation;
    const sources: MediaSource[] = [];
    for (const entry of entries) {
      sources.push(await this.api.source(entry));
      if (generation !== this.generation || this.disposed) return;
    }
    this.playlist.pause();
    this.playlist.clear();
    this.failed = false;
    this.clearBufferingTimeout();
    this.entries = entries;
    this.identities = new Set(entries.map((entry) => entry.occurrenceId));
    this.originalOrder = [...entries];
    this.remember(entries);
    for (const source of sources) this.playlist.add(source);
    if (entries.length) {
      this.playlist.skipTo(index);
      this.playlist.setActiveForLockScreen(true, this.lockMetadata(entries[index]!));
      if (play) this.playlist.play();
    }
    this.updateQueue();
    this.publish({ loading: false, time: 0, playing: play && !!entries.length });
    this.persist();
  }
  private lockMetadata(track: MobileTrack) {
    let artworkUrl: string | undefined;
    if (track.thumb) {
      try { artworkUrl = this.api.artworkUrl(track.thumb); }
      catch (error) {
        this.reportError(new Error(`Lock-screen artwork is unavailable: ${error instanceof Error ? error.message : "Invalid artwork address."}`));
      }
    }
    return { title: track.title || "Mint", artist: track.artist, albumTitle: track.album,
      ...(artworkUrl ? { artworkUrl } : {}) };
  }
  async playTrack(track: MobileTrack) {
    const generation = this.begin();
    await this.api.validate(this.request.signal);
    if (generation !== this.generation || this.disposed) return;
    const occurrenceId = this.uuid();
    await this.replace([{ ...track, occurrenceId }], 0, true);
  }
  async playCollection(collection: PlayerCollection, options: { shuffle?: boolean; id?: string; occurrenceId?: string } = {}) {
    const generation = this.begin();
    const page = await this.api.openQueue({ collection, shuffle: !!options.shuffle, trackId: options.id, occurrenceId: options.occurrenceId }, this.request.signal);
    if (generation !== this.generation || this.disposed) return;
    if (page.context.total > 50_000) throw new Error("This native queue exceeds 50,000 songs. Choose a smaller collection.");
    // Fetch from zero so previous/repeat-all retain the entire frozen membership.
    const first = page.context.offset ? await this.api.queuePage(page.context.id, 0, this.request.signal) : page;
    if (generation !== this.generation || this.disposed) return;
    await this.replace(queueEntries(first), Math.min(page.context.position, first.items.length - 1), false);
    if (generation !== this.generation || this.disposed) return;
    this.context = page.context;
    this.publish({ shuffle: page.context.shuffle, queueLoading: first.items.length < page.context.total });
    let selected = page.context.position < first.items.length;
    if (selected && first.items.length) this.playlist.play();
    this.updateQueue();
    await this.prepareRemaining(page.context, generation, first.items.length, selected, page.context.position, true);
  }
  private async prepareRemaining(context: QueueContext, generation: number, start: number, selected: boolean, selectedPosition: number, autoplay: boolean) {
    this.publish({ queueLoading: start < context.total });
    for (let offset = start; offset < context.total;) {
      const next = await this.api.queuePage(context.id, offset, this.request.signal);
      if (generation !== this.generation || this.disposed) return;
      if (next.context.revision !== context.revision || next.context.offset > offset || next.context.total !== context.total) {
        throw new Error("The collection queue changed while loading. Choose it again.");
      }
      const hydrated = queueEntries(next);
      const slice = hydrated.slice(offset - next.context.offset);
      if (!slice.length) throw new Error("The server returned an incomplete queue. Try this collection again.");
      this.remember(hydrated);
      for (const entry of slice) {
        const source = await this.api.source(entry);
        if (generation !== this.generation || this.disposed) return;
        if (this.identities.has(entry.occurrenceId)) throw new Error("Duplicate queue occurrence received.");
        this.identities.add(entry.occurrenceId);
        this.entries.push({ id: entry.id, occurrenceId: entry.occurrenceId, title: "" });
        this.playlist.add(source);
      }
      offset += slice.length;
      if (!selected && selectedPosition < this.entries.length) {
        selected = true;
        this.playlist.skipTo(selectedPosition);
        if (autoplay) this.playlist.play();
      }
      this.updateQueue();
    }
    this.originalOrder = [...this.entries];
    this.publish({ queueLoading: false });
    this.metadataRequest = -1;
    await this.hydrateCurrent();
    this.persist();
  }
  onStatus(status: PlaylistStatus) {
    if (this.disposed || this.failed) return;
    if (status.error) {
      const detail = typeof status.error === "object" && status.error !== null && "message" in status.error
        ? String(status.error.message) : String(status.error);
      const native = typeof status.error === "object" && status.error !== null ? status.error : {};
      const code = "codeName" in native && typeof native.codeName === "string" ? native.codeName
        : "code" in native && typeof native.code === "number" ? `Native code ${native.code}` : "";
      const http = "responseCode" in native && typeof native.responseCode === "number" ? `HTTP ${native.responseCode}` : "";
      const diagnostics = [code, http].filter(Boolean).join(", ");
      this.fail(new Error(`Audio could not play: ${detail}${diagnostics ? ` (${diagnostics})` : ""}. Check your connection or sign in again.`));
      this.validateTransportFailure();
      return;
    }
    this.publish({ playing: status.playing, time: Number.isFinite(status.currentTime) ? status.currentTime : 0,
      duration: Number.isFinite(status.duration) ? status.duration : 0,
      loading: this.entries.length > 0 && (status.isBuffering || !status.isLoaded) });
    if (this.state.loading) {
      if (!this.bufferingSince) {
        this.bufferingSince = Date.now();
        this.bufferingTimeout = setTimeout(() => {
          this.bufferingTimeout = null;
          this.bufferingSince = 0;
          this.fail(new Error("Audio could not load in 30 seconds. Check your connection or try MP3 compatibility."));
          this.validateTransportFailure();
        }, 30_000);
      }
      if (Date.now() - this.bufferingSince > 30_000) {
        this.fail(new Error("Audio is taking too long to load. Check your connection, try again, or choose MP3 compatibility."));
        this.bufferingSince = 0;
        return;
      }
    } else {
      this.clearBufferingTimeout();
    }
    const oldId = this.state.track?.occurrenceId;
    this.updateQueue();
    if (oldId !== this.state.track?.occurrenceId && this.state.track) {
      void this.refreshCurrentMetadata();
    }
    if (Date.now() - this.lastSaved >= 5000) this.persist();
  }
  private clearBufferingTimeout() {
    if (this.bufferingTimeout) clearTimeout(this.bufferingTimeout);
    this.bufferingTimeout = null;
    this.bufferingSince = 0;
  }
  private validateTransportFailure() {
    if (this.disposed || this.transportValidation || Date.now() - this.lastTransportValidation < 5000) return;
    this.lastTransportValidation = Date.now();
    const signal = this.request.signal;
    this.transportValidation = this.api.validate(signal).catch((error: unknown) => {
      if (signal.aborted || this.disposed) return;
      if (isConnectionFailure(error)) return;
      this.fail(error);
    }).finally(() => { this.transportValidation = null; });
  }
  private async hydrateCurrent() {
    const index = this.playlist.currentIndex, generation = this.generation;
    if (this.metadataRequest === index || !this.entries[index]) return;
    this.metadataRequest = index;
    if (this.context && !this.edited) {
      const page = await this.api.queuePage(this.context.id, index, this.request.signal);
      if (generation !== this.generation || this.disposed || index !== this.playlist.currentIndex) return;
      this.remember(queueEntries(page));
    } else if (this.api.metadata) {
      const entry = this.entries[index]!;
      const track = await this.api.metadata(entry.id, this.request.signal);
      if (generation !== this.generation || this.disposed || index !== this.playlist.currentIndex) return;
      this.remember([{ ...track, occurrenceId: entry.occurrenceId }]);
    }
    this.updateQueue();
    if (this.state.track) this.playlist.setActiveForLockScreen(true, this.lockMetadata(this.state.track));
  }
  private async refreshCurrentMetadata() {
    const generation = this.generation, index = this.playlist.currentIndex;
    try {
      if (this.state.track) this.playlist.setActiveForLockScreen(true, this.lockMetadata(this.state.track));
      await this.hydrateCurrent();
    }
    catch (error) {
      if (generation !== this.generation || this.disposed || index !== this.playlist.currentIndex) return;
      this.metadataRequest = -1;
      if (isConnectionFailure(error)) this.reportError(new Error("Song details could not refresh while offline."));
      else this.fail(error);
    }
  }
  async toggle(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.entries.length) return;
    const generation = this.generation;
    if (this.playlist.playing) this.playlist.pause();
    else {
      await this.api.validate(this.request.signal);
      signal?.throwIfAborted();
      if (generation === this.generation && !this.disposed) {
        if (this.state.error) await this.reloadSources();
        signal?.throwIfAborted();
        if (generation !== this.generation || this.disposed) return;
        this.publish({ error: null });
        this.playlist.setActiveForLockScreen(true, this.lockMetadata(this.state.track!));
        this.playlist.play();
      }
    }
    this.persist();
  }
  async reloadSources() {
    if (!this.entries.length) return;
    if (this.editing || this.state.queueLoading) throw new Error("Wait for the queue to finish preparing before changing playback sources.");
    const generation = this.generation;
    const entries = this.entries.map((entry) => this.metadata.get(entry.occurrenceId) ?? entry);
    const index = this.playlist.currentIndex, time = this.playlist.currentTime, playing = this.playlist.playing;
    const context = this.context, originalOrder = this.originalOrder;
    await this.replace(entries, index, false);
    if (generation !== this.generation || this.disposed) return;
    this.context = context;
    this.originalOrder = originalOrder;
    await this.playlist.seekTo(time);
    if (playing) this.playlist.play();
    this.publish({ error: null });
  }
  async next() {
    const generation = this.generation;
    if (this.failed) await this.reloadSources();
    if (generation !== this.generation || this.disposed) return;
    const oldId = this.state.track?.occurrenceId;
    this.playlist.next();
    this.updateQueue();
    if (oldId !== this.state.track?.occurrenceId) await this.refreshCurrentMetadata();
    this.persist();
  }
  async previous() {
    const generation = this.generation;
    if (this.failed) await this.reloadSources();
    if (generation !== this.generation || this.disposed) return;
    const oldId = this.state.track?.occurrenceId;
    if (this.playlist.currentTime > 3) await this.playlist.seekTo(0);
    else this.playlist.previous();
    this.updateQueue();
    if (oldId !== this.state.track?.occurrenceId) await this.refreshCurrentMetadata();
    this.persist();
  }
  async seek(seconds: number) {
    if (!Number.isFinite(seconds)) throw new Error("Invalid playback position.");
    await this.playlist.seekTo(Math.max(0, Math.min(seconds, this.state.duration || seconds)));
    this.persist();
  }
  setRepeat(mode: RepeatMode) {
    this.playlist.loop = mode === "all" ? "all" : mode === "one" ? "single" : "none";
    this.publish({ repeat: mode });
    this.persist();
  }
  private async replaceUpcoming(next: QueueEntry[]) {
    if (this.editing) throw new Error("Another queue edit is still finishing. Try again in a moment.");
    this.editing = true;
    try {
      const generation = this.generation, current = this.playlist.currentIndex;
      const currentId = this.entries[current]?.occurrenceId;
      const sources: MediaSource[] = [];
      for (const entry of next.slice(current + 1)) sources.push(await this.api.source(entry));
      if (generation !== this.generation || this.disposed) return;
      if (this.entries[this.playlist.currentIndex]?.occurrenceId !== currentId) throw new Error("The song changed while editing. Try again.");
      // iOS insert rebuilds the current AVPlayerItem. Remove/add only FUTURE items.
      for (let index = this.entries.length - 1; index > current; index--) this.playlist.remove(index);
      this.entries = next;
      for (const source of sources) this.playlist.add(source);
      this.edited = true;
      this.context = null;
      this.updateQueue();
      this.persist();
    } finally { this.editing = false; }
  }
  async setShuffle(enabled: boolean) {
    if (this.state.queueLoading) throw new Error("Wait for the full queue to finish loading before shuffling.");
    const generation = this.generation;
    const current = this.playlist.currentIndex;
    const visited = new Set(this.entries.slice(0, current + 1).map((entry) => entry.occurrenceId));
    const order = enabled ? shuffleUpcoming(this.entries, current)
      : [...this.entries.slice(0, current + 1), ...this.originalOrder.filter((entry) => !visited.has(entry.occurrenceId))];
    await this.replaceUpcoming(order);
    if (generation === this.generation) {
      this.publish({ shuffle: enabled });
      this.persist();
    }
  }
  async addToQueue(track: MobileTrack) {
    if (this.state.queueLoading) throw new Error("Wait for the queue to finish loading before adding songs.");
    if (this.editing) throw new Error("Another queue edit is still finishing. Try again in a moment.");
    this.editing = true;
    try {
      const generation = this.generation;
      const source = await this.api.source(track);
      if (generation !== this.generation || this.disposed) return;
      const entry = { ...track, occurrenceId: this.uuid() };
      this.entries.push(entry);
      this.originalOrder.push(entry);
      this.remember([entry]);
      this.playlist.add(source);
      this.context = null;
      this.updateQueue();
      this.persist();
    } finally { this.editing = false; }
  }
  async removeFromQueue(id: string) {
    if (this.state.queueLoading) throw new Error("Wait for the queue to finish loading before editing.");
    const generation = this.generation;
    await this.replaceUpcoming(editUpcoming(this.entries, this.playlist.currentIndex, id));
    if (generation === this.generation) {
      this.originalOrder = this.originalOrder.filter((entry) => entry.occurrenceId !== id);
      this.persist();
    }
  }
  async moveInQueue(id: string, before: string) {
    if (this.state.queueLoading) throw new Error("Wait for the queue to finish loading before editing.");
    await this.replaceUpcoming(editUpcoming(this.entries, this.playlist.currentIndex, id, before));
  }
  async clearUpcoming() {
    if (this.editing) throw new Error("Another queue edit is still finishing. Try again in a moment.");
    this.request.abort();
    this.generation++;
    this.request = new AbortController();
    this.publish({ queueLoading: false });
    await this.replaceUpcoming(this.entries.slice(0, this.playlist.currentIndex + 1));
    this.originalOrder = [...this.entries];
    this.persist();
  }
  persist() {
    if (this.disposed || !this.entries.length) return;
    this.lastSaved = Date.now();
    const value: Snapshot = { version: 1, entries: this.entries.map((entry) => this.metadata.get(entry.occurrenceId) ?? entry),
      index: this.playlist.currentIndex, time: this.playlist.currentTime, repeat: this.state.repeat, shuffle: this.state.shuffle, context: this.context,
      order: (this.originalOrder.length === this.entries.length ? this.originalOrder : this.entries).map((entry) => entry.occurrenceId) };
    this.saving = this.saving.then(() => this.storage.setItem(this.scope, JSON.stringify(value))).catch((error: unknown) => {
      this.publish({ error: `Queue could not be saved: ${error instanceof Error ? error.message : "storage unavailable"}.` });
    });
  }
  async revoke() {
    this.dispose();
    await this.saving;
    await this.storage.removeItem(this.scope);
  }
  dispose() {
    if (this.disposed) return;
    this.request.abort();
    if (this.bufferingTimeout) clearTimeout(this.bufferingTimeout);
    this.generation++;
    this.disposed = true;
    this.playlist.pause();
    this.playlist.setActiveForLockScreen(false);
    this.playlist.destroy();
    this.listeners.clear();
  }
}

function validSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("entries" in value) || !Array.isArray(value.entries) || value.entries.length > 50_000 ||
      !("index" in value) || !Number.isInteger(value.index) || Number(value.index) < 0 || Number(value.index) >= value.entries.length ||
      !("time" in value) || typeof value.time !== "number" || !Number.isFinite(value.time) || value.time < 0 ||
      !("shuffle" in value) || typeof value.shuffle !== "boolean" || !("repeat" in value) ||
      !["off", "all", "one"].includes(String(value.repeat))) return false;
  const entries: unknown[] = value.entries;
  if (!entries.every(validEntry)) return false;
  const identities = new Set(entries.map((entry) => entry.occurrenceId));
  if (identities.size !== entries.length) return false;
  if ("context" in value && value.context != null) {
    const context = value.context;
    if (typeof context !== "object" || !("id" in context) || typeof context.id !== "string" ||
        !("total" in context) || !Number.isInteger(context.total) || Number(context.total) < entries.length || Number(context.total) > 50_000 ||
        !("revision" in context) || !Number.isInteger(context.revision) || Number(context.revision) < 1 ||
        !("offset" in context) || !Number.isInteger(context.offset) || Number(context.offset) < 0 ||
        !("position" in context) || !Number.isInteger(context.position) || Number(context.position) < 0 ||
        !("shuffle" in context) || typeof context.shuffle !== "boolean") return false;
  }
  if ("order" in value && value.order !== undefined) {
    if (!Array.isArray(value.order) || value.order.length !== entries.length ||
        value.order.some((id: unknown) => typeof id !== "string") || new Set(value.order).size !== value.order.length ||
        value.order.some((id: string) => !identities.has(id))) return false;
  }
  return true;
}

function validEntry(entry: unknown): entry is QueueEntry {
  return !!entry && typeof entry === "object" &&
    "id" in entry && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 100 && "title" in entry && typeof entry.title === "string" && entry.title.length <= 1000 &&
    "occurrenceId" in entry && typeof entry.occurrenceId === "string" && entry.occurrenceId.length <= 128 &&
    ["artist", "album", "thumb"].every((key) => validOptionalText(entry, key));
}

function isConnectionFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && "status" in error && error.status === 0;
}

function validOptionalText(entry: object, key: string): boolean {
  const value: unknown = Reflect.get(entry, key);
  return value === undefined || typeof value === "string" && value.length <= 2048;
}
