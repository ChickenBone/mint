import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ModuleKind, transpileModule } from "typescript";
import type { PlaylistPort } from "../src/playback/engine";
import { editUpcoming, queueEntries, shuffleUpcoming } from "../src/playback/queue";
import { activeLyric, parseLyrics } from "../src/playback/lyrics";
import { randomUUID } from "node:crypto";
import { confirmsHandoff, type DeviceState } from "@mint/client";
import { movePlaybackToDevice, startNativeDeviceBridge } from "../src/playback/device-bridge";

const entries = ["a", "b", "c", "d"].map((occurrenceId) => ({ id: "same-song", title: occurrenceId, occurrenceId }));
const receiverId = randomUUID(), songId = randomUUID();
const deviceState = (): DeviceState => ({ playing: true, time: 10, duration: 100, volume: 100, trackId: songId,
  queue: [songId], currentIndex: 0, shuffle: false, repeat: 0 });
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "Expected bridge state before timeout");
}
function bridgeApi() {
  return {
    registerDevice: async () => ({ id: receiverId, token: "receiver-fixture" }),
    pollDevice: async () => ({ command: null }),
    acknowledgeDevice: async () => ({ ok: true as const }),
    disconnectDevice: async () => ({ ok: true as const }),
    handoffDevice: async () => ({ id: randomUUID(), status: "pending" as const, expiresAt: new Date(Date.now() + 1500).toISOString() }),
    deviceCommandStatus: async (id: string) => ({ id, status: "succeeded" as const, expiresAt: new Date(Date.now() + 1000).toISOString() }),
  };
}

test("native chooser can move a paused remote queue onto this player", async () => {
  const local = randomUUID(), remote = randomUUID(), transfer = randomUUID(), pause = randomUUID();
  const calls: string[] = [];
  const rows = [
    { id: local, name: "Phone", kind: "native" as const, online: true, lastSeenAt: "2026-11-05T00:01:00.000Z",
      state: { playing: false, queueLength: 0, volume: 100, trackId: null } },
    { id: remote, name: "Web player", kind: "web" as const, online: true, lastSeenAt: "2026-11-05T00:00:00.000Z",
      state: { playing: false, queueLength: 1, volume: 100, trackId: songId } },
  ];
  const status = (id: string) => ({ id, status: "succeeded" as const, expiresAt: new Date(Date.now() + 1000).toISOString() });
  const api = {
    devices: async () => rows,
    transferDevice: async (id: string) => { calls.push(`transfer:${id}`); return status(transfer); },
    completeDeviceTransfer: async (id: string) => { calls.push(`complete:${id}`); return status(pause); },
    deviceCommandStatus: async (id: string) => { calls.push(`status:${id}`); return status(id); },
  };
  const bridge = { deviceId: local, handoffTo: async (id: string) => { calls.push(`local:${id}`); } };
  await movePlaybackToDevice(local, api, bridge, () => true);
  assert.deepEqual(calls, [`transfer:${local}`, `status:${transfer}`, `complete:${transfer}`, `status:${pause}`]);

  calls.length = 0;
  rows[0]!.state.queueLength = 1;
  rows[1]!.state.queueLength = 0;
  await movePlaybackToDevice(remote, api, bridge, () => true);
  assert.deepEqual(calls, [`local:${remote}`]);

  calls.length = 0;
  await assert.rejects(() => movePlaybackToDevice(remote, api, bridge, () => false), /Account changed/);
  assert.deepEqual(calls, []);
});

test("installed bridge never pauses the source on admission or failed destination confirmation", async () => {
  let acknowledged = false, pauses = 0;
  const api = { ...bridgeApi(), deviceCommandStatus: async (id: string) => ({
    id, status: acknowledged ? "succeeded" as const : "delivered" as const, expiresAt: new Date(Date.now() + 1000).toISOString(),
  }) };
  const bridge = startNativeDeviceBridge({ api, state: deviceState, execute: async (command) => { if (command.action === "pause") pauses++; },
    apply: async () => {}, error: () => {}, pollMs: 50 });
  try {
    await until(() => bridge.deviceId === receiverId);
    const moving = bridge.handoffTo(randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pauses, 0);
    acknowledged = true;
    await moving;
    assert.equal(pauses, 1);
  } finally { bridge.dispose(); }
  const failure = startNativeDeviceBridge({
    api: { ...bridgeApi(), deviceCommandStatus: async (id) => ({ id, status: "failed" as const, error: "Blocked", expiresAt: new Date().toISOString() }) },
    state: deviceState, execute: async () => { pauses++; }, apply: async () => {}, error: () => {},
  });
  try {
    await until(() => failure.deviceId === receiverId);
    await assert.rejects(() => failure.handoffTo(randomUUID()), /Blocked/);
    assert.equal(pauses, 1, "Failed playback moves leave the source unchanged");
  } finally { failure.dispose(); }
});

test("installed bridge negatively acknowledges unconfirmed handoff and rejects replay", async () => {
  let acknowledgments = 0, applies = 0;
  const errors: string[] = [];
  const current = { ...deviceState(), playing: false };
  const handoff = { queue: [songId], currentIndex: 0, position: 10, playing: true, shuffle: false, repeat: 0 as const };
  const command = { id: randomUUID(), deviceId: receiverId, sequence: 1, expiresAt: new Date(Date.now() + 1500).toISOString(),
    command: { action: "handoff" as const, handoff } };
  const bridge = startNativeDeviceBridge({
    api: { ...bridgeApi(), pollDevice: async () => ({ command }), acknowledgeDevice: async (_id, ack) => {
      acknowledgments++; assert.equal(ack.success, false); assert.equal(confirmsHandoff(ack.state, handoff), false); return { ok: true };
    } },
    state: () => current, apply: async () => { applies++; }, execute: async () => {}, error: (value) => { if (value) errors.push(value); }, pollMs: 5,
  });
  try {
    await until(() => errors.some((error) => /repeated/.test(error)));
    assert.equal(applies, 1); assert.equal(acknowledgments, 1);
  } finally { bridge.dispose(); }
});

test("late installed registration after disposal is disconnected rather than left awake", async () => {
  let release!: (value: { id: string; token: string }) => void, disconnected = 0;
  const bridge = startNativeDeviceBridge({
    api: { ...bridgeApi(), registerDevice: () => new Promise((resolve) => { release = resolve; }),
      disconnectDevice: async () => { disconnected++; return { ok: true }; } },
    state: deviceState, execute: async () => {}, apply: async () => {}, error: () => {},
  });
  bridge.dispose();
  release({ id: receiverId, token: "late-fixture" });
  await until(() => disconnected === 1);
  assert.equal(bridge.deviceId, null);
});

test("shuffle keeps current and duplicate song occurrences exactly once", () => {
  const shuffled = shuffleUpcoming(entries, 0, () => 0);
  assert.equal(shuffled[0], entries[0]);
  assert.equal(new Set(shuffled.map((entry) => entry.occurrenceId)).size, 4);
});

test("upcoming edits preserve current object and protect history", () => {
  assert.equal(editUpcoming(entries, 0, "d", "b")[0], entries[0]);
  assert.deepEqual(editUpcoming(entries, 0, "d", "b").map((entry) => entry.occurrenceId), ["a", "d", "b", "c"]);
  assert.throws(() => editUpcoming(entries, 1, "a"), /upcoming/);
  assert.throws(() => editUpcoming(entries, 1, "d", "a"), /upcoming/);
});

test("queue hydration rejects ambiguous duplicate occurrences", () => {
  assert.throws(() => queueEntries({ context: { id: "q", total: 1, revision: 1, position: 0, offset: 0, shuffle: false }, items: [{ id: "a", title: "A" }] }), /identify/);
});

test("lyrics only expose genuine monotonic word timing", () => {
  const lines = parseLyrics("[00:01.00]<00:01.00>Hello <00:01.50>world\n[00:03.00]Plain line");
  assert.equal(lines[0]?.words?.length, 2);
  assert.equal(lines[1]?.words, undefined);
  assert.equal(activeLyric(lines, 500), -1);
  assert.equal(activeLyric(lines, 1200), 0);
  assert.equal(parseLyrics("[00:01.00]<00:01.00>Hello world")[0]?.words, undefined);
  assert.equal(parseLyrics("[00:01.00]<00:02.00>Hello <00:01.50>world")[0]?.words, undefined);
});

test("web adapter preserves paused end seeks but advances an actually playing finished song", async () => {
  let listener: (status: { didJustFinish?: boolean; error?: string }) => void = () => {};
  const audio = {
    currentTime: 0, duration: 45, playing: false, isLoaded: true, isBuffering: false, loop: false,
    pause() { this.playing = false; }, play() { this.playing = true; },
    replace() { this.currentTime = 0; },
    async seekTo(time: number) { this.currentTime = time; if (time === this.duration) listener({ didJustFinish: true }); },
    addListener(_event: string, callback: typeof listener) { listener = callback; return { remove() {} }; },
    setActiveForLockScreen() {}, release() {},
  };
  const exports: { createPlaylist?: () => Promise<{ port: PlaylistPort }> } = {};
  const source = readFileSync(resolve("src/playback/playlist.web.ts"), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, {
    exports, AbortController, Blob, URL, Uint8Array,
    require(name: string) { assert.equal(name, "expo-audio"); return { createAudioPlayer: () => audio }; },
    fetch: async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/wav" } }),
  });
  assert.ok(exports.createPlaylist);
  const { port } = await exports.createPlaylist();
  port.add({ uri: "https://mint.example/one", headers: { Authorization: "fixture" } });
  port.add({ uri: "https://mint.example/two", headers: { Authorization: "fixture" } });
  port.skipTo(0);
  await new Promise((resolve) => setImmediate(resolve));
  port.pause();
  await port.seekTo(45);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.currentIndex, 0);
  assert.equal(port.currentTime, 45);
  assert.equal(port.playing, false);
  port.play();
  listener({ didJustFinish: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.currentIndex, 1);
  assert.equal(port.playing, true);
  port.destroy();
});
