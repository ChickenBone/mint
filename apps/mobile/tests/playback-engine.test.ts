import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ModuleKind, transpileModule } from "typescript";
import { MintApi } from "@mint/client";
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
  lockMetadata: NonNullable<Parameters<PlaylistPort["setActiveForLockScreen"]>[1]>[] = [];
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
  setActiveForLockScreen(active: boolean, metadata?: Parameters<PlaylistPort["setActiveForLockScreen"]>[1]) {
    if (metadata?.artworkUrl) {
      // Model Android's Metadata URL conversion, which has no implicit server origin.
      const artwork = new URL(metadata.artworkUrl);
      assert.ok(["http:", "https:"].includes(artwork.protocol));
      assert.equal(artwork.username, "");
      assert.equal(artwork.password, "");
    }
    if (metadata) this.lockMetadata.push(metadata);
    this.active = active;
  }
  destroy() { this.destroyed = true; }
}

function fixture(total = 401, playlist = new FakePlaylist(), serverUrl = "https://mint.example") {
  const client = new MintApi({ serverUrl, token: `mn1.${"0".repeat(36)}.${"a".repeat(43)}`,
    fetch: async () => { throw new Error("Artwork URL resolution must not fetch or require a connection."); } });
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
    artworkUrl: (path) => client.artworkUrl(path),
    metadata: async (id) => ({ id, title: id }),
  };
  const engine = new PlaybackEngine(playlist, api, storage, "server-a:account-a");
  return { engine, playlist, api, saved, storage, positions };
}

async function nativeFixture(total = 3, serverUrl = "https://mint.example") {
  const bridge = new FakePlaylist();
  const exports: { createPlaylist?: () => Promise<{ port: PlaylistPort }> } = {};
  const source = readFileSync(resolve("src/playback/playlist.native.ts"), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, {
    exports,
    require(name: string) {
      assert.equal(name, "expo-audio");
      return {
        setAudioModeAsync: async () => {},
        createAudioPlaylist: () => bridge,
      };
    },
  });
  assert.ok(exports.createPlaylist);
  const { port } = await exports.createPlaylist();
  assert.equal(port, bridge);
  return fixture(total, bridge, serverUrl);
}

test("native bridge receives absolute public artwork on initial activation, resume and source reload", async () => {
  const { engine, playlist } = await nativeFixture();
  const thumb = "/api/artwork/41de9df5-44a9-4b69-8534-1ae803cea58f";
  assert.throws(() => playlist.setActiveForLockScreen(true, { title: "Reproduce", artworkUrl: thumb }), /Invalid URL/);
  await engine.playTrack({ id: "song", title: "Song", artist: "Artist", album: "Album", thumb });
  await engine.toggle();
  await engine.toggle();
  playlist.currentTime = 19;
  await engine.reloadSources();
  assert.equal(playlist.playing, true);
  assert.equal(playlist.currentTime, 19);
  assert.equal(engine.state.error, null);
  assert.equal(playlist.lockMetadata.length, 3);
  for (const metadata of playlist.lockMetadata) {
    assert.deepEqual(metadata, { title: "Song", artist: "Artist", albumTitle: "Album", artworkUrl: `https://mint.example${thumb}` });
    assert.ok(!("headers" in metadata));
  }
  engine.dispose();
});

test("native collection metadata refreshes resolved artwork and live details on status, next and previous", async () => {
  const { engine, playlist, api } = await nativeFixture();
  const queuePage = api.queuePage;
  api.queuePage = async (id, position, signal) => {
    const page = await queuePage(id, position, signal);
    page.items = page.items.map((item) => ({ ...item, title: `Live ${item.occurrenceId}`,
      artist: "Live artist", album: "Live album", thumb: `/api/artwork/${item.id}` }));
    return page;
  };
  await engine.playCollection({ kind: "library" });
  assert.equal(playlist.lockMetadata.at(-1)?.title, "Live entry-0");
  await engine.next();
  assert.deepEqual(playlist.lockMetadata.at(-1), { title: "Live entry-1", artist: "Live artist",
    albumTitle: "Live album", artworkUrl: "https://mint.example/api/artwork/track-1" });
  await engine.previous();
  assert.equal(playlist.lockMetadata.at(-1)?.title, "Live entry-0");
  playlist.currentIndex = 2;
  engine.onStatus({ currentIndex: 2, currentTime: 0, duration: 90, playing: true, isBuffering: false, isLoaded: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(playlist.lockMetadata.at(-1)?.title, "Live entry-2");
  assert.equal(playlist.lockMetadata.at(-1)?.artworkUrl, "https://mint.example/api/artwork/track-2");
  await engine.reloadSources();
  assert.equal(playlist.lockMetadata.at(-1)?.title, "Live entry-2");
  assert.equal(playlist.lockMetadata.at(-1)?.artworkUrl, "https://mint.example/api/artwork/track-2");
  assert.equal(playlist.playing, true);
  engine.dispose();
});

test("late metadata responses and failures cannot overwrite or stop the newly selected native song", async () => {
  for (const reject of [false, true]) {
    const { engine, playlist, api } = await nativeFixture();
    await engine.playCollection({ kind: "library" });
    const queuePage = api.queuePage;
    let finish: (() => void) | undefined;
    api.queuePage = async (id, position, signal) => {
      if (position === 1) {
        await new Promise<void>((resolve) => { finish = resolve; });
        if (reject) throw Object.assign(new Error("Stale permission failure"), { status: 401 });
      }
      const page = await queuePage(id, position, signal);
      page.items = page.items.map((item) => ({ ...item, title: `${position === 1 ? "Stale" : "Current"} ${item.occurrenceId}`,
        thumb: `/api/artwork/${item.id}` }));
      return page;
    };
    const pending = engine.next();
    await engine.next();
    const metadata = playlist.lockMetadata.at(-1);
    finish!();
    await pending;
    assert.equal(playlist.lockMetadata.at(-1), metadata);
    assert.equal(engine.state.track?.title, "Current entry-2");
    assert.equal(engine.state.error, null);
    assert.equal(playlist.playing, true);
    engine.dispose();
  }
});

test("cold offline queues resolve saved relative artwork against each selected server without network requests", async () => {
  for (const serverUrl of ["https://mint-a.example", "https://mint-b.example"]) {
    const { engine, playlist, api, storage, saved } = await nativeFixture(1, serverUrl);
    const thumb = "/api/artwork/song";
    await engine.playTrack({ id: "song", title: "Saved song", artist: "Saved artist", album: "Saved album", thumb });
    playlist.currentTime = 28;
    engine.persist();
    await new Promise((resolve) => setImmediate(resolve));
    engine.dispose();
    api.source = async () => ({ uri: "file:///app-private/song.audio" });
    api.metadata = async () => { throw Object.assign(new Error("Offline"), { status: 0 }); };
    const port = new FakePlaylist();
    const restored = new PlaybackEngine(port, api, storage, "server-a:account-a");
    await restored.restore();
    assert.equal(port.sources[0]?.uri, "file:///app-private/song.audio");
    assert.equal(port.currentTime, 28);
    assert.equal(port.playing, false);
    assert.deepEqual(port.lockMetadata.at(-1), { title: "Saved song", artist: "Saved artist",
      albumTitle: "Saved album", artworkUrl: `${serverUrl}${thumb}` });
    assert.match(restored.state.error!, /Offline song details/);
    assert.ok(saved.has("server-a:account-a"));
    restored.dispose();
  }
});

test("native metadata omits missing artwork, preserves HTTPS external art and rejects unsafe optional art without stopping audio", async () => {
  const { engine, playlist } = await nativeFixture();
  for (const thumb of [undefined, "", "https://images.example/album.jpg",
    "https://user:secret@images.example/album.jpg", "http://images.example/album.jpg", "file:///private/cover.jpg", "https://["]) {
    await engine.playTrack({ id: "song", title: "Song", artist: "Artist", thumb });
    const metadata = playlist.lockMetadata.at(-1)!;
    if (thumb === "https://images.example/album.jpg") {
      assert.equal(metadata.artworkUrl, thumb);
      assert.equal(engine.state.error, null);
    } else {
      assert.ok(!("artworkUrl" in metadata));
      if (thumb) assert.match(engine.state.error!, /Lock-screen artwork is unavailable/);
      else assert.equal(engine.state.error, null);
    }
    assert.equal(metadata.title, "Song");
    assert.equal(metadata.artist, "Artist");
    assert.equal(playlist.playing, true);
  }
  engine.dispose();
});

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
