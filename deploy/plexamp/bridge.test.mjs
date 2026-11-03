import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { adaptBundle } from "./install.mjs";

const source = await readFile(new URL("./bridge.js", import.meta.url), "utf8");
function browser(member, saved = new Map()) {
  const requests = [];
  const intervals = [];
  const elements = new Map([["mint-player-error", { hidden: true, appendChild() {} }]]);
  const tracks = Array.from({ length: 501 }, (_, i) => ({
    key: `/library/metadata/track-${i}`, ratingKey: `track-${i}`, type: "track", title: `Track ${i}`, duration: 90_000,
  }));
  class Audio {
    paused = true; volume = 1; playbackRate = 1; currentTime = 0; duration = 90;
    addEventListener() {}
    set src(value) { this.currentSrc = value; }
    getAttribute() { return this.currentSrc; }
    removeAttribute() { this.currentSrc = ""; }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
    load() {}
  }
  const window = {
    mintMember: { id: member, name: member },
    localStorage: {
      get length() { return saved.size; },
      key: (index) => Array.from(saved.keys())[index] ?? null,
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
      removeItem: (key) => saved.delete(key),
    },
    addEventListener() {},
    async fetch(input, init) {
      const url = new URL(input, "https://mint.example.test");
      requests.push(url.href);
      if (url.pathname === "/listen/api/server/identity") return new Response(null, { status: 401 });
      if (url.pathname.includes("/library/")) {
        const start = Number(url.searchParams.get("X-Plex-Container-Start") ?? 0);
        const size = Number(url.searchParams.get("X-Plex-Container-Size") ?? 100);
        return Response.json({ MediaContainer: { totalSize: tracks.length, Metadata: tracks.slice(start, start + size) } });
      }
      return Response.json({ method: init?.method });
    },
  };
  const location = new URL("https://mint.example.test/listen");
  location.assign = (path) => { window.assignedPath = path; };
  vm.runInNewContext(source, {
    window, document: {
      createElement: (tag) => tag === "audio" ? new Audio() : {},
      getElementById: (id) => elements.get(id), body: { appendChild(el) { elements.set(el.id, el); } },
    },
    location, navigator: {},
    URL, URLSearchParams, Response, setInterval: (fn) => { intervals.push(fn); return 1; }, clearInterval() {},
  });
  const factories = { 15779: (_module, exports) => { exports.default = class {}; } };
  window.mintPlexamp.install(null, factories);
  const audioExports = {}, controllerExports = {}, applicationExports = {};
  factories[15779](null, applicationExports);
  factories[70383](null, audioExports);
  factories[3010](null, controllerExports, (id) => ({ default: id === 16785
    ? class { notifyObservers() {} } : class { constructor(data) { Object.assign(this, data); } } }));
  const app = new applicationExports.default();
  const audio = new audioExports.default(app);
  const controller = new controllerExports.default();
  return { window, audio, controller, app, requests, saved, intervals, elements };
}

test("adapter hook fails closed if the pinned webpack bootstrap changes", () => {
  assert.equal(adaptBundle("a;r.n=e=>x"), "a;window.mintPlexamp.install(r,e);r.n=e=>x");
  assert.throws(() => adaptBundle("changed"), /requires review/);
  assert.throws(() => adaptBundle("r.n=e=>r.n=e=>"), /requires review/);
});

test("browser queue loads every page and supports stable append, move and remove operations", async () => {
  const { window, audio, controller, requests } = browser("member-one");
  let started;
  assert.equal(await controller.doPlay({ containerKey: "/library/sections/1/all?type=10" }, (value) => { started = value; }), true);
  assert.equal(started, true);
  assert.equal(audio.queue.length, 501);
  assert.equal(requests.filter((url) => url.includes("Container-Start=500")).length, 1);
  assert.equal(audio.element.paused, false);
  await controller.doSetVolume(25);
  assert.equal(audio.element.volume, 0.25);
  await controller.doSeekTo(30_000);
  assert.equal(audio.element.currentTime, 30);
  await controller.doSetRepeatMode(1);
  await controller.doNextTrack();
  assert.equal(audio.index, 1);
  await audio.next(true);
  assert.equal(audio.index, 1);
  await audio.select(0);
  const version = audio.version;
  await controller.doSetShuffle(true);
  assert.equal(audio.version, version + 1);
  assert.equal((await (await window.fetch("https://mint.example.test/listen/api/server/playQueues/1")).json()).MediaContainer.playQueueShuffled, true);
  await controller.doSetShuffle(false);
  const first = audio.queue[0];
  const uri = `library://mint/directory/${encodeURIComponent("/library/metadata/test")}`;
  const response = await window.fetch(`https://mint.example.test/listen/api/server/playQueues/1?next=1&uri=${encodeURIComponent(uri)}`, { method: "put" });
  assert.equal(response.status, 200);
  assert.equal(audio.queue.length, 1002);
  const added = audio.queue[1];
  assert.notEqual(added.playQueueItemID, first.playQueueItemID);
  await window.fetch(`https://mint.example.test/listen/api/server/playQueues/1/items/${added.playQueueItemID}/move?after=-1`, { method: "put" });
  assert.equal(audio.queue[0], added);
  assert.equal(audio.queue[audio.index], first);
  await window.fetch(`https://mint.example.test/listen/api/server/playQueues/1/items/${added.playQueueItemID}`, { method: "delete" });
  assert.equal(audio.queue[0], first);
  assert.equal(audio.index, 0);
  await window.fetch("https://mint.example.test/listen/api/server/playQueues/1/items", { method: "delete" });
  assert.equal(audio.queue.length, 1);
  assert.equal((await window.fetch("https://mint.example.test/listen/api/server/playQueues/1/unsupported", { method: "put" })).status, 405);
});

test("preferences are member-local and revoked access stops buffered audio", async () => {
  const saved = new Map();
  const one = browser("member-one", saved);
  const two = browser("member-two", saved);
  const url = "https://plex.tv/api/v2/user/settings?key=RecentPlays";
  await one.window.fetch(url, { method: "post", body: new URLSearchParams({ value: JSON.stringify({ version: 1, data: [{ key: "track" }] }) }) });
  assert.equal((await (await one.window.fetch(url)).json()).data.length, 1);
  assert.ok(Object.keys(one.window.localStorage).includes("cloud:RecentPlays"));
  assert.deepEqual((await (await two.window.fetch(url)).json()).data, []);
  assert.ok(Array.from({ length: one.window.localStorage.length }, (_, i) => one.window.localStorage.key(i)).includes("cloud:RecentPlays"));
  two.window.localStorage.clear();
  assert.equal((await (await one.window.fetch(url)).json()).data.length, 1);
  await one.controller.doPlay({ containerKey: "/library/sections/1/all" });
  await one.intervals[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(one.audio.element.currentSrc, "");
  assert.equal(one.elements.get("mint-player-error").hidden, false);
  await assert.rejects(one.window.fetch("https://example.net/private"), /disabled/);
  await one.app.signOut();
  assert.equal(one.window.assignedPath, "/");
  assert.ok(one.requests.includes("https://mint.example.test/listen/api/logout"));
  assert.equal(one.window.localStorage.length, 0);
});
