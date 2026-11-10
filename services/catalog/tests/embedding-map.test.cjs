const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");

const root = join(__dirname, "..");

test("pinned official Embedding Atlas is bundled locally with licenses and no remote scripts", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json")));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json")));
  assert.equal(manifest.dependencies["embedding-atlas"], "0.26.0");
  assert.equal(lock.packages["node_modules/embedding-atlas"].version, "0.26.0");
  const bundle = readFileSync(join(root, "catalog/static/embedding-atlas.js"), "utf8");
  assert.match(bundle, /EmbeddingView/);
  assert.match(bundle, /requestAdapter/);
  assert.ok(bundle.length > 10000);
  const license = readFileSync(join(root, "catalog/static/embedding-atlas.LICENSE.txt"), "utf8");
  assert.match(license, /Copyright \(c\) 2025 Apple Inc/);
  assert.match(license, /Svelte Contributors/);
  const home = readFileSync(join(root, "catalog/static/index.html"), "utf8");
  assert.match(home, /value="embeddings">Embedding Atlas/);
  for (const name of ["atlas", "catalog", "artists", "recent"]) assert.match(home, new RegExp(`value="${name}"`));
  assert.doesNotMatch(home, /<script[^>]+https?:/);
});

test("embedding adapter uses real coordinates, a bounded spatial lookup and explicit selection", async () => {
  const { CatalogEmbeddingMap } = await import(pathToFileURL(join(root, "catalog/static/embedding-map.js")));
  const map = Object.create(CatalogEmbeddingMap.prototype);
  map.container = { clientWidth: 800, clientHeight: 500 };
  map.records = [];
  map.byKey = new Map();
  map.cells = new Map();
  map.mode = "points";
  map.callbacks = { tooltip() {}, inspect(key) { inspected = key; } };
  let latest, inspected;
  map.view = { update(props) { latest = props; } };
  const original = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 1;
  try {
    map.update([{ key: "a", x: 0, y: 0, title: "<img onerror=bad>", source: "musicbrainz", kind: "artist" },
      { key: "b", x: 1, y: 2, title: "Other", source: "deezer", kind: "song" }]);
    assert.equal(map.nearest(.001, .001, .001).identifier, "a");
    assert.equal(map.nearest(1000, 1000, .001), null);
    map.update([{ key: "c", x: 2, y: 1, title: "Album", source: "musicbrainz", kind: "album" }], { append: true });
    assert.deepEqual([...latest.data.x], [0, 1, 2]);
    assert.deepEqual([...latest.data.y], [0, 2, 1]);
    assert.deepEqual([...latest.data.category], [0, 2, 1]);
    assert.equal(latest.config.autoLabelEnabled, false);
    latest.onSelection([{ identifier: "b" }]);
    assert.equal(inspected, "b");
    map.select("a");
    assert.equal(latest.selection[0].identifier, "a");
    assert.equal(latest.selection[0].text, "<img onerror=bad> · musicbrainz / artist");
    map.setMode("density");
    assert.equal(latest.config.mode, "density");
    assert.equal(latest.config.autoLabelEnabled, false);
  } finally { globalThis.devicePixelRatio = original; }
});

test("record picker filters loaded records and limits DOM options without dropping map points", () => {
  const source = readFileSync(join(root, "catalog/static/console.js"), "utf8");
  const start = source.indexOf("function embeddingPicker()");
  const end = source.indexOf("async function loadEmbeddings", start);
  const fields = {
    "embedding-query": { value: "fixture" }, "graph-record": {}, "embedding-progress": {},
  };
  const records = new Map(Array.from({ length: 300 }, (_, i) => [`key${i}`, {
    key: `key${i}`, title: `Fixture ${i}`, artist: "Example", source: "musicbrainz", kind: "song",
  }]));
  const sandbox = { $: id => fields[id], embedding: { records, scanned: 310, skipped: 10 },
    state: { selected: null }, names: { musicbrainz: "MusicBrainz" },
    number: String, node: (_tag, text) => ({ text }), replace: (target, options) => { target.options = options; } };
  vm.runInNewContext(source.slice(start, end) + "\nembeddingPicker();", sandbox);
  assert.equal(fields["graph-record"].options.length, 201);
  assert.equal(records.size, 300);
  assert.match(fields["embedding-progress"].textContent, /300 picker matches \(first 200 shown/);
  fields["embedding-query"].value = "fixture 299";
  sandbox.embeddingPicker();
  assert.equal(fields["graph-record"].options.length, 2);
  assert.equal(fields["graph-record"].options[1].value, "key299");
});
