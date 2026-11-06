import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { collectionFromParams, collectionParams, loadCollection } from "../src/lib/browser-catalog";
import { collectionSchema } from "../src/lib/player-protocol";

test("native liked download selections round-trip and load in bounded pages", async () => {
  const all = collectionSchema.parse({ kind: "native-liked" });
  assert.deepEqual(all, { kind: "native-liked", id: "" });
  assert.deepEqual(collectionFromParams(collectionParams(all)).data, all);
  const id = "00000000-0000-4000-8000-000000000001";
  const single = collectionSchema.parse({ kind: "native-liked", id });
  assert.deepEqual(collectionFromParams(collectionParams(single)).data, single);
  assert.equal(collectionFromParams(new URLSearchParams({ kind: "native-liked", id: "invalid" })).success, false);
  assert.deepEqual(collectionFromParams(new URLSearchParams({ kind: "liked" })).data, { kind: "liked" });

  const requests: URLSearchParams[] = [];
  const items = Array.from({ length: 501 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, title: `Song ${i}`, type: "track",
  }));
  const fetcher: typeof fetch = async (input) => {
    const params = new URL(String(input), "https://mint.test").searchParams;
    requests.push(params);
    const start = Number(params.get("start")), size = Number(params.get("size"));
    return Response.json({ start, total: items.length, items: items.slice(start, start + size) });
  };
  assert.equal((await loadCollection(all, new AbortController().signal, fetcher)).length, 501);
  assert.deepEqual(requests.map((params) => [params.get("kind"), params.get("start"), params.get("size")]),
    [["native-liked", "0", "500"], ["native-liked", "500", "500"]]);
  let selectedRequest: URLSearchParams | undefined;
  const selected = await loadCollection(single, new AbortController().signal, async (input) => {
    selectedRequest = new URL(String(input), "https://mint.test").searchParams;
    return Response.json({ start: 0, total: 1, items: [items[0]] });
  });
  assert.equal(selectedRequest?.get("id"), id);
  assert.equal(selected[0]?.id, id);
  await assert.rejects(loadCollection(single, new AbortController().signal,
    async () => Response.json({ error: "Catalog unavailable" }, { status: 503 })), /Catalog unavailable/);
});

test("service worker caches only the account-free offline shell, never private responses", async () => {
  const listeners = new Map<string, (event: unknown) => void>(), added: string[][] = [], deleted: string[] = [];
  let network = true;
  const shell = new Response("generic offline shell", { headers: { "content-type": "text/html" } });
  runInNewContext(await readFile(new URL("../public/sw.js", import.meta.url), "utf8"), {
    URL, Response, console,
    self: { location: { origin: "https://mint.test" }, addEventListener: (name: string, handler: (event: unknown) => void) => listeners.set(name, handler), skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async () => ({ addAll: async (files: string[]) => { added.push([...files]); } }), keys: async () => ["unrelated-cache", "mint-offline-shell-old"],
      delete: async (key: string) => { deleted.push(key); }, match: async (key: string) => key === "/offline.html" ? shell.clone() : undefined },
    fetch: async () => { if (!network) throw new Error("offline"); return new Response("private response"); },
  });
  const lifecycle = async (name: string) => { let task: Promise<void> | undefined; listeners.get(name)!({ waitUntil: (value: Promise<void>) => { task = value; } }); await task; };
  await lifecycle("install"); await lifecycle("activate");
  assert.deepEqual(added, [["/offline.html", "/offline.css", "/offline.js"]]);
  assert.deepEqual(deleted, ["mint-offline-shell-old"]);
  const request = async (path: string, mode = "navigate") => {
    let task: Promise<Response> | undefined;
    listeners.get("fetch")!({ request: { url: `https://mint.test${path}`, mode, method: "GET" }, respondWith: (response: Promise<Response>) => { task = response; } });
    return task;
  };
  assert.equal(await (await request("/app/music"))?.text(), "private response");
  network = false;
  assert.equal(await (await request("/app/music"))?.text(), "generic offline shell");
  assert.equal(await request("/api/player/audio/private-id", "cors"), undefined);
  assert.equal(await request("/api/player/catalog", "cors"), undefined);
});
