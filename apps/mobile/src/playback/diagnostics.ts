import type { PlayerState } from "./types";
import type { PlaylistStatus } from "./engine";

export const DIAGNOSTICS_SAMPLES = 60;
export const DIAGNOSTICS_EVENTS = 24;
export type SourceMode = "original stream" | "MP3 stream" | "offline";
export interface DiagnosticSample {
  elapsedSec: number;
  positionSec: number | null;
  durationSec: number | null;
  buffering: boolean;
  loaded: boolean;
  loading: boolean;
  playing: boolean;
  queuePreparing: boolean;
  queueLoaded: number;
  queueTotal: number;
  nativeTrackCount: number;
  statusIntervalMs: number | null;
}
export interface DiagnosticEvent {
  kind: "queue request" | "queue page" | "native error";
  elapsedSec: number;
  latencyMs: number | null;
  httpStatus: number | null;
  nativeCode: number | null;
}
export interface DiagnosticsSnapshot {
  samples: DiagnosticSample[];
  events: DiagnosticEvent[];
  source: SourceMode | null;
  bufferingTransitions: number;
  loadLatencyMs: number | null;
}
export const emptyDiagnostics = (): DiagnosticsSnapshot => ({
  samples: [], events: [], source: null, bufferingTransitions: 0, loadLatencyMs: null,
});
const measured = (value: number) => Number.isFinite(value) && value >= 0 ? value : null;
const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** In-memory, opt-in recorder; never polls, saves traces or retains error messages/URLs. */
export class PlaybackDiagnostics {
  private enabled = false;
  private generation = 0;
  private started = 0;
  private lastSample: number | null = null;
  private lastStatus: number | null = null;
  private track: string | null = null;
  private buffering = false;
  private loadingSince: number | null = null;
  private sources = new Map<string, SourceMode>();
  snapshot = emptyDiagnostics();
  constructor(private now: () => number = () => performance.now(), private onEvent?: (snapshot: DiagnosticsSnapshot) => void) {}
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.generation++;
    this.reset();
    this.sources.clear();
  }
  private reset() {
    this.started = this.now();
    this.lastSample = this.lastStatus = this.loadingSince = null;
    this.track = null;
    this.buffering = false;
    this.snapshot = emptyDiagnostics();
  }
  source(id: string, mode: SourceMode) {
    if (!this.enabled) return;
    if (this.sources.size >= 256) this.sources.delete(this.sources.keys().next().value!);
    this.sources.set(id, mode);
  }
  trackChanged(state: PlayerState): boolean {
    if (!this.enabled) return false;
    const track = state.track?.occurrenceId ?? null;
    if (track === this.track) return false;
    const preparing = this.track === null && track !== null;
    const events = preparing ? this.snapshot.events.filter((event) => event.kind !== "native error") : [];
    const started = this.started;
    this.reset();
    if (preparing) { this.snapshot.events = events; this.started = started; }
    this.track = track;
    this.generation++;
    return true;
  }
  status(status: PlaylistStatus, state: PlayerState, count: number): boolean {
    if (!this.enabled) return false;
    this.trackChanged(state);
    const time = this.now();
    const interval = this.lastStatus === null ? null : time - this.lastStatus;
    this.lastStatus = time;
    if (status.isBuffering && !this.buffering) this.snapshot.bufferingTransitions++;
    this.buffering = status.isBuffering;
    if (state.loading && this.loadingSince === null) this.loadingSince = time;
    if (!state.loading && status.isLoaded && this.loadingSince !== null) {
      this.snapshot.loadLatencyMs = time - this.loadingSince;
      this.loadingSince = null;
    }
    if (status.error && typeof status.error === "object") {
      const error = status.error as { responseCode?: unknown; code?: unknown };
      const event: DiagnosticEvent = { kind: "native error", elapsedSec: (time - this.started) / 1000,
        latencyMs: null, httpStatus: numeric(error.responseCode), nativeCode: numeric(error.code) };
      const previous = this.snapshot.events.at(-1);
      if (!previous || previous.kind !== event.kind || previous.httpStatus !== event.httpStatus || previous.nativeCode !== event.nativeCode) this.event(event);
    }
    if (this.lastSample !== null && time - this.lastSample < 1000) return false;
    this.lastSample = time;
    this.snapshot.source = state.track ? this.sources.get(state.track.id) ?? null : null;
    this.snapshot.samples = [...this.snapshot.samples, {
      elapsedSec: (time - this.started) / 1000, positionSec: status.isLoaded ? measured(status.currentTime) : null,
      durationSec: status.isLoaded && status.duration > 0 ? measured(status.duration) : null, buffering: status.isBuffering,
      loaded: status.isLoaded, loading: state.loading, playing: status.playing,
      queuePreparing: state.queueLoading, queueLoaded: state.queue.length, queueTotal: state.queueTotal,
      nativeTrackCount: count, statusIntervalMs: interval,
    }].slice(-DIAGNOSTICS_SAMPLES);
    return true;
  }
  private event(event: DiagnosticEvent) {
    this.snapshot.events = [...this.snapshot.events, event].slice(-DIAGNOSTICS_EVENTS);
    this.onEvent?.(this.read());
  }
  async request<T>(kind: "queue request" | "queue page", action: () => Promise<T>): Promise<T> {
    if (!this.enabled) return action();
    const generation = this.generation, start = this.now();
    let httpStatus: number | null = null;
    try { return await action(); }
    catch (error) {
      if (error && typeof error === "object" && "status" in error) httpStatus = numeric(error.status);
      throw error;
    } finally {
      if (this.enabled && generation === this.generation) this.event({
        kind, elapsedSec: (this.now() - this.started) / 1000, latencyMs: this.now() - start,
        httpStatus, nativeCode: null,
      });
    }
  }
  read(): DiagnosticsSnapshot {
    return { ...this.snapshot, samples: [...this.snapshot.samples], events: [...this.snapshot.events] };
  }
}
