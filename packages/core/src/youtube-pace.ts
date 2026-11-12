export interface YoutubeTurn {
  /** Ends the turn. Unused turns (for example, nothing was claimed) do not start the gap. */
  release(used?: boolean): void;
}

interface YoutubeTurnsOptions {
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
});

/**
 * Runs YouTube imports one at a time in this process, in arrival order, and leaves a jittered pause
 * after each used turn so consecutive imports do not trip YouTube rate limits or Mint's provider cooldowns.
 */
export class YoutubeTurns {
  private tail: Promise<void> = Promise.resolve();
  private lastEnded = 0;
  private waiting = 0;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly gapMs: number, options: YoutubeTurnsOptions = {}) {
    if (!Number.isFinite(gapMs) || gapMs < 0) throw new Error("The YouTube import gap must be zero or more milliseconds.");
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** True when a new turn would have to wait for another import or the pause after it. */
  get busy() {
    return this.waiting > 0 || (this.lastEnded > 0 && this.now() < this.lastEnded + this.gapMs * 1.2);
  }

  async take(signal?: AbortSignal): Promise<YoutubeTurn> {
    const previous = this.tail;
    let open!: () => void;
    this.tail = new Promise<void>((resolve) => { open = resolve; });
    this.waiting++;
    try {
      signal?.throwIfAborted();
      await (signal ? Promise.race([previous, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]) : previous);
      signal?.throwIfAborted();
      const wait = this.lastEnded ? this.lastEnded + this.gapMs * (0.8 + this.random() * 0.4) - this.now() : 0;
      if (wait > 0) await this.sleep(wait, signal);
      signal?.throwIfAborted();
    } catch (error) {
      // Later callers still queue behind whoever was ahead of this abandoned turn.
      void previous.then(open);
      throw error;
    } finally {
      this.waiting--;
    }
    let done = false;
    return {
      release: (used = true) => {
        if (done) return;
        done = true;
        if (used) this.lastEnded = this.now();
        open();
      },
    };
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const turn = await this.take(signal);
    try {
      return await work();
    } finally {
      turn.release();
    }
  }
}

/** Parses a gap in seconds (0–600) from configuration, falling back on missing or invalid values. */
export function youtubeGapMs(value: string | undefined, fallbackSeconds: number) {
  const seconds = value === undefined || value.trim() === "" ? fallbackSeconds : Number(value);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 600 ? seconds * 1000 : fallbackSeconds * 1000;
}
