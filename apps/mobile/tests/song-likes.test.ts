import assert from "node:assert/strict";
import test from "node:test";
import type { MintApi } from "@mint/client";
import { createSongLikes, songLikes } from "../src/hooks/song-likes";
import { useSongLike } from "../src/hooks/useSongLike";
import { harness } from "./helpers/hook-harness";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const page = (liked: boolean) => ({ items: liked ? [{ id, title: "Song", type: "track" as const }] : [], total: liked ? 1 : 0, start: 0 });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("like lookup is one bounded current-song query shared by all listeners, not an all-likes poll", async () => {
  const pending = deferred<ReturnType<typeof page>>();
  let calls = 0;
  const api = { catalog: async (query: Parameters<MintApi["catalog"]>[0]) => {
    calls++; assert.deepEqual(query, { kind: "native-liked", id, size: 1 }); return pending.promise;
  }, setLike: async () => ({ ok: true as const }) };
  const store = createSongLikes(api);
  let updates = 0;
  const unsubscribe = store.subscribe(() => { updates++; });
  const a = store.load(id), b = store.load(id);
  assert.equal(store.snapshot(id).pending, true);
  pending.resolve(page(true));
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.deepEqual(store.snapshot(id), { liked: true, pending: false, error: null });
  assert.equal(updates, 2);
  unsubscribe();
});

test("confirmed mutation invalidates liked lists once; pending/failed changes never pretend success", async () => {
  const pending = deferred<{ ok: true }>();
  const store = createSongLikes({ catalog: async () => page(false), setLike: async () => pending.promise });
  await store.load(id);
  const write = store.set(id, true);
  assert.equal(store.snapshot(id).liked, false);
  assert.equal(store.snapshot(id).pending, true);
  await assert.rejects(store.set(id, false), /pending/);
  assert.equal(store.revision(), 0);
  pending.resolve({ ok: true });
  await write;
  assert.equal(store.revision(), 1);
  assert.equal(store.snapshot(id).liked, true);
  const failed = createSongLikes({ catalog: async () => page(true), setLike: async () => { throw new Error("Network lost"); } });
  await failed.load(id);
  await assert.rejects(failed.set(id, false), /Network lost/);
  assert.equal(failed.snapshot(id).liked, true);
  assert.equal(failed.snapshot(id).pending, false);
  assert.equal(failed.snapshot(id).error, "Network lost");
  assert.equal(failed.revision(), 0);
});

test("hook interactions isolate account/track races and share song-options/player snapshots", async () => {
  const pending = deferred<{ ok: true }>();
  const apiA = { catalog: async () => page(false), setLike: async () => pending.promise } as unknown as MintApi;
  const apiB = { catalog: async () => page(false), setLike: async () => ({ ok: true }) } as unknown as MintApi;
  const hook = await harness(({ api, trackId }: { api: MintApi; trackId: string }) => useSongLike(api, trackId), { api: apiA, trackId: id });
  const observer = await harness(() => useSongLike(apiA, id), undefined);
  let mutation!: Promise<void>;
  await hook.act(() => { mutation = hook.current.set(true); });
  assert.equal(observer.current.pending, true);
  await hook.render({ api: apiB, trackId: other });
  assert.equal(hook.current.liked, false);
  await observer.act(async () => { pending.resolve({ ok: true }); await mutation; });
  assert.equal(observer.current.liked, true);
  assert.equal(hook.current.liked, false);
  assert.notEqual(songLikes(apiA), songLikes(apiB));
  await hook.unmount(); await observer.unmount();
});

test("lookup failure stays unavailable and can retry; cold snapshots retain at most 256 songs", async () => {
  let fail = true;
  const store = createSongLikes({ catalog: async () => { if (fail) throw new Error("Offline"); return page(false); }, setLike: async () => ({ ok: true }) });
  await store.load(id);
  assert.equal(store.snapshot(id).liked, null);
  assert.equal(store.snapshot(id).error, "Offline");
  fail = false;
  await store.load(id);
  assert.equal(store.snapshot(id).liked, false);
  for (let index = 0; index < 256; index++) await store.load(`song-${index}`);
  assert.equal(store.snapshot(id).liked, null);
  assert.equal(store.snapshot("song-255").liked, false);
});

test("unavailable like mutations explicitly reject instead of reporting success", async () => {
  const props: { api: MintApi | null; trackId?: string } = { api: null, trackId: id };
  const hook = await harness(({ api, trackId }: typeof props) => useSongLike(api, trackId), props);
  assert.equal(hook.current.available, false);
  await assert.rejects(hook.current.set(true), /unavailable/);
  const api = { catalog: async () => page(false), setLike: async () => ({ ok: true }) } as unknown as MintApi;
  await hook.render({ api });
  assert.equal(hook.current.available, false);
  await assert.rejects(hook.current.set(false), /unavailable/);
  await hook.unmount();
});
