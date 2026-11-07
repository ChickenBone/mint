import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  DeviceError, assertCommandClaimable, assertDeviceOnline, assertPartyEditor, assertPartyRevision,
  deviceCommandSchema, deviceStateSchema, handoffSchema, type DeviceCommandEnvelope, type DeviceState,
} from "@mint/core/devices";
import { validDeviceOrigin } from "../src/lib/device-http";
import { playbackSource } from "../src/lib/device-client";
import { chooseAccountPlayback, shownPlaybackSeconds } from "../src/lib/account-playback";
import { startDeviceBridge } from "../src/lib/device-client";

const trackId = randomUUID(), deviceId = randomUUID();
const state = (): DeviceState => ({
  playing: true, time: 12, duration: 180, volume: 70, trackId,
  queue: [trackId], currentIndex: 0, shuffle: false, repeat: 0,
});
const command = (overrides: Partial<DeviceCommandEnvelope> = {}): DeviceCommandEnvelope => ({
  id: randomUUID(), deviceId, sequence: 1, expiresAt: new Date(Date.now() + 10_000).toISOString(),
  command: { action: "pause" }, ...overrides,
});
async function until(predicate: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), "Expected condition before timeout");
}

test("device schemas validate UUIDs, bounded full queues, positions and finite values", () => {
  assert.ok(deviceStateSchema.safeParse(state()).success);
  assert.ok(deviceStateSchema.safeParse({ ...state(), queue: Array(50_000).fill(trackId), currentIndex: 49_999 }).success);
  assert.equal(deviceStateSchema.safeParse({ ...state(), queue: Array(50_001).fill(trackId) }).success, false);
  for (const invalid of [
    { ...state(), time: Infinity }, { ...state(), volume: 101 }, { ...state(), trackId: "foreign-url" },
    { ...state(), currentIndex: 1 }, { ...state(), queue: [randomUUID()] },
  ]) assert.equal(deviceStateSchema.safeParse(invalid).success, false);
  assert.equal(deviceCommandSchema.safeParse({ action: "queue", trackIds: ["https://example.test/a.mp3"], currentIndex: 0 }).success, false);
  assert.equal(handoffSchema.safeParse({ queue: [trackId], currentIndex: 1, position: 0, playing: true, shuffle: false, repeat: 0 }).success, false);
});

test("device/party policy rejects replay, expiration, offline clients, permissions and conflicts", () => {
  assert.throws(() => assertCommandClaimable({ status: "delivered", expiresAt: new Date(Date.now() + 1000) }), DeviceError);
  assert.throws(() => assertCommandClaimable({ status: "pending", expiresAt: new Date(0) }), DeviceError);
  assert.throws(() => assertDeviceOnline({ lastSeenAt: new Date(0), revokedAt: null }), DeviceError);
  assert.throws(() => assertDeviceOnline({ lastSeenAt: new Date(), revokedAt: new Date() }), DeviceError);
  assert.throws(() => assertPartyEditor({ hostId: "host", guestsCanEdit: false }, "guest", true), DeviceError);
  assert.throws(() => assertPartyEditor({ hostId: "host", guestsCanEdit: true }, "outsider", false), DeviceError);
  assert.doesNotThrow(() => assertPartyEditor({ hostId: "host", guestsCanEdit: true }, "guest", true));
  assert.throws(() => assertPartyRevision(2, 1), DeviceError);
});

test("device mutations require exact configured same origin, never forwarded request origins", () => {
  const origin = "https://mint.example.test";
  const tailscale = "http://mint.tailnet.ts.net:3000";
  for (const headers of [{}, { origin: "https://evil.example" }, { origin, "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
    assert.equal(validDeviceOrigin(new Request("https://mint.example.test/api/devices", { headers }), origin), false);
  }
  assert.equal(validDeviceOrigin(new Request(`${origin}/api/devices`, { headers: { origin, "sec-fetch-site": "same-origin" } }), origin), true);
  assert.equal(validDeviceOrigin(new Request(`${tailscale}/api/devices`, { headers: { origin: tailscale, "sec-fetch-site": "same-origin" } }), [origin, tailscale]), true);
  assert.equal(validDeviceOrigin(new Request(`${tailscale}/api/devices`, { headers: { origin: "https://evil.example", "sec-fetch-site": "same-origin" } }), [origin, tailscale]), false);
});

test("playback moves from the device that is playing, otherwise the most recent device with a queue", () => {
  const devices = [
    { id: "laptop", online: true, lastSeenAt: "2026-11-05T00:00:00.000Z", state: { playing: false, queueLength: 4 } },
    { id: "phone", online: true, lastSeenAt: "2026-11-05T00:01:00.000Z", state: { playing: true, queueLength: 4 } },
    { id: "asleep", online: false, lastSeenAt: "2026-11-05T00:02:00.000Z", state: { playing: true, queueLength: 4 } },
  ];
  assert.equal(playbackSource(devices, "laptop")?.id, "phone");
  assert.equal(playbackSource(devices, "phone"), null);
  const paused = devices.map((device) => ({ ...device, state: { ...device.state, playing: false } }));
  assert.equal(playbackSource(paused, "phone")?.id, "laptop");
  assert.equal(playbackSource([{ id: "only", online: true, lastSeenAt: "2026-11-05T00:00:00.000Z", state: { playing: true, queueLength: 1 } }], "only"), null);
});

test("refresh resumes the same device and does not revoke it", async () => {
  const storage = new Map<string, string>();
  const memory = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  let registers = 0, resumes = 0, revokes = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path === "/api/devices") { registers++; return Response.json({ id: deviceId, token: "secret" }); }
    if (path.endsWith("/resume")) { resumes++; return Response.json({ id: deviceId, token: "rotated" }); }
    if (path.endsWith("/revoke")) { revokes++; return Response.json({ ok: true }); }
    return Response.json({ command: null });
  };
  const first = startDeviceBridge({
    memberId: "persistent", name: "Computer", getState: state, pollMs: 50, error: () => {}, storage: memory,
    execute: async () => {}, applyHandoff: async () => {}, fetcher,
  });
  try {
    await until(() => first.deviceId === deviceId);
    assert.equal(registers, 1);
    assert.equal(storage.get("mint:device:persistent"), deviceId);
  } finally { first.dispose(); }
  assert.equal(revokes, 0);
  const second = startDeviceBridge({
    memberId: "persistent", name: "Computer", getState: state, pollMs: 50, error: () => {}, storage: memory,
    execute: async () => {}, applyHandoff: async () => {}, fetcher,
  });
  try {
    await until(() => second.deviceId === deviceId);
    assert.equal(registers, 1);
    assert.equal(resumes, 1);
  } finally { second.dispose(); }
});

test("bridge executes a delivered command at most once and strips unchanged heartbeat queues", async () => {
  const envelope = command(), errors: string[] = [], polls: Record<string, unknown>[] = [];
  let executions = 0, acknowledgments = 0, current = state();
  const bridge = startDeviceBridge({
    memberId: "test", name: "Test", getState: () => current, pollMs: 5, error: (error) => errors.push(error),
    execute: async () => { executions++; current = { ...current, playing: false }; }, applyHandoff: async () => {},
    fetcher: async (url, init) => {
      const path = String(url), input = init?.body ? JSON.parse(String(init.body)) : null;
      if (path === "/api/devices") return Response.json({ id: deviceId, token: "secret" });
      if (path.endsWith("/poll")) { polls.push(input.state); return Response.json({ command: envelope }); }
      if (path.endsWith("/ack")) { acknowledgments++; assert.equal(input.success, true); return Response.json({ ok: true }); }
      return Response.json({ ok: true });
    },
  });
  try {
    await until(() => errors.length > 0);
    assert.equal(executions, 1); assert.equal(acknowledgments, 1);
    assert.match(errors[0]!, /repeated/);
    assert.ok(Array.isArray(polls[0]!.queue));
    assert.equal("queue" in polls[1]!, false);
  } finally { bridge.dispose(); }
});

test("bridge refuses wrong-device and expired envelopes before executing", async () => {
  for (const envelope of [command({ deviceId: randomUUID() }), command({ expiresAt: new Date(0).toISOString() })]) {
    let executions = 0;
    const errors: string[] = [];
    const bridge = startDeviceBridge({
      memberId: "test", getState: state, pollMs: 5, error: (error) => errors.push(error),
      execute: async () => { executions++; }, applyHandoff: async () => { executions++; },
      fetcher: async (url) => Response.json(String(url) === "/api/devices" ? { id: deviceId, token: "secret" } : { command: envelope }),
    });
    try { await until(() => errors.length > 0); assert.equal(executions, 0); }
    finally { bridge.dispose(); }
  }
});

test("handoff admission never pauses the source; only successful destination acknowledgment does", async () => {
  let confirmed = false, admitted = false, sourcePauses = 0;
  const bridge = startDeviceBridge({
    memberId: "test", getState: state, pollMs: 50, error: () => {},
    execute: async (action) => { if (action.action === "pause") sourcePauses++; }, applyHandoff: async () => {},
    fetcher: async (url) => {
      const path = String(url);
      if (path === "/api/devices") return Response.json({ id: deviceId, token: "secret" });
      if (path.endsWith("/commands/handoff")) return Response.json({ status: confirmed ? "succeeded" : "delivered" });
      if (path.endsWith("/handoff")) { admitted = true; return Response.json({ id: "handoff", expiresAt: new Date(Date.now() + 3000).toISOString() }); }
      return Response.json({ command: null });
    },
  });
  try {
    await until(() => bridge.deviceId !== null);
    const moving = bridge.handoffTo(randomUUID());
    await until(() => admitted);
    assert.equal(sourcePauses, 0);
    confirmed = true;
    await moving;
    assert.equal(sourcePauses, 1);
  } finally { bridge.dispose(); }
});

test("blocked destination playback is negatively acknowledged and source playback continues", async () => {
  let ack: { success: boolean; error?: string } | null = null;
  const envelope = command({ command: { action: "handoff", handoff: {
    queue: [trackId], currentIndex: 0, position: 12, playing: true, shuffle: false, repeat: 0,
  } } });
  const bridge = startDeviceBridge({
    memberId: "test", getState: () => ({ ...state(), playing: false }), pollMs: 50, error: () => {},
    execute: async () => {}, applyHandoff: async () => { throw new Error("Autoplay blocked. Press Play on this device."); },
    fetcher: async (url, init) => {
      const path = String(url);
      if (path === "/api/devices") return Response.json({ id: deviceId, token: "secret" });
      if (path.endsWith("/ack")) { ack = JSON.parse(String(init?.body)); return Response.json({ ok: true }); }
      return Response.json({ command: envelope });
    },
  });
  try {
    await until(() => ack !== null);
    assert.equal(ack!.success, false);
    assert.match(ack!.error!, /Autoplay blocked/);
  } finally { bridge.dispose(); }

  let paused = false;
  const source = startDeviceBridge({
    memberId: "test", getState: state, pollMs: 50, error: () => {}, execute: async () => { paused = true; }, applyHandoff: async () => {},
    fetcher: async (url) => {
      const path = String(url);
      if (path === "/api/devices") return Response.json({ id: deviceId, token: "secret" });
      if (path.endsWith("/handoff")) return Response.json({ id: "failed", expiresAt: new Date(Date.now() + 2000).toISOString() });
      if (path.endsWith("/commands/failed")) return Response.json({ status: "failed", error: "Autoplay blocked" });
      return Response.json({ command: null });
    },
  });
  try {
    await until(() => source.deviceId !== null);
    await assert.rejects(() => source.handoffTo(randomUUID()), /Autoplay blocked/);
    assert.equal(paused, false);
  } finally { source.dispose(); }
});

test("account playback follows the playing device and holds a scrub", () => {
  const local = { id: "local", online: true, lastSeenAt: "2026-11-06T00:00:02.000Z", state: { playing: false, trackId: "song-a" } };
  const phone = { id: "phone", online: true, lastSeenAt: "2026-11-06T00:00:03.000Z", state: { playing: true, trackId: "song-b" } };
  const idle = { id: "idle", online: true, lastSeenAt: "2026-11-06T00:00:04.000Z", state: { playing: false, trackId: "song-c" } };
  assert.equal(chooseAccountPlayback([local, phone, idle], "local", true)?.id, undefined);
  assert.equal(chooseAccountPlayback([local, phone, idle], "local", false)?.id, "phone");
  assert.equal(chooseAccountPlayback([local, phone, idle], "local", false, "phone")?.id, "phone");
  assert.equal(chooseAccountPlayback([local, idle], "local", false)?.id, undefined, "A paused device does not replace this tab");
  assert.equal(chooseAccountPlayback([local, idle], "local", false, "idle")?.id, "idle", "The device that was playing stays after it pauses");
  assert.equal(chooseAccountPlayback([idle], "local", false)?.id, undefined);
  assert.equal(chooseAccountPlayback([{ ...phone, online: false }], "local", false, "phone")?.id, undefined);
  const started = Date.parse("2026-11-06T00:00:00.000Z");
  assert.equal(shownPlaybackSeconds({ time: 10, duration: 30, playing: true, scrubbing: false, reportedAt: started }, started + 2500), 12.5);
  assert.equal(shownPlaybackSeconds({ time: 10, duration: 30, playing: true, scrubbing: true, reportedAt: started }, started + 2500), 10);
  assert.equal(shownPlaybackSeconds({ time: 10, duration: 30, playing: false, scrubbing: false, reportedAt: started }, started + 2500), 10);
  assert.equal(shownPlaybackSeconds({ time: 29, duration: 30, playing: true, scrubbing: false, reportedAt: started }, started + 5000), 30);
});

test("handoff callback admission without matching playing state cannot acknowledge success", async () => {
  let acknowledged: boolean | undefined;
  const envelope = command({ command: { action: "handoff", handoff: {
    queue: [trackId], currentIndex: 0, position: 12, playing: true, shuffle: false, repeat: 0,
  } } });
  const bridge = startDeviceBridge({
    memberId: "test", getState: () => ({ ...state(), playing: false }), pollMs: 50, error: () => {},
    execute: async () => {}, applyHandoff: async () => {},
    fetcher: async (url, init) => {
      if (String(url) === "/api/devices") return Response.json({ id: deviceId, token: "secret" });
      if (String(url).endsWith("/ack")) { acknowledged = JSON.parse(String(init?.body)).success; return Response.json({ ok: true }); }
      return Response.json({ command: envelope });
    },
  });
  try { await until(() => acknowledged !== undefined); assert.equal(acknowledged, false); }
  finally { bridge.dispose(); }
});
