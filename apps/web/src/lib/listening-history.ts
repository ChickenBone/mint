import type { PlayerState } from "./player-protocol";

export class ListeningHistory {
  private last?: { state: PlayerState; at: number };
  private listenedMs = 0;
  private eventId = crypto.randomUUID();
  private startedAt = new Date().toISOString();
  constructor(private send: (event: { eventId: string; trackId: string; listenedMs: number; completed: boolean; startedAt: string }) => void, private now = () => performance.now()) {}
  reset() {
    this.listenedMs = 0; this.eventId = crypto.randomUUID(); this.startedAt = new Date().toISOString();
    if (this.last) this.last.at = this.now();
  }
  update(state: PlayerState) {
    const at = this.now(), last = this.last;
    if (last?.state.track?.queueId !== state.track?.queueId) {
      this.flush();
      this.reset();
    } else if (last?.state.playing) {
      const elapsed = Math.max(0, Math.min(5000, at - last.at));
      const delta = state.time - last.state.time;
      if (delta >= 0 && delta <= elapsed * 3 + 1000) this.listenedMs += Math.min(elapsed, delta);
    }
    this.last = { state, at };
  }
  flush() {
    const state = this.last?.state;
    if (state?.track && this.listenedMs >= 1000) {
      this.send({ eventId: this.eventId, trackId: state.track.id, listenedMs: Math.round(this.listenedMs), startedAt: this.startedAt,
        completed: state.duration > 0 && this.listenedMs >= state.duration * .8 });
    }
    this.reset();
  }
}
