import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackEngine, type MediaSource, type PlaybackApi, type PlaylistPort, type QueueStorage } from "../src/playback/engine";
import type { QueuePage } from "../src/playback/types";

class FakePlaylist implements PlaylistPort {
  currentIndex = 0;
  currentTime = 0;
  playing = false;
  sources: MediaSource[] = [];
  loop: "none" | "single" | "all" = "none";
  clears = 0;
  destroyed = false;
  active = false;
  get trackCount() { return this.sources.length; }
  add(source: MediaSource) { this.sources.push(source); }
  remove(index: number) { assert.ok(index > this.currentIndex, "must not remove the current native item"); this.sources.splice(index, 1); }
  clear() { this.clears++; this.sources = []; this.currentIndex = 0; }
  play() { this.playing = true; }
  pause() { this.playing = false; }
  next() { if (this.currentIndex + 1 < this.sources.length) this.currentIndex++; else if (this.loop === "all") this.currentIndex = 0; }
  previous() { if (this.currentIndex > 0) this.currentIndex--; else if (this.loop === "all") this.currentIndex = this.sources.length - 1; }
  skipTo(index: number) { this.currentIndex = index; }
  async seekTo(time: number) { this.currentTime = time; }
  setActiveForLockScreen(active: boolean) { this.active = active; }
  destroy() { this.destroyed = true; }
}

function fixture(total = 401) {
  const playlist = new FakePlaylist();
  const saved = new Map<string, string>();
  const storage: QueueStorage = {
    getItem: async (key) => saved.get(key) ?? null,
    setItem: async (key, value) => { saved.set(key, value); },
    removeItem: async (key) => { saved.delete(key); },
  };
  const page = (position: number): QueuePage => {
    const offset = Math.max(0, position - 20);
    return { context: { id: "frozen-queue", total, position, offset, revision: 1, shuffle: false },
      items: Array.from({ length: Math.min(100, total - offset) }, (_, index) => ({
        id: `track-${(index + offset) % 7}`, title: `Song ${index + offset}`, occurrenceId: `entry-${index + offset}`,
      })) };
  };
  const positions: number[] = [];
  const api: PlaybackApi = {
    openQueue: async () => page(0),
    queuePage: async (_id, position) => { positions.push(position); return page(position); },
    source: async (track) => ({ uri: `https://mint.example/api/native/player/audio/${track.id}`, headers: { Authorization: "Bearer fixture-only" } }),
    validate: async () => {},
    metadata: async (id) => ({ id, title: id }),
  };
  const engine = new PlaybackEngine(playlist, api, storage, "server-a:account-a");
  return { engine, playlist, api, saved, storage, positions };
}

test("full frozen collection loads progressively with unique duplicate occurrences and authenticated native sources", async () => {
  const { engine, playlist, positions } = fixture(1001);
  await engine.playCollection({ kind: "library" });
  assert.equal(playlist.sources.length, 1001);
  assert.ok(positions.length > 1);
  assert.equal(engine.state.queue.length, 100);
  assert.equal(engine.state.track?.title, "Song 0");
  assert.equal(engine.state.queueLoading, false);
  assert.equal(engine.state.queueTotal, 1001);
  assert.equal(playlist.playing, true);
  assert.ok(playlist.sources.every((source) => source.headers?.Authorization === "Bearer fixture-only"));
  engine.dispose();
});

test("remove, move, clear and shuffle upcoming never replace current native item or seek", async () => {
  const { engine, playlist } = fixture(8);
  await engine.playCollection({ kind: "library" });
  playlist.currentTime = 37;
  const current = playlist.sources[0], clears = playlist.clears;
  await engine.moveInQueue("entry-7", "entry-1");
  await engine.removeFromQueue("entry-2");
  await engine.setShuffle(true);
  assert.equal(playlist.sources[0], current);
  assert.equal(playlist.currentTime, 37);
  assert.equal(playlist.clears, clears);
  assert.equal(playlist.playing, true);
  await engine.clearUpcoming();
  assert.equal(playlist.sources.length, 1);
  assert.equal(playlist.sources[0], current);
  await assert.rejects(engine.removeFromQueue("entry-0"), /upcoming/);
  engine.dispose();
});

test("restoration is paused, preserves exact seek/repeat, validates membership and isolates storage keys", async () => {
  const { engine, playlist, saved, api, storage } = fixture(4);
  await engine.playCollection({ kind: "library" });
  playlist.currentIndex = 2; playlist.currentTime = 28;
  engine.setRepeat("all");
  engine.persist();
  await new Promise((resolve) => setImmediate(resolve));
  engine.dispose();
  saved.set("server-b:account-a", "unrelated account queue");
  const port = new FakePlaylist();
  let validations = 0;
  const restored = new PlaybackEngine(port, { ...api, validate: async () => { validations++; } }, storage, "server-a:account-a");
  await restored.restore();
  assert.equal(validations, 1);
  assert.equal(port.currentIndex, 2);
  assert.equal(port.currentTime, 28);
  assert.equal(port.playing, false);
  assert.equal(port.loop, "all");
  await restored.revoke();
  assert.equal(port.destroyed, true);
  assert.equal(saved.has("server-a:account-a"), false);
  assert.equal(saved.get("server-b:account-a"), "unrelated account queue");
});

test("a stale queue open cannot replace a newer chosen track", async () => {
  const { engine, api } = fixture(3);
  const old = api.openQueue;
  let finish: (() => void) | undefined;
  api.openQueue = async (input, signal) => {
    await new Promise<void>((resolve) => { finish = resolve; });
    return old(input, signal);
  };
  const opening = engine.playCollection({ kind: "library" });
  await engine.playTrack({ id: "new-song", title: "New song" });
  finish!();
  await opening;
  assert.equal(engine.state.track?.id, "new-song");
  assert.equal(engine.state.queueTotal, 1);
  engine.dispose();
});

test("repeat-all previous wraps and previous after three seconds restarts", async () => {
  const { engine, playlist } = fixture(3);
  await engine.playCollection({ kind: "library" });
  engine.setRepeat("all");
  await engine.previous();
  assert.equal(playlist.currentIndex, 2);
  playlist.currentTime = 4;
  await engine.previous();
  assert.equal(playlist.currentTime, 0);
  assert.equal(playlist.currentIndex, 2);
  engine.dispose();
});

test("native errors stop playback and leave an explicit retryable state", async () => {
  const { engine, playlist } = fixture(2);
  await engine.playCollection({ kind: "library" });
  engine.onStatus({ currentIndex: 0, currentTime: 0, duration: 0, playing: false, isBuffering: false, isLoaded: false, error: { message: "Unauthorized", code: 401 } });
  assert.equal(playlist.playing, false);
  assert.match(engine.state.error!, /Unauthorized/);
  engine.dispose();
});

test("native media errors confirm session validity through the authenticated API cleanup path", async () => {
  const { engine, playlist, api, saved } = fixture(2);
  await engine.playCollection({ kind: "library" });
  await new Promise((resolve) => setImmediate(resolve));
  let validations = 0;
  api.validate = async () => {
    validations++;
    // Models MintApi's confirmed-401 callback, not a blanket media-error logout.
    await engine.revoke();
  };
  engine.onStatus({ currentIndex: 0, currentTime: 0, duration: 0, playing: false, isBuffering: false, isLoaded: false, error: { message: "Unauthorized", code: 401 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(validations, 1);
  assert.equal(playlist.destroyed, true);
  assert.equal(saved.has("server-a:account-a"), false);
});

test("a media network error does not revoke the account without a confirmed session failure", async () => {
  const { engine, playlist, api } = fixture(2);
  await engine.playCollection({ kind: "library" });
  api.validate = async () => { throw Object.assign(new Error("Disconnected"), { status: 0 }); };
  engine.onStatus({ currentIndex: 0, currentTime: 0, duration: 0, playing: false, isBuffering: false, isLoaded: false, error: { message: "Network error" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(playlist.destroyed, false);
  assert.match(engine.state.error!, /Network error/);
  engine.dispose();
});

test("stale single-track validation cannot overwrite a newer chosen song", async () => {
  const { engine, api } = fixture(2);
  let finish: (() => void) | undefined, requests = 0;
  api.validate = async () => {
    if (++requests === 1) await new Promise<void>((resolve) => { finish = resolve; });
  };
  const old = engine.playTrack({ id: "old-song", title: "Old song" });
  await engine.playTrack({ id: "new-song", title: "New song" });
  finish!();
  await old;
  assert.equal(engine.state.track?.id, "new-song");
  engine.dispose();
});

test("overlapping upcoming edits reject explicitly rather than silently losing a successful edit", async () => {
  const { engine, playlist } = fixture(5);
  await engine.playCollection({ kind: "library" });
  const first = engine.removeFromQueue("entry-1");
  await assert.rejects(engine.removeFromQueue("entry-2"), /still finishing/);
  await first;
  assert.ok(!engine.state.queue.some((entry) => entry.occurrenceId === "entry-1"));
  assert.equal(playlist.playing, true);
  await engine.removeFromQueue("entry-2");
  assert.ok(!engine.state.queue.some((entry) => entry.occurrenceId === "entry-2"));
  engine.dispose();
});

test("offline metadata failure does not lose paused restored position", async () => {
  const { engine, playlist, saved, api, storage } = fixture(4);
  await engine.playCollection({ kind: "library" });
  playlist.currentIndex = 2; playlist.currentTime = 28;
  engine.persist();
  await new Promise((resolve) => setImmediate(resolve));
  engine.dispose();
  api.queuePage = async () => { throw Object.assign(new Error("Offline"), { status: 0 }); };
  const port = new FakePlaylist();
  const restored = new PlaybackEngine(port, api, storage, "server-a:account-a");
  await restored.restore();
  assert.equal(port.currentTime, 28);
  assert.equal(port.playing, false);
  assert.match(restored.state.error!, /Offline song details/);
  assert.ok(saved.has("server-a:account-a"));
  restored.dispose();
});

test("restoring shuffle retains the unshuffled upcoming order", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const { engine, playlist, api, storage } = fixture(4);
  await engine.playCollection({ kind: "library" });
  await engine.setShuffle(true);
  await new Promise((resolve) => setImmediate(resolve));
  engine.dispose();
  const port = new FakePlaylist();
  const restored = new PlaybackEngine(port, api, storage, "server-a:account-a");
  await restored.restore();
  assert.equal(restored.state.shuffle, true);
  await restored.setShuffle(false);
  assert.deepEqual(restored.state.queue.map((entry) => entry.occurrenceId), ["entry-1", "entry-2", "entry-3"]);
  assert.equal(port.playing, false);
  assert.equal(playlist.destroyed, true);
  restored.dispose();
});

test("removing a shuffled occurrence saves the original remaining order without a later status tick", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const { engine, api, storage } = fixture(5);
  await engine.playCollection({ kind: "library" });
  await engine.setShuffle(true);
  await engine.removeFromQueue("entry-2");
  await new Promise((resolve) => setImmediate(resolve));
  engine.dispose();
  const restored = new PlaybackEngine(new FakePlaylist(), api, storage, "server-a:account-a");
  await restored.restore();
  await restored.setShuffle(false);
  assert.deepEqual(restored.state.queue.map((entry) => entry.occurrenceId), ["entry-1", "entry-3", "entry-4"]);
  restored.dispose();
});
