import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TRACK_BYTES, OfflineStore, type OfflineFiles } from "../src/offline/store";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const files = new Map<string, number>();
  const manifests = new Map<string, string>();
  let simultaneous = 0, highest = 0;
  const complete = new Map<string, () => void>();
  const port: OfflineFiles = {
    probe: async () => 128,
    download: async (id, _source, bytes, signal, progress) => {
      simultaneous++; highest = Math.max(highest, simultaneous);
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("Cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        complete.set(id, () => { signal.removeEventListener("abort", abort); resolve(); });
      }).finally(() => { simultaneous--; });
      if (signal.aborted) throw new Error("Cancelled");
      progress(bytes);
      files.set(id, bytes);
    },
    exists: async (id, bytes) => files.get(id) === bytes,
    uri: (id) => `file:///private/account-a/${id}.audio`,
    remove: async (id) => { files.delete(id); },
    clear: async () => { files.clear(); },
  };
  const storage = {
    getItem: async (key: string) => manifests.get(key) ?? null,
    setItem: async (key: string, value: string) => { manifests.set(key, value); },
    removeItem: async (key: string) => { manifests.delete(key); },
  };
  const api = { entitlement: async () => ({ memberId: "account-a", expiresAt: Date.now() + 86400_000 }),
    source: (id: string) => ({ uri: `https://mint.example/api/native/player/audio/${id}`, headers: { Authorization: "Bearer fixture-only" } }) };
  const store = new OfflineStore(port, api, storage, "scope-a", "account-a");
  return { store, files, manifests, complete, port, api, storage, highest: () => highest };
}

test("downloads are explicit, bounded to two transfers and only complete files become ready", async () => {
  const { store, complete, highest } = fixture();
  await store.restore();
  assert.equal(store.state.entries.length, 0);
  await store.download({ id: "a", title: "A" });
  await store.download({ id: "b", title: "B" });
  await store.download({ id: "c", title: "C" });
  await tick();
  assert.equal(highest(), 2);
  assert.equal(store.state.entries.find((entry) => entry.id === "a")?.status, "downloading");
  assert.equal(await store.source("a"), null);
  complete.get("a")!(); complete.get("b")!();
  await tick();
  complete.get("c")!();
  await tick();
  assert.ok(store.state.entries.every((entry) => entry.status === "ready"));
  assert.equal(store.state.bytes, 384);
  assert.match((await store.source("a"))!.uri, /^file:\/\//);
  await store.revoke();
});

test("logout cancels pending writes before clearing files and manifests", async () => {
  const { store, files, manifests } = fixture();
  await store.restore();
  await store.download({ id: "a", title: "A" });
  await tick();
  await store.revoke();
  await tick();
  assert.equal(files.size, 0);
  assert.equal(manifests.size, 0);
});

test("oversized downloads remain failed, not ready", async () => {
  const { store, port } = fixture();
  port.probe = async () => MAX_TRACK_BYTES + 1;
  await store.restore();
  await store.download({ id: "a", title: "A" });
  await tick();
  assert.equal(store.state.entries[0]?.status, "failed");
  assert.equal(store.state.bytes, 0);
  assert.match(store.state.entries[0]?.error ?? "", /128 MB/);
  await store.revoke();
});

test("a completed transfer with incorrect file length is failed and removed, not ready", async () => {
  const { store, port, files } = fixture();
  port.download = async (id, _source, bytes) => { files.set(id, bytes - 1); };
  await store.restore();
  await store.download({ id: "a", title: "A" });
  await tick();
  assert.equal(store.state.entries[0]?.status, "failed");
  assert.equal(store.state.bytes, 0);
  assert.equal(files.has("a"), false);
  assert.match(store.state.entries[0]?.error ?? "", /incomplete/);
  assert.equal(await store.source("a"), null);
  await store.revoke();
});

test("expired offline permission never serves an otherwise complete file", async () => {
  const { store, manifests, files } = fixture();
  files.set("a", 128);
  manifests.set("scope-a", JSON.stringify({ version: 1, expiresAt: 0, entries: [{ id: "a", title: "A", status: "ready", bytes: 128, expectedBytes: 128, error: null }] }));
  await store.restore();
  await assert.rejects(store.source("a"), /expired/);
  await store.revoke();
});

test("foreign account entitlement is rejected before queuing a transfer", async () => {
  const { store, api } = fixture();
  api.entitlement = async () => ({ memberId: "account-b", expiresAt: Date.now() + 86400_000 });
  await store.restore();
  await assert.rejects(store.download({ id: "a", title: "A" }), /permission is invalid/);
  assert.equal(store.state.entries.length, 0);
  await store.revoke();
});

test("interrupted manifest entries become retryable failures and never ready", async () => {
  const { store, manifests } = fixture();
  manifests.set("scope-a", JSON.stringify({ version: 1, expiresAt: Date.now() + 86400_000,
    entries: [{ id: "a", title: "A", status: "downloading", bytes: 64, expectedBytes: 128, error: null }] }));
  await store.restore();
  assert.equal(store.state.entries[0]?.status, "failed");
  assert.equal(await store.source("a"), null);
  await store.revoke();
});

test("cold launch renews an expired saved offline lease before selecting a ready file", async () => {
  const { store, manifests, files } = fixture();
  files.set("a", 128);
  manifests.set("scope-a", JSON.stringify({ version: 1, expiresAt: 0,
    entries: [{ id: "a", title: "A", status: "ready", bytes: 128, expectedBytes: 128, error: null }] }));
  await store.restoreWithRenewal(() => false);
  assert.match((await store.source("a"))!.uri, /^file:\/\//);
  await store.revoke();
});

test("disconnected cold launch never renews permission into a success-shaped fallback", async () => {
  const { store, manifests, files, api } = fixture();
  files.set("a", 128);
  manifests.set("scope-a", JSON.stringify({ version: 1, expiresAt: 0,
    entries: [{ id: "a", title: "A", status: "ready", bytes: 128, expectedBytes: 128, error: null }] }));
  api.entitlement = async () => { throw new Error("Offline"); };
  await store.restoreWithRenewal((error) => error instanceof Error && error.message === "Offline");
  await assert.rejects(store.source("a"), /expired/);
  assert.match(store.state.error!, /could not renew/);
  await store.revoke();
});

test("storage admission includes reserved bytes of concurrent transfers at the exact budget", async () => {
  const { store, complete } = fixture();
  await store.restore();
  store.state = { ...store.state, budgetBytes: 128 };
  await store.download({ id: "a", title: "A" });
  await store.download({ id: "b", title: "B" });
  await tick();
  assert.equal(store.state.entries.find((entry) => entry.id === "b")?.status, "failed");
  assert.match(store.state.entries.find((entry) => entry.id === "b")?.error ?? "", /storage is full/);
  complete.get("a")!();
  await tick();
  assert.equal(store.state.bytes, 128);
  await store.revoke();
});
