import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

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
