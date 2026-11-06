import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { BrowserDSP } from "../src/lib/browser-dsp";
import { loadCollection, shuffled } from "../src/lib/browser-catalog";
import { NativePlayer } from "../src/lib/native-player";
import { defaultDsp, playerStateSchema, type PlayerItem } from "../src/lib/player-protocol";
import { camelotCompatibility, normalizationGain, smartTransition } from "../src/lib/smart-fades";
import { analysisSchema } from "@mint/core/analysis";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlaybackControls } from "../src/components/app/player-controls";
import { QueueContents } from "../src/components/app/player-panels";
import type { PlayerState } from "../src/lib/player-protocol";

test("playback controls and queue communicate their current state", () => {
  const [track, next] = tracks(2).map((item, index) => ({ ...item, queueId: `entry-${index}` }));
  const state: PlayerState = { playing: true, track: track!, time: 0, duration: 90_000, volume: 100,
    shuffle: false, repeat: 2, queue: [track!, next!], queueOffset: 0, queueTotal: 3 };
  const controls = renderToStaticMarkup(createElement(PlaybackControls, { state, ready: true, command: () => undefined, expanded: true }));
  assert.match(controls, /aria-label="Repeat all"[^>]*aria-pressed="true"/);
  // The test runner uses the classic JSX transform for components compiled by Next.
  const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { value: React, configurable: true });
  try {
    const queue = renderToStaticMarkup(createElement(QueueContents, { state, command: () => undefined }));
    assert.match(queue, /Next in queue.*2 songs/);
    assert.match(queue, /Showing the next 1 of 2 songs/);
    assert.match(queue, /aria-label="Play Song 2"/);
    assert.equal((queue.match(/aria-label="Play Song 2"/g) ?? []).length, 1);
    assert.match(queue, /aria-label="Remove Song 2 from queue"/);
    const partial = renderToStaticMarkup(createElement(QueueContents, { state: { ...state, queue: [track!] }, command: () => undefined }));
    assert.match(partial, /More songs are in your queue/);
    assert.doesNotMatch(partial, /Your queue is empty/);
  } finally {
    if (previousReact) Object.defineProperty(globalThis, "React", previousReact);
    else Reflect.deleteProperty(globalThis, "React");
  }
});

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
type FixtureQueue = { rows: PlayerItem[]; order: string[]; shuffle: boolean; revision: number };
const serverQueues = new WeakMap<Storage, Map<string, FixtureQueue>>();
function setup(rows = tracks(4), storage = new MemoryStorage(), memberId = "member-one", fetcher?: typeof fetch) {
  const elements = [audioFixture(), audioFixture()] as const;
  const requests: number[] = [], errors: string[] = [];
  const load: typeof fetch = fetcher ?? (async (input, init) => {
    assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "same-origin");
    const url = new URL(String(input), "http://mint.test");
    if (url.pathname.startsWith("/api/player/queue")) {
      let sessions = serverQueues.get(storage);
      if (!sessions) { sessions = new Map(); serverQueues.set(storage, sessions); }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      let id = url.pathname.split("/")[4], position = Number(url.searchParams.get("position")) || 0;
      if (!id) {
        id = randomUUID();
        const entries = rows.map((track) => ({ ...track, queueId: randomUUID() }));
        const queue = { rows: body.shuffle ? shuffled(entries) : entries, order: entries.map((item) => item.queueId), shuffle: Boolean(body.shuffle), revision: 1 };
        sessions.set(id, queue); requests.push(-1);
        position = body.trackId ? queue.rows.findIndex((track) => track.id === body.trackId) : 0;
      }
      const queue = sessions.get(id)!;
      if (body?.edit) {
        const current = queue.rows.find((track) => track.queueId === body.currentId)!;
        const index = queue.rows.indexOf(current), edit = body.edit;
        if (edit.action === "shuffle") {
          queue.shuffle = edit.enabled;
          queue.rows = edit.enabled ? [...queue.rows.slice(0, index + 1), ...shuffled(queue.rows.slice(index + 1))]
            : queue.rows.slice().sort((a, b) => queue.order.indexOf(a.queueId!) - queue.order.indexOf(b.queueId!));
        } else if (edit.action === "remove") queue.rows = queue.rows.filter((item) => item.queueId !== edit.entryId);
        else if (edit.action === "clear") queue.rows = queue.rows.slice(0, index + 1);
        else if (edit.action === "append" || edit.action === "append-collection") {
          const ids = edit.action === "append" ? edit.trackIds : rows.map((item) => item.id);
          const entries = ids.map((id: string) => ({ ...rows.find((item) => item.id === id)!, queueId: randomUUID() }));
          queue.rows.splice(edit.next ? index + 1 : queue.rows.length, 0, ...entries); queue.order.push(...entries.map((item: PlayerItem) => item.queueId!));
        } else if (edit.action === "move") {
          const from = queue.rows.findIndex((item) => item.queueId === edit.entryId), to = queue.rows.findIndex((item) => item.queueId === edit.before);
          if (from <= index || to <= index) return Response.json({ error: "Only upcoming songs can be moved." }, { status: 400 });
          if (from !== to) { const target = queue.rows[to]!, [entry] = queue.rows.splice(from, 1); queue.rows.splice(queue.rows.indexOf(target), 0, entry!); }
        }
        position = Math.max(0, queue.rows.indexOf(current) >= 0 ? queue.rows.indexOf(current) : Math.min(index, queue.rows.length - 1));
        queue.revision++;
      } else if (init?.method === "GET") requests.push(position);
      const offset = Math.max(0, position - 20);
      return Response.json({ context: { id, revision: queue.revision, total: queue.rows.length, offset, position, shuffle: queue.shuffle }, items: queue.rows.slice(offset, offset + 100) });
    }
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

test("manual Next retries a cancelled boundary preload without changing the selected context", { timeout: 5000 }, async () => {
  const rows = tracks(220).map((track) => ({ ...track, queueId: randomUUID() })), id = randomUUID();
  let reads = 0, started!: () => void;
  const preloading = new Promise<void>((resolve) => { started = resolve; });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "http://mint.test"), position = Number(url.searchParams.get("position")) || 0;
    if (init?.method === "GET" && ++reads === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled preload", "AbortError")), { once: true });
        started();
      });
    }
    const offset = Math.max(0, position - 20);
    return Response.json({ context: { id, revision: 1, total: rows.length, offset, position, shuffle: false }, items: rows.slice(offset, offset + 100) });
  };
  const { engine, elements, errors } = setup(rows, new MemoryStorage(), "member-one", fetcher);
  try {
    await engine.execute(library);
    for (let i = 0; i < 99; i++) await engine.execute({ action: "next" });
    elements[0].currentTime = 80; elements[0].dispatchEvent(new Event("timeupdate"));
    await preloading;
    await engine.execute({ action: "next" });
    assert.equal(engine.getState().track!.id, rows[100]!.id);
    assert.equal(engine.getState().queueTotal, 220); assert.equal(reads, 2);
    assert.deepEqual(errors, []);
  } finally { engine.dispose(); }
});

test("appending a large collection never downloads its complete metadata into the browser", async () => {
  const { engine, requests } = setup(tracks(6010));
  try {
    await engine.execute(library);
    await engine.execute({ action: "next-in-queue", item: { id: "ar_fixture", type: "artist", title: "Mint Test" } });
    assert.equal(engine.getState().queueTotal, 12020);
    assert.equal(engine.getState().queue.length, 100);
    assert.deepEqual(requests, [-1]);
  } finally { engine.dispose(); }
});

test("native queue starts with one bounded page and preserves selection beyond page one", async () => {
  const rows = tracks(17_020), { engine, requests, elements } = setup(rows);
  try {
    await engine.execute({ ...library, id: rows[1100]!.id });
    const state = engine.getState();
    assert.deepEqual(requests, [-1]);
    assert.equal(state.queueTotal, 17_020); assert.ok(state.queue.length <= 100);
    assert.equal(state.queueOffset, 1080); assert.equal(state.track!.id, rows[1100]!.id);
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
    assert.equal(new Set(engine.getState().queue.map((track) => track.queueId)).size, 100);
    assert.equal(engine.getState().queueTotal, 620);
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

test("explicit device queues preserve duplicate occurrences, positions and paused state, including empty queues", async () => {
  const { engine, elements } = setup();
  try {
    const [one, two] = tracks(2);
    await engine.execute({ action: "items", items: [one!, two!, one!], index: 2, position: 15_000, paused: true });
    assert.equal(engine.getState().queueTotal, 3); assert.equal(engine.getState().time, 15_000);
    assert.equal(engine.getState().playing, false); assert.equal(new Set(engine.getState().queue.map((track) => track.queueId)).size, 3);
    await engine.execute({ action: "resume" }); assert.equal(engine.getState().playing, true);
    await engine.execute({ action: "items", items: [] });
    assert.equal(engine.getState().track, null); assert.equal(engine.getState().queueTotal, 0);
    assert.ok(elements.every((element) => element.paused && !element.getAttribute("src")));
  } finally { engine.dispose(); }
});

test("fades-off playback promotes its preloaded deck at the song boundary without reloading it", async () => {
  const { engine, elements } = setup(tracks(2));
  try {
    await engine.execute(library);
    elements[0].currentTime = 80; elements[0].dispatchEvent(new Event("timeupdate"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prepared = elements[1].src;
    assert.ok(prepared.endsWith(tracks(2)[1]!.id));
    elements[0].dispatchEvent(new Event("ended"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(elements[1].src, prepared); assert.equal(elements[1].paused, false);
    assert.equal(elements[0].getAttribute("src"), null);
    assert.equal(engine.getState().track!.id, tracks(2)[1]!.id);
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

test("Previous restarts a restored song after three seconds without autoplay or fetching its queue", async () => {
  const rows = tracks(220), original = setup(rows);
  await original.engine.execute({ ...library, id: rows[120]!.id });
  original.elements[0].currentTime = 14;
  original.engine.dispose();
  const restored = setup(rows, original.storage);
  try {
    const occurrence = restored.engine.getState().track!.queueId;
    await restored.engine.execute({ action: "previous" });
    assert.equal(restored.engine.getState().track!.queueId, occurrence);
    assert.equal(restored.engine.getState().time, 0);
    assert.equal(restored.engine.getState().playing, false);
    assert.deepEqual(restored.requests, []);
    assert.ok(restored.elements.every((element) => !element.src && element.paused));
    await restored.engine.execute({ action: "resume" });
    assert.equal(restored.engine.getState().track!.queueId, occurrence);
    assert.equal(restored.engine.getState().time, 0);
    assert.equal(restored.engine.getState().playing, true);
  } finally { restored.engine.dispose(); }
});

test("Previous near the start of a restored song revalidates the window and selects the preceding audio", async () => {
  const rows = tracks(220), original = setup(rows);
  await original.engine.execute({ ...library, id: rows[120]!.id });
  original.elements[0].currentTime = 2;
  original.engine.dispose();
  const restored = setup(rows, original.storage);
  try {
    await restored.engine.execute({ action: "previous" });
    assert.deepEqual(restored.requests, [119]);
    assert.equal(restored.engine.getState().track!.id, rows[119]!.id);
    assert.equal(restored.elements[0].src, `/api/player/audio/${rows[119]!.id}`);
    assert.equal(restored.engine.getState().time, 0);
    assert.equal(restored.engine.getState().playing, true);
  } finally { restored.engine.dispose(); }
});

test("Previous wraps repeat-all through a bounded tail window and Next returns to the first occurrence", async () => {
  const rows = tracks(620), { engine, elements, requests } = setup(rows);
  try {
    await engine.execute(library);
    const first = engine.getState().track!.queueId;
    await engine.execute({ action: "repeat" });
    await engine.execute({ action: "repeat" });
    elements[0].currentTime = 8;
    await engine.execute({ action: "previous" });
    assert.equal(engine.getState().track!.queueId, first, "restart takes precedence over wrapping");
    assert.equal(engine.getState().time, 0);
    await engine.execute({ action: "previous" });
    assert.equal(engine.getState().track!.id, rows.at(-1)!.id);
    assert.equal(engine.getState().queueTotal, 620);
    assert.equal(engine.getState().queueOffset, 599);
    assert.ok(engine.getState().queue.length <= 100);
    assert.equal(engine.getState().playing, true);
    assert.deepEqual(requests, [-1, 619]);
    await engine.execute({ action: "next" });
    assert.equal(engine.getState().track!.queueId, first);
    assert.deepEqual(requests, [-1, 619, 0]);
  } finally { engine.dispose(); }
});

test("Previous wraps local repeat-all queues by occurrence, including duplicate songs", async () => {
  const rows = tracks(2), { engine } = setup(rows);
  try {
    await engine.execute({ action: "items", items: [rows[0]!, rows[1]!, rows[0]!], repeat: 2 });
    const first = engine.getState().track!.queueId, last = engine.getState().queue.at(-1)!.queueId;
    await engine.execute({ action: "previous" });
    assert.equal(engine.getState().track!.queueId, last);
    assert.notEqual(engine.getState().track!.queueId, first);
    await engine.execute({ action: "previous" });
    assert.equal(engine.getState().track!.id, rows[1]!.id);
    for (const repeat of [0, 1]) {
      await engine.execute({ action: "items", items: rows, repeat });
      const occurrence = engine.getState().track!.queueId;
      await engine.execute({ action: "previous" });
      assert.equal(engine.getState().track!.queueId, occurrence, "repeat-off and repeat-one never wrap backward");
    }
  } finally { engine.dispose(); }
});

test("a slow Previous wrap cannot replace a newer selection, and conflicting queue revisions fail explicitly", { timeout: 5000 }, async () => {
  for (const conflict of [false, true]) {
    const rows = tracks(220).map((track) => ({ ...track, queueId: randomUUID() })), id = randomUUID();
    let started!: () => void, release!: () => void;
    const loading = new Promise<void>((resolve) => { started = resolve; });
    const fetcher: typeof fetch = async (input) => {
      const position = Number(new URL(String(input), "http://mint.test").searchParams.get("position")) || 0;
      if (position === rows.length - 1) {
        started();
        if (!conflict) await new Promise<void>((resolve) => { release = resolve; });
      }
      const offset = Math.max(0, position - 20);
      return Response.json({ context: { id, revision: position > 0 && conflict ? 2 : 1, total: rows.length, offset, position, shuffle: false },
        items: rows.slice(offset, offset + 100) });
    };
    const { engine, elements } = setup(rows, new MemoryStorage(), "member-one", fetcher);
    try {
      await engine.execute(library);
      await engine.execute({ action: "repeat" });
      await engine.execute({ action: "repeat" });
      const first = engine.getState().track!.queueId;
      const previous = engine.execute({ action: "previous" });
      if (conflict) {
        await assert.rejects(previous, /changed on another device/);
        assert.equal(engine.getState().track!.queueId, first);
      } else {
        await loading;
        await engine.execute({ action: "items", items: [rows[1]!], paused: true });
        release();
        await assert.rejects(previous, { name: "AbortError" });
        assert.equal(engine.getState().track!.id, rows[1]!.id);
        assert.equal(engine.getState().queueTotal, 1);
        assert.equal(engine.getState().playing, false);
      }
      assert.equal(elements[0].src, `/api/player/audio/${engine.getState().track!.id}`);
    } finally { engine.dispose(); }
  }
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
    assert.equal(restored.engine.getState().track!.thumb, `/api/artwork/${expected}`, "saved queues move to Plex-first artwork without requiring reselection");
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
    const out = context.nodes[13]!.gain.curves[0]!, incoming = context.nodes[15]!.gain.curves[0]!;
    for (let i = 0; i < 64; i++) assert.ok(Math.abs(out[i]! ** 2 + incoming[i]! ** 2 - 1) < 1e-6);
    dsp.select(a);
    assert.equal(context.nodes[13]!.gain.value, 1); assert.equal(context.nodes[15]!.gain.value, 0);
    dsp.normalize(a, -4);
    await dsp.configure({ ...dsp.settings, normalize: true });
    assert.ok(Math.abs(context.nodes[14]!.gain.value - 10 ** (-4 / 20)) < 1e-8);
    await dsp.configure(defaultDsp);
    assert.equal(context.nodes[1]!.gain.value, 0); assert.equal(context.nodes[11]!.gain.value, 1);
    assert.equal(context.nodes[12]!.ratio.value, 1);
    await assert.rejects(dsp.configure({ ...defaultDsp, preamp: 1 }));
    assert.deepEqual(dsp.settings, defaultDsp);
    await dsp.configure({ ...defaultDsp, loudnessContour: true, stereoMode: "crossfeed", limiter: true });
    assert.equal(context.nodes[17]!.gain.value, 4.5);
    assert.equal(context.nodes[18]!.gain.value, 3.0);
    assert.equal(context.nodes[19]!.gain.value, -1.5);
    assert.equal(context.nodes[20]!.ratio.value, 20);
  } finally {
    dsp.dispose();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Smart Fades v2 aligns beatgrids, scores Camelot keys, protects vocals, and supports v1 fallback", () => {
  const [from, to] = tracks(2);
  const v2Base = {
    version: 2 as const,
    algorithm: "mint-dsp-v2" as const,
    fingerprint: { sha256: "a".repeat(64), bytes: 1024, mtimeMs: 1000 },
    measuredAt: new Date().toISOString(),
    durationSec: 180,
    leadingSilenceSec: 0.4,
    trailingSilenceSec: 0.8,
    integratedLufs: -14,
    truePeakDbtp: -1,
    lraLu: 6,
    shortTermMaxLufs: -11,
    crestFactorDb: 9,
    energy: {
      rms: 0.25,
      peak: 0.8,
      dynamicRangeDb: 8,
      spectralCentroidHz: 1800,
      spectralRolloffHz: 4200,
      spectralFlatness: 0.12,
      zeroCrossingRate: 0.08,
      spectralFlux: 0.18,
    },
    tempo: { bpm: 120, confidence: 0.85, tempoStability: 0.9, firstDownbeatSec: 0.5, beatIntervalSec: 0.5, timeSignature: "4/4" as const },
    key: { name: "A minor", camelot: "8A", openKey: "1m", scale: "minor" as const, confidence: 0.82 },
    structure: {
      introEndSec: 8,
      outroStartSec: 168,
      firstPeakSec: 16,
      fadeInContourDb: [-36, -24, -16, -12, -8, -6, -4, -3, -2, -2, -1, -1, -1, 0, 0, 0],
      fadeOutContourDb: [0, 0, -1, -2, -3, -5, -8, -11, -14, -16, -20, -25, -30, -36, -44, -55],
    },
    classification: {
      genres: [{ name: "Electronic", subgenre: "House", confidence: 0.84 }],
      moods: [{ name: "energetic" as const, confidence: 0.8 }, { name: "party" as const, confidence: 0.65 }],
      valence: 0.68,
      arousal: 0.78,
      danceability: 0.85,
      voiceInstrumental: { label: "instrumental" as const, vocalPresence: 0.18, confidence: 0.82 },
    },
    waveform: new Array(256).fill(0.3),
    similarity: { method: "audio-embedding-v2" as const, confidence: 0.9, vector: new Array(64).fill(0.1) },
    provenance: { engine: "ffmpeg+mint-dsp-v2", sampleRate: 16000, notes: ["Synthetic v2 fixture"] },
  };
  const outgoing = analysisSchema.parse(v2Base);
  const incoming = analysisSchema.parse({
    ...v2Base,
    key: { ...v2Base.key, name: "C major", camelot: "8B", openKey: "1d", scale: "major" as const },
  });
  assert.equal(camelotCompatibility(outgoing.key, incoming.key).match, "relative");
  const harmonicPlan = smartTransition({
    from: { ...from!, albumId: "al_one" },
    to: { ...to!, albumId: "al_two" },
    outgoing,
    incoming,
    settings: { ...defaultDsp, fadeMode: "smart", crossfade: 8, albumSafe: true },
    shuffled: true,
    outgoingDuration: 180,
  });
  assert.ok(harmonicPlan.seconds > 0);
  assert.match(harmonicPlan.reason, /120 BPM/);
  assert.match(harmonicPlan.reason, /8A → 8B relative key/);

  const vocalOut = analysisSchema.parse({
    ...v2Base,
    waveform: new Array(256).fill(0.6),
    classification: { ...v2Base.classification, voiceInstrumental: { label: "vocal" as const, vocalPresence: 0.85, confidence: 0.9 } },
  });
  const vocalIn = analysisSchema.parse({
    ...v2Base,
    waveform: new Array(256).fill(0.6),
    classification: { ...v2Base.classification, voiceInstrumental: { label: "vocal" as const, vocalPresence: 0.82, confidence: 0.88 } },
  });
  const vocalPlan = smartTransition({
    from: { ...from!, albumId: "al_one" },
    to: { ...to!, albumId: "al_two" },
    outgoing: vocalOut,
    incoming: vocalIn,
    settings: { ...defaultDsp, fadeMode: "smart", crossfade: 8 },
    shuffled: true,
    outgoingDuration: 180,
  });
  assert.match(vocalPlan.reason, /vocal boundary protected/);
  assert.ok(vocalPlan.seconds <= 8 * 0.5);

  const quietInterlude = analysisSchema.parse({ ...v2Base, integratedLufs: -24, truePeakDbtp: -8, lraLu: 16 });
  assert.equal(normalizationGain(quietInterlude, -16, { mode: "auto", sameAlbumSequence: true }), 3);
  assert.ok(normalizationGain(quietInterlude, -16, { mode: "track", sameAlbumSequence: false }) > 3);
});

test("failed standby preload is not retried on every timeupdate, and pause cancels a real transition", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { AudioContext: ContextFixture } });
  const fixture = setup();
  try {
    await fixture.engine.execute({ action: "dsp", settings: { ...defaultDsp, crossfade: 4, albumSafe: false } });
    await fixture.engine.execute(library);
    let loads = 0;
    fixture.elements[1].load = () => { loads++; };
    fixture.elements[0].currentTime = 82;
    fixture.elements[0].dispatchEvent(new Event("timeupdate"));
    await new Promise((resolve) => setTimeout(resolve, 0));
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
