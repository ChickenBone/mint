import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./integration.js", import.meta.url), "utf8");
function fixture() {
  const messages = [], listeners = {}, documentListeners = {}, actions = [], timers = [];
  const parent = { postMessage: (data, origin) => messages.push({ ...data, origin }),
    document: { body: {}, styleSheets: [] }, getComputedStyle: () => ({ fontFamily: "Figtree" }) };
  const window = { parent, addEventListener: (name, fn) => { listeners[name] = fn; } };
  const audio = { index: 0, queue: [], element: { paused: true, getAttribute: () => null }, state: { time: 0, duration: 0, volume: 100 }, shuffle: false, repeat: 0 };
  const controller = new Proxy({}, { get: (_target, method) => (...args) => actions.push([method, ...args]) });
  const palettes = () => ({ darkStyle: {}, blackStyle: {}, lightStyle: {}, whiteStyle: {}, style: {} });
  const factories = {
    43662: (_m, e) => { e.default = class { constructor() { this.player = { play: async (args) => actions.push(["play", args]) }; } }; },
    5713: (_m, e) => { e.default = class { constructor() { Object.assign(this, palettes()); } setNavigationTheme() {} }; },
    76167: (_m, e) => { e.default = class { constructor() { this.popup = () => assert.fail("Native music menu must be replaced"); } }; },
    75415: (_m, e) => { e.default = Object.assign(() => null, { onTabPress: () => "preserved" }); },
    67981: (_m, e) => { e.computeImageUrl = (_source, thumb) => thumb; },
    52626: (_m, e) => { e.useCombinedHubs = () => [{ type: "station" }, { type: "track", items: [], hubIdentifier: "music.recent.plays" }, { type: "album", items: [] }]; },
    2121() {}, 53593() {}, 72003: (_m, e) => { e.default = () => null; },
    87279: (_m, e) => { e.default = { MINI_PLAYER_HEIGHT: 60 }; },
    88680: (_m, e) => { e.default = {
      navigate: (...args) => actions.push(["native-navigate", ...args]),
      push: (...args) => actions.push(["native-push", ...args]),
    }; },
  };
  const require = (id) => ({ default: id === 60626 ? class { constructor(data) { Object.assign(this, data); } }
    : { currentRoute: () => ({ name: "Home" }), navigate: (...args) => actions.push(["navigate", ...args]) } });
  vm.runInNewContext(source, {
    window, location: { origin: "https://mint.example.test" }, innerWidth: 800, innerHeight: 600, URL, CSSRule: { FONT_FACE_RULE: 5 },
    document: { addEventListener: (name, fn) => { documentListeners[name] = fn; },
      documentElement: { style: { setProperty() {} } }, createElement: () => ({}), head: { appendChild() {} } },
    console, queueMicrotask, setTimeout: (fn) => timers.push(fn), clearTimeout() {},
  });
  window.mintShell.install(require, factories, { getAudio: () => audio, getController: () => controller });
  const exportsFor = (id) => { const e = {}; factories[id](null, e, require); return e; };
  const load = (id) => exportsFor(id).default;
  const Store = load(43662); new Store();
  const Tabs = load(75415); Tabs({ navigation: { navigate: (...args) => actions.push(["tab", ...args]) } }); timers.splice(0).forEach((fn) => fn());
  async function send(command, overrides = {}) {
    listeners.message({ origin: "https://mint.example.test", source: parent, data: { channel: "mint-player-v2", type: "command", id: "request", command }, ...overrides });
    await new Promise(setImmediate);
  }
  return { messages, actions, send, load, exportsFor, audio, Tabs, documentListeners, shell: window.mintShell,
    flush: () => timers.splice(0).forEach((fn) => fn()) };
}

test("the integration retains native theme contracts and tab helpers", () => {
  const { load, messages, Tabs } = fixture();
  const Theme = load(5713);
  const theme = new Theme();
  for (const style of [theme.darkStyle, theme.lightStyle, theme.blackStyle, theme.whiteStyle, theme.style]) {
    assert.equal(style.textColor, "#f2f5f3");
    assert.equal(style.background, "#121614");
    assert.equal(style.seekBarPastNormalColor, "#3fe0a0");
  }
  assert.equal(Tabs.onTabPress(), "preserved");
  assert.equal(messages.filter((m) => m.type === "ready").length, 1);
});

test("Mint owns native palettes and removes unavailable stations and cast controls", async () => {
  const { load, exportsFor } = fixture();
  assert.equal(load(2121)(), null);
  assert.equal(load(53593)(), null);
  assert.equal(load(87279).MINI_PLAYER_HEIGHT, 0);
  assert.equal(load(72003)({ icon: "download" }), null);
  const colors = exportsFor(67981);
  assert.deepEqual(Array.from(await colors.extractPalette()), ["#3fe0a0", "#121614", "#1a1f1d", "#232a27"]);
  assert.deepEqual(Array.from(colors.pickTwoAccentColors()), ["#f2f5f325", "#3fe0a0"]);
  assert.equal(colors.computeImageUrl("mint", "/photo/:/transcode?url=https%3A%2F%2Fi.ytimg.com%2Fart.jpg"), "https://i.ytimg.com/art.jpg");
  assert.equal(exportsFor(52626).useCombinedHubs().length, 1);
});

test("commands require the exact parent and origin and reject unsafe selections", async () => {
  const { send, actions, messages } = fixture();
  await send({ action: "next" }, { origin: "https://other.example" });
  await send({ action: "next" }, { source: {} });
  assert.deepEqual(actions, []);
  await send({ action: "next" });
  assert.deepEqual(actions[0], ["doNextTrack"]);
  for (const command of [
    { action: "fetch", url: "https://example.test" }, { action: "volume", value: Infinity }, { action: "seek", value: -1 },
    { action: "play", item: { key: "//example.test/file", title: "Bad", type: "track" } },
    { action: "play", item: { key: "/listen/api/logout", title: "Bad", type: "track" } },
  ]) {
    await send(command);
    assert.equal(messages.at(-1).type, "result");
    assert.equal(messages.at(-1).ok, false);
  }
  await send({ action: "play", item: { key: "/library/metadata/track-1", title: "A song", type: "track" } });
  assert.equal(actions.at(-1)[0], "play");
});

test("native music menus become semantic Mint menus without suppressing unrelated context menus", async () => {
  const { load, messages, documentListeners } = fixture();
  let prevented = false;
  documentListeners.contextmenu({ clientX: 35, clientY: 42, target: { closest: () => null }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  const Menu = load(76167);
  const menu = new Menu();
  menu.popup({ key: "/library/metadata/album-1/children", ratingKey: "album-1", title: "Album", type: "album" });
  menu.popup({ key: "/library/metadata/track-1", ratingKey: "track-1", title: "The right song", type: "track" });
  assert.equal(prevented, true);
  await new Promise(setImmediate);
  assert.equal(messages.filter((message) => message.type === "menu").length, 1);
  assert.equal(messages.at(-1).type, "menu");
  assert.equal(messages.at(-1).item.title, "The right song");
  assert.equal(messages.at(-1).point.x, 35);
});

test("collection commands preserve search, shuffle and private playlist identities without accepting arbitrary paths", async () => {
  const { send, actions, messages } = fixture();
  await send({ action: "collection", collection: { kind: "library", query: "First & Light" }, shuffle: true });
  assert.equal(actions.at(-1)[0], "play");
  assert.equal(actions.at(-1)[1].containerKey, "/library/sections/1/all?type=10&query=First%20%26%20Light");
  assert.equal(actions.at(-1)[1].shuffle, true);
  await send({ action: "collection", collection: { kind: "liked" }, shuffle: false });
  assert.equal(actions.at(-1)[1].containerKey, "/playlists/liked/items");
  await send({ action: "collection", collection: { kind: "playlist", id: "00000000-0000-0000-0000-000000000001" }, shuffle: false });
  assert.equal(actions.at(-1)[1].containerKey, "/playlists/00000000-0000-0000-0000-000000000001/items");
  for (const collection of [{ kind: "library", query: "a".repeat(101) }, { kind: "playlist", id: "/logout" }, { kind: "url", path: "https://example.test" }]) {
    await send({ action: "collection", collection, shuffle: false });
    assert.equal(messages.at(-1).ok, false);
  }
});

test("queue snapshots are bounded without pretending the full queue is present", async () => {
  const { audio, messages, send } = fixture();
  audio.queue = Array.from({ length: 2500 }, (_, i) => ({ key: `/library/metadata/track-${i}`, ratingKey: `track-${i}`, title: `Track ${i}`, type: "track", playQueueItemID: String(i + 1) }));
  audio.index = 800;
  await send({ action: "state" });
  const state = messages.findLast((message) => message.type === "state").state;
  assert.equal(state.queue.length, 1000);
  assert.equal(state.queueTotal, 2500);
  assert.equal(state.queueOffset, 780);
  assert.equal(state.track.ratingKey, "track-800");
});

test("the last native state update is delivered even when playback pauses during throttling", () => {
  const { audio, messages, shell, flush } = fixture();
  audio.element.paused = false;
  audio.element.getAttribute = () => "/listen/api/audio/track-1";
  shell.update(true);
  assert.equal(messages.at(-1).state.playing, true);
  audio.element.paused = true;
  shell.update();
  flush();
  assert.equal(messages.at(-1).state.playing, false);
});

test("native and compatibility now-playing entry points open Mint without changing playback", async () => {
  const { load, messages, actions, send } = fixture();
  const navigation = load(88680);
  navigation.navigate("Player", { source: "mint" });
  navigation.push("Player");
  await send({ action: "navigate", view: "now-playing" });
  assert.equal(messages.filter((message) => message.type === "now-playing").length, 3);
  assert.deepEqual(actions, []);
  navigation.navigate("Browser", { key: "album-1" });
  navigation.push("Browser", { key: "artist-1" });
  assert.deepEqual(actions, [
    ["native-navigate", "Browser", { key: "album-1" }],
    ["native-push", "Browser", { key: "artist-1" }],
  ]);
});
