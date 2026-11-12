import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ModuleKind, transpileModule } from "typescript";
import { MintApi } from "@mint/client";
import { randomUUID } from "node:crypto";
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
  const createPlaylist = loadNativePlaylist({ createAudioPlaylist: () => bridge });
  const { port } = await createPlaylist();
  assert.equal(port, bridge);
  return fixture(total, bridge, serverUrl);
}

function loadNativePlaylist(audio: { createAudioPlaylist: () => unknown; setAudioModeAsync?: () => Promise<void> },
  environment = "standalone", os = "android") {
  const exports: { createPlaylist?: () => Promise<{ port: PlaylistPort }> } = {};
  const source = readFileSync(resolve("src/playback/playlist.native.ts"), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  runInNewContext(compiled, {
    exports,
    require(name: string) {
      if (name === "expo-audio") return { setAudioModeAsync: async () => {}, ...audio };
      if (name === "expo-constants") {
        return { __esModule: true, default: { executionEnvironment: environment },
          ExecutionEnvironment: { Bare: "bare", Standalone: "standalone", StoreClient: "storeClient" } };
      }
      assert.equal(name, "react-native");
      return { Platform: { OS: os } };
    },
  });
  assert.ok(exports.createPlaylist);
  return exports.createPlaylist;
}

test("native handoff preserves duplicate occurrences and waits for real audio status", async () => {
  const { engine, playlist } = fixture();
  const id = randomUUID();
  const target = { queue: [id, id], currentIndex: 1, position: 12, playing: true, shuffle: false, repeat: 2 as const };
  const controller = new AbortController();
  let complete = false;
  const move = engine.applyDeviceHandoff(target, controller.signal).then(() => { complete = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(complete, false, "Calling play alone cannot acknowledge a handoff");
  assert.equal(playlist.sources.length, 2);
  assert.equal(playlist.currentIndex, 1);
  engine.onStatus({ currentIndex: 1, currentTime: 12, duration: 180, playing: true, isLoaded: true, isBuffering: false });
  await move;
  const state = engine.getDeviceState();
  assert.equal(state.playing, true);
  assert.deepEqual(state.queue, [id, id]);
  assert.equal(state.currentIndex, 1);
  assert.equal(state.repeat, 2);
  engine.dispose();
});

test("expired native handoff cannot play late or replace a newly selected local track", async () => {
  const { engine, playlist, api } = fixture();
  const id = randomUUID(), chosen = randomUUID();
  let release!: () => void;
  api.metadata = async (track) => { await new Promise<void>((resolve) => { release = resolve; }); return { id: track, title: "Remote" }; };
  const controller = new AbortController();
  const moving = engine.applyDeviceHandoff({ queue: [id], currentIndex: 0, position: 4, playing: true, shuffle: false, repeat: 0 }, controller.signal);
  const rejected = assert.rejects(moving);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await engine.playTrack({ id: chosen, title: "Local choice" });
  controller.abort();
  release();
  await rejected;
  assert.equal(engine.state.track?.id, chosen);
  assert.equal(playlist.playing, true, "Expiring an old handoff cannot pause the newer local selection");
  engine.dispose();
});

test("native progressive handoff retains the full frozen selection while reporting a bounded window", async () => {
  const { engine, api, playlist } = fixture();
  const contextId = randomUUID(), trackId = randomUUID();
  const items = Array.from({ length: 121 }, () => ({ id: trackId, title: "Duplicate song", occurrenceId: randomUUID() }));
  api.queuePage = async (_id, position) => {
    const offset = Math.max(0, position - 20);
    return { context: { id: contextId, total: 121, position, offset, revision: 2, shuffle: false }, items: items.slice(offset, offset + 100) };
  };
  const controller = new AbortController();
  await engine.applyDeviceHandoff({
    queue: items.slice(100).map((item) => item.id), currentIndex: 20, position: 25, playing: false, shuffle: false, repeat: 0,
    queueContext: { id: contextId, total: 121, position: 120, offset: 100, revision: 2, shuffle: false },
  }, controller.signal);
  const state = engine.getDeviceState();
  assert.equal(playlist.sources.length, 121);
  assert.equal(playlist.currentIndex, 120);
  assert.equal(state.queueContext?.total, 121);
  assert.equal(state.queueContext?.position, 120);
  assert.equal(state.queue.length, 21);
  assert.equal(new Set(state.queueEntryIds).size, 21);
  assert.equal(state.playing, false);
  assert.equal(playlist.currentTime, 25);
  engine.dispose();
});

test("Expo Go on Android rejects playback before any native audio call", async () => {
  const calls: string[] = [];
  const createPlaylist = loadNativePlaylist({
    setAudioModeAsync: async () => { calls.push("mode"); },
    createAudioPlaylist: () => { calls.push("playlist"); return new FakePlaylist(); },
  }, "storeClient");
  await assert.rejects(createPlaylist(), /Expo Go can't play Mint songs on Android\. Install the Mint APK/);
  assert.deepEqual(calls, []);
});

test("built Android and iOS Expo Go builds still create the native playlist", async () => {
  for (const [environment, os] of [["standalone", "android"], ["bare", "android"], ["storeClient", "ios"]]) {
    const calls: string[] = [];
    const bridge = new FakePlaylist();
    const createPlaylist = loadNativePlaylist({
      setAudioModeAsync: async () => { calls.push("mode"); },
      createAudioPlaylist: () => { calls.push("playlist"); return bridge; },
    }, environment, os);
    const { port } = await createPlaylist();
    assert.equal(port, bridge);
    assert.deepEqual(calls, ["mode", "playlist"]);
  }
});

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

test("restored saved queue with a relative thumb reaches the native bridge as absolute artwork on resume", async () => {
  const { engine, storage } = await nativeFixture();
  const thumb = "/api/artwork/41de9df5-44a9-4b69-8534-1ae803cea58f";
  await engine.playTrack({ id: "song", title: "Song", artist: "Artist", album: "Album", thumb });
  engine.persist();
  await new Promise((resolve) => setTimeout(resolve, 20));
  engine.dispose();
  assert.ok((await storage.getItem("server-a:account-a"))?.includes(`"thumb":"${thumb}"`), "snapshot keeps the relative thumb");
  const bridge = new FakePlaylist();
  const client = new MintApi({ serverUrl: "https://mint.example", token: `mn1.${"0".repeat(36)}.${"a".repeat(43)}`,
    fetch: async () => { throw new Error("Artwork URL resolution must not fetch."); } });
  const restored = new PlaybackEngine(bridge, {
    openQueue: async () => { throw new Error("Restore must not reopen the queue."); },
    queuePage: async () => { throw new Error("Restore must not page a single-track queue."); },
    source: async (track) => ({ uri: `https://mint.example/api/native/player/audio/${track.id}`, headers: { Authorization: "******" } }),
    validate: async () => {},
    artworkUrl: (path) => client.artworkUrl(path),
    metadata: async (id) => ({ id, title: "Song", artist: "Artist", album: "Album", thumb }),
  }, storage, "server-a:account-a");
  await restored.restore();
  await restored.toggle();
  assert.equal(restored.state.error, null);
  assert.ok(bridge.lockMetadata.length >= 2);
  for (const metadata of bridge.lockMetadata) assert.equal(metadata.artworkUrl, `https://mint.example${thumb}`);
  restored.dispose();
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

test("the installed header-only APK exposes its existing numeric native error code through an OTA", async () => {
  const { engine } = fixture(1);
  await engine.playTrack({ id: "song", title: "Song" });
  engine.onStatus({ currentIndex: 0, currentTime: 0, duration: 0, playing: false,
    isBuffering: false, isLoaded: false, error: { message: "Source error", code: 2004 } });
  assert.match(engine.state.error!, /Source error \(Native code 2004\)/);
  assert.equal(engine.state.loading, false);
  engine.dispose();
});

test("empty native playlist startup statuses cannot start an audio load timeout before a song is selected", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { engine, playlist } = fixture(1);
  for (const isBuffering of [true, false]) {
    engine.onStatus({ currentIndex: 0, currentTime: 0, duration: 0, playing: false, isBuffering, isLoaded: false });
    t.mock.timers.tick(60_000);
    assert.equal(engine.state.loading, false);
    assert.equal(engine.state.error, null);
    assert.equal(playlist.playing, false);
  }
  engine.dispose();
});

test("native source errors retain HTTP diagnostics and cannot be turned back into loading by pause or late status events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { engine, playlist } = fixture(2);
  await engine.playCollection({ kind: "library" });
  const idle = { currentIndex: 0, currentTime: 0, duration: 0, playing: false, isBuffering: false, isLoaded: false };
  engine.onStatus({ ...idle, isBuffering: true });
  const pause = playlist.pause.bind(playlist);
  playlist.pause = () => { pause(); engine.onStatus(idle); };
  engine.onStatus({ ...idle, error: { message: "Source error", code: 2004,
    codeName: "ERROR_CODE_IO_BAD_HTTP_STATUS", responseCode: 401 } });
  const error = engine.state.error;
  assert.match(error!, /ERROR_CODE_IO_BAD_HTTP_STATUS, HTTP 401/);
  engine.onStatus(idle);
  engine.onStatus({ ...idle, playing: true, isLoaded: true });
  t.mock.timers.tick(60_000);
  assert.equal(engine.state.error, error);
  assert.equal(engine.state.loading, false);
  assert.equal(engine.state.playing, false);
  await engine.toggle();
  engine.onStatus({ ...idle, playing: true, isLoaded: true, duration: 90 });
  assert.equal(engine.state.error, null);
  assert.equal(engine.state.playing, true);
  assert.equal(playlist.clears, 2, "retry replaces the failed native sources");
  engine.dispose();
});

test("a load timeout stays failed until explicit retry rather than rearming on native idle updates", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { engine, playlist } = fixture(1);
  return engine.playTrack({ id: "song", title: "Song" }).then(async () => {
    const idle = { currentIndex: 0, currentTime: 0, duration: 0, playing: false, isBuffering: false, isLoaded: false };
    engine.onStatus(idle);
    t.mock.timers.tick(30_000);
    assert.match(engine.state.error!, /could not load in 30 seconds/);
    engine.onStatus(idle);
    assert.equal(engine.state.loading, false);
    assert.equal(playlist.playing, false);
    await engine.reloadSources();
    engine.onStatus({ ...idle, isBuffering: true });
    assert.equal(engine.state.error, null);
    assert.equal(engine.state.loading, true);
    engine.dispose();
  });
});

test("next and previous rebuild failed sources before selecting another occurrence", async () => {
  for (const direction of ["next", "previous"] as const) {
    const { engine, playlist } = fixture(3);
    await engine.playCollection({ kind: "library" });
    playlist.currentIndex = 1;
    engine.onStatus({ currentIndex: 1, currentTime: 0, duration: 0, playing: false,
      isBuffering: false, isLoaded: false, error: { message: "Source error", code: 2004 } });
    await engine[direction]();
    assert.equal(playlist.clears, 2);
    assert.equal(playlist.currentIndex, direction === "next" ? 2 : 0);
    assert.equal(engine.state.error, null);
    engine.dispose();
  }
});

test("a retry navigation cannot advance a new song selected while failed sources are rebuilding", async () => {
  for (const direction of ["next", "previous", "toggle"] as const) {
    const { engine, playlist, api } = fixture(3);
    await engine.playCollection({ kind: "library" });
    engine.onStatus({ currentIndex: 0, currentTime: 0, duration: 0, playing: false,
      isBuffering: false, isLoaded: false, error: { message: "Source error" } });
    const source = api.source;
    let finish: (() => void) | undefined, calls = 0;
    api.source = async (track) => {
      if (++calls === 1) await new Promise<void>((resolve) => { finish = resolve; });
      return source(track);
    };
    const retrying = engine[direction]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(finish, "retry has started rebuilding its failed source");
    await engine.playTrack({ id: "new-song", title: "New song" });
    const metadata = playlist.lockMetadata.at(-1);
    finish!();
    await retrying;
    assert.equal(engine.state.track?.id, "new-song");
    assert.equal(playlist.currentIndex, 0);
    assert.equal(playlist.lockMetadata.at(-1), metadata);
    engine.dispose();
  }
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
