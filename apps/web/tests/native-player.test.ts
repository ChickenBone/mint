import assert from "node:assert/strict";
import test from "node:test";
import { BrowserDSP } from "../src/lib/browser-dsp";
import { loadCollection, shuffled } from "../src/lib/browser-catalog";
import { NativePlayer } from "../src/lib/native-player";
import { defaultDsp, playerStateSchema, type PlayerItem } from "../src/lib/player-protocol";

function audioFixture(): HTMLAudioElement {
  const element = new EventTarget() as HTMLAudioElement;
  let url = "", paused = true;
  Object.defineProperties(element, {
    src: { get: () => url, set: (value: string) => { url = value; element.currentTime = 0; paused = true; } },
    paused: { get: () => paused }, currentTime: { value: 0, writable: true }, duration: { value: 90, writable: true },
    volume: { value: 1, writable: true }, preload: { value: "metadata", writable: true }, readyState: { value: 4, writable: true },
  });
  element.getAttribute = (name) => name === "src" ? url || null : null;
  element.removeAttribute = () => { url = ""; element.currentTime = 0; };
  element.load = () => {};
  element.play = async () => { paused = false; element.dispatchEvent(new Event("playing")); };
  element.pause = () => { paused = true; element.dispatchEvent(new Event("pause")); };
  return element;
}
class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
function tracks(count: number): PlayerItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, title: `Song ${i + 1}`,
    artist: "Mint Test", album: "Original fixtures", type: "track", duration: 90_000, albumId: "al_fixture",
  }));
}
function setup(rows = tracks(4), storage = new MemoryStorage(), memberId = "member-one", fetcher?: typeof fetch) {
  const elements = [audioFixture(), audioFixture()] as const;
  const requests: number[] = [], errors: string[] = [];
  const load: typeof fetch = fetcher ?? (async (input, init) => {
    assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "same-origin");
    const url = new URL(String(input), "http://mint.test");
    const start = Number(url.searchParams.get("start")), size = Number(url.searchParams.get("size"));
    requests.push(start);
    return Response.json({ items: rows.slice(start, start + size), start, total: rows.length });
  });
  const engine = new NativePlayer({
    memberId, elements: [elements[0], elements[1]], storage, fetcher: load,
    update: (state) => { assert.equal(playerStateSchema.safeParse(state).success, true); }, error: (message) => errors.push(message),
  });
  return { engine, elements, storage, requests, errors };
}
const library = { action: "collection", collection: { kind: "library" }, shuffle: false } as const;

test("native queue loads every page, exposes a bounded window, and preserves selection beyond page one", async () => {
  const rows = tracks(17_020), { engine, requests, elements } = setup(rows);
  try {
    await engine.execute({ ...library, id: rows[1100]!.id });
    const state = engine.getState();
    assert.deepEqual(requests, Array.from({ length: 35 }, (_, i) => i * 500));
    assert.equal(state.queueTotal, 17_020); assert.ok(state.queue.length <= 1000);
    assert.equal(state.queueOffset, 1000); assert.equal(state.track!.id, rows[1100]!.id);
    assert.equal(elements[0].src, `/api/player/audio/${rows[1100]!.id}`);
    assert.equal(state.playing, true);
    await engine.execute({ action: "previous" });
    assert.equal(engine.getState().track!.id, rows[1099]!.id);
  } finally { engine.dispose(); }
});

test("shuffle is reversible, unique, and preserves the currently playing item", async () => {
  const { engine } = setup(tracks(620));
  try {
    await engine.execute(library);
    const initial = engine.getState().queue.map((track) => track.queueId);
    const current = engine.getState().track!.queueId;
    await engine.execute({ action: "shuffle" });
    assert.equal(engine.getState().track!.queueId, current);
    assert.equal(new Set(engine.getState().queue.map((track) => track.queueId)).size, 620);
    await engine.execute({ action: "shuffle" });
    assert.deepEqual(engine.getState().queue.map((track) => track.queueId), initial);
    assert.deepEqual(shuffled([1, 2, 3, 4], () => 0), [2, 3, 4, 1]);
  } finally { engine.dispose(); }
});

test("queue moves/removal/clear never restart the current track and duplicate additions have unique identities", async () => {
  const rows = tracks(4), { engine, elements } = setup(rows);
  try {
    await engine.execute(library);
    elements[0].currentTime = 12;
    const original = engine.getState().queue;
    await engine.execute({ action: "move", queueId: original[3]!.queueId!, before: original[1]!.queueId! });
    assert.deepEqual(engine.getState().queue.map((track) => track.id), [rows[0]!.id, rows[3]!.id, rows[1]!.id, rows[2]!.id]);
    await assert.rejects(engine.execute({ action: "move", queueId: original[0]!.queueId!, before: original[1]!.queueId! }), /upcoming/);
    await engine.execute({ action: "move", queueId: original[1]!.queueId!, before: original[1]!.queueId! });
    await engine.execute({ action: "next-in-queue", item: rows[0]! });
    assert.equal(engine.getState().queueTotal, 5);
    assert.equal(engine.getState().queue[1]!.id, rows[0]!.id);
    assert.notEqual(engine.getState().queue[1]!.queueId, original[0]!.queueId);
    await engine.execute({ action: "remove", queueId: original[1]!.queueId! });
    assert.equal(engine.getState().time, 12_000); assert.equal(engine.getState().playing, true);
    await engine.execute({ action: "clear" });
    assert.equal(engine.getState().queueTotal, 1); assert.equal(elements[0].currentTime, 12);
  } finally { engine.dispose(); }
});

test("removing the current song selects its successor; removing the final song stops playback", async () => {
  const { engine } = setup(tracks(2));
  try {
    await engine.execute(library);
    await engine.execute({ action: "remove", queueId: engine.getState().track!.queueId! });
    assert.equal(engine.getState().track!.title, "Song 2"); assert.equal(engine.getState().playing, true);
    await engine.execute({ action: "remove", queueId: engine.getState().track!.queueId! });
    assert.equal(engine.getState().track, null); assert.equal(engine.getState().playing, false);
  } finally { engine.dispose(); }
});

test("repeat-one replays an ended song; repeat-all wraps; previous restarts after three seconds", async () => {
  const { engine, elements } = setup(tracks(2));
  try {
    await engine.execute(library);
    elements[0].currentTime = 8;
    await engine.execute({ action: "previous" });
    assert.equal(engine.getState().time, 0); assert.equal(engine.getState().track!.title, "Song 1");
    await engine.execute({ action: "repeat" });
    elements[0].dispatchEvent(new Event("ended"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(engine.getState().track!.title, "Song 1");
    await engine.execute({ action: "repeat" }); await engine.execute({ action: "next" }); await engine.execute({ action: "next" });
    assert.equal(engine.getState().track!.title, "Song 1");
  } finally { engine.dispose(); }
});

test("member-scoped queues restore paused with their position and cannot leak to a different account", async () => {
  const original = setup();
  await original.engine.execute({ ...library, shuffle: true });
  original.elements[0].currentTime = 14;
  const expected = original.engine.getState().track!.id;
  original.engine.dispose();
  const restored = setup(tracks(4), original.storage), other = setup(tracks(4), original.storage, "member-two");
  try {
    assert.equal(restored.engine.getState().track!.id, expected);
    assert.equal(restored.engine.getState().time, 14_000); assert.equal(restored.engine.getState().playing, false);
    assert.equal(other.engine.getState().track, null);
    await restored.engine.execute({ action: "toggle" });
    assert.equal(restored.engine.getState().playing, true); assert.equal(restored.elements[0].currentTime, 14);
  } finally { restored.engine.dispose(); other.engine.dispose(); }
});

test("malformed storage and storage quota failures are reported without breaking ordinary playback", async () => {
  const storage = new MemoryStorage();
  storage.setItem("mint:player:v3:member-one", "{invalid");
  const fixture = setup(tracks(2), storage);
  try {
    assert.match(fixture.errors[0]!, /could not restore/);
    storage.setItem = () => { throw new Error("Quota exceeded"); };
    await fixture.engine.execute(library);
    assert.equal(fixture.engine.getState().playing, true);
    assert.match(fixture.errors.at(-1)!, /queue could not be saved/);
  } finally { fixture.engine.dispose(); }
});

test("saved processing settings do not prevent standard playback when Web Audio becomes unavailable", async () => {
  const fixture = setup();
  await fixture.engine.execute(library);
  fixture.engine.dispose();
  const key = "mint:player:v3:member-one";
  const saved = JSON.parse(fixture.storage.getItem(key)!);
  saved.dsp = { ...defaultDsp, enabled: true, crossfade: 4 };
  fixture.storage.setItem(key, JSON.stringify(saved));
  const restored = setup(tracks(4), fixture.storage);
  try {
    assert.deepEqual(restored.engine.getState().dsp, defaultDsp);
    assert.match(restored.errors[0]!, /standard playback remains available/);
    await restored.engine.execute({ action: "toggle" });
    assert.equal(restored.engine.getState().playing, true);
  } finally { restored.engine.dispose(); }
});

test("new selections cancel pending work, and pause prevents a slow selection from starting later", async () => {
  let release: (() => void) | undefined;
  const rows = tracks(2);
  const fixture = setup(rows, new MemoryStorage(), "member-one", async (_input, init) => {
    await new Promise<void>((resolve, reject) => {
      release = resolve; init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    return Response.json({ items: rows, start: 0, total: 2 });
  });
  try {
    const pending = fixture.engine.execute(library);
    fixture.engine.pause();
    release!();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(fixture.engine.getState().track, null); assert.equal(fixture.engine.getState().playing, false);
  } finally { fixture.engine.dispose(); }
});

test("catalog errors, changing pages, invalid IDs and incomplete pages fail explicitly", async () => {
  const cases: Array<{ body: unknown; status?: number; message: RegExp }> = [
    { body: { error: "Membership revoked" }, status: 401, message: /Membership revoked/ },
    { body: { items: [], total: 3, start: 0 }, message: /library changed/ },
    { body: { items: tracks(1), total: 1, start: 1 }, message: /library changed/ },
    { body: { items: [{ ...tracks(1)[0], id: "/etc/private" }], total: 1, start: 0 }, message: /invalid/ },
  ];
  for (const sample of cases) await assert.rejects(loadCollection({ kind: "library" }, new AbortController().signal,
    async () => Response.json(sample.body, { status: sample.status ?? 200 })), sample.message);
});

test("access revocation clears both media sources, stops buffered audio and reports the reason", async () => {
  const { engine, elements, errors } = setup();
  try {
    await engine.execute(library);
    engine.revoke("Membership revoked");
    assert.equal(engine.getState().playing, false);
    assert.ok(elements.every((element) => !element.src && element.paused));
    assert.equal(errors.at(-1), "Membership revoked");
  } finally { engine.dispose(); }
});

class ParamFixture {
  value = 0;
  curves: Float32Array[] = [];
  setTargetAtTime(value: number) { this.value = value; }
  setValueAtTime(value: number) { this.value = value; }
  cancelScheduledValues() {}
  setValueCurveAtTime(curve: Float32Array) { this.curves.push(curve); }
}
class NodeFixture {
  gain = new ParamFixture(); frequency = new ParamFixture(); Q = new ParamFixture();
  threshold = new ParamFixture(); ratio = new ParamFixture(); knee = new ParamFixture();
  attack = new ParamFixture(); release = new ParamFixture(); type = "";
  connect() {}
}
class ContextFixture {
  currentTime = 0; sampleRate = 48000; state = "running"; destination = new NodeFixture();
  nodes: NodeFixture[] = [];
  constructor() { contexts.push(this); }
  createGain() { const node = new NodeFixture(); this.nodes.push(node); return node; }
  createBiquadFilter() { const node = new NodeFixture(); this.nodes.push(node); return node; }
  createDynamicsCompressor() { const node = new NodeFixture(); this.nodes.push(node); return node; }
  createMediaElementSource() { return new NodeFixture(); }
  async close() {}
  async resume() { this.state = "running"; }
}
const contexts: ContextFixture[] = [];

test("original DSP preserves headroom, applies EQ, schedules equal-power fades and resets to bypass", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { AudioContext: ContextFixture } });
  const a = audioFixture(), b = audioFixture();
  const dsp = new BrowserDSP([a, b]);
  try {
    await dsp.configure({ ...defaultDsp, enabled: true, bands: [6, 0, 0, 0, 0, 0, 0, 0, 0, 0], crossfade: 4 });
    const context = contexts.at(-1)!;
    assert.equal(context.nodes[1]!.gain.value, 6);
    assert.ok(Math.abs(context.nodes[11]!.gain.value - 10 ** (-15.1 / 20)) < 1e-8);
    dsp.fade(a, b, 4);
    const out = context.nodes[13]!.gain.curves[0]!, incoming = context.nodes[14]!.gain.curves[0]!;
    for (let i = 0; i < 64; i++) assert.ok(Math.abs(out[i]! ** 2 + incoming[i]! ** 2 - 1) < 1e-6);
    dsp.select(a);
    assert.equal(context.nodes[13]!.gain.value, 1); assert.equal(context.nodes[14]!.gain.value, 0);
    await dsp.configure(defaultDsp);
    assert.equal(context.nodes[1]!.gain.value, 0); assert.equal(context.nodes[11]!.gain.value, 1);
    assert.equal(context.nodes[12]!.ratio.value, 1);
    await assert.rejects(dsp.configure({ ...defaultDsp, preamp: 1 }));
    assert.deepEqual(dsp.settings, defaultDsp);
  } finally {
    dsp.dispose();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("failed standby preload is not retried on every timeupdate, and pause cancels a real transition", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { AudioContext: ContextFixture } });
  const fixture = setup();
  try {
    await fixture.engine.execute({ action: "dsp", settings: { ...defaultDsp, crossfade: 4 } });
    await fixture.engine.execute(library);
    let loads = 0;
    fixture.elements[1].load = () => { loads++; };
    fixture.elements[0].currentTime = 82;
    fixture.elements[0].dispatchEvent(new Event("timeupdate"));
    assert.equal(loads, 1);
    fixture.elements[1].dispatchEvent(new Event("error"));
    fixture.elements[0].dispatchEvent(new Event("timeupdate"));
    fixture.elements[0].dispatchEvent(new Event("timeupdate"));
    assert.equal(loads, 1); assert.equal(fixture.errors.length, 1);
    await fixture.engine.execute({ action: "seek", value: 87_000 });
    fixture.elements[0].dispatchEvent(new Event("timeupdate"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fixture.engine.getState().transitioning, true);
    assert.equal(fixture.engine.getState().track!.title, "Song 2");
    fixture.engine.pause();
    assert.equal(fixture.engine.getState().transitioning, false);
    assert.ok(fixture.elements.every((element) => element.paused));
    assert.equal(fixture.elements[0].getAttribute("src"), null);
  } finally {
    fixture.engine.dispose();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
