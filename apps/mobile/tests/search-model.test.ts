import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogPage, CatalogQuery, PlayerItem } from "@mint/client";
import { isCurrentSearch, uniqueRecordings } from "../src/features/search/search-model";
import { useLocalSearchPage } from "../src/features/search/useLocalSearchPage";
import { harness } from "./helpers/hook-harness";

test("search ignores stale and aborted responses", () => {
  assert.equal(isCurrentSearch("old", "new"), false);
  assert.equal(isCurrentSearch("same", "same", true), false);
  assert.equal(isCurrentSearch("same", "same"), true);
});

test("mixed search suppresses only conservatively confirmed recordings", () => {
  const local = [{ id: "local", type: "track" as const, title: "Écho", artist: "A Band", album: "First", duration: 180000 }];
  const matches = [
    { id: "same", title: "Echo", artist: "A Band", album: "First", durationSec: 180 },
    { id: "live", title: "Echo", artist: "A Band", album: "Live", durationSec: 180 },
    { id: "unknown", title: "Echo", artist: "A Band", album: "First", durationSec: null },
    { id: "long", title: "Echo", artist: "A Band", album: "First", durationSec: 240 },
  ];
  assert.deepEqual(uniqueRecordings(local, matches).map((item) => item.id), ["live", "unknown", "long"]);
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type SearchCall = { query: CatalogQuery; signal?: AbortSignal; reply: Deferred<CatalogPage> };
function fakeSearchApi(name: string) {
  const calls: SearchCall[] = [];
  let acquisitionRequests = 0;
  return {
    name,
    calls,
    get acquisitionRequests() { return acquisitionRequests; },
    catalog(query: CatalogQuery, signal?: AbortSignal) {
      const reply = deferred<CatalogPage>();
      calls.push({ query, signal, reply });
      return reply.promise;
    },
    requestRecording() { acquisitionRequests += 1; },
  };
}
const track = (id: string): PlayerItem => ({ id, type: "track", title: id });
const catalogPage = (start: number, total: number, ids: string[]): CatalogPage => ({
  start, total, items: ids.map(track),
});

test("local search reaches matches beyond each initial bound and retains only one page", async () => {
  for (const { type, size } of [
    { type: "track" as const, size: 50 },
    { type: "album" as const, size: 18 },
    { type: "artist" as const, size: 18 },
  ]) {
    const api = fakeSearchApi(type);
    const props = { api, type, query: "mint", size };
    const view = await harness((value: typeof props) => useLocalSearchPage(
      (start, pageSize, signal) => value.api.catalog({ type: value.type, q: value.query, start, size: pageSize }, signal),
      value.size, [value.api, value.query, value.type], true,
    ), props);
    assert.deepEqual(api.calls[0]?.query, { type, q: "mint", start: 0, size });
    api.calls[0]!.reply.resolve(catalogPage(0, size + 1, Array.from({ length: size + 3 }, (_, index) => `${type}-${index + 1}`)));
    await view.flush();
    assert.equal(view.current.items.length, size);
    assert.equal(view.current.next, size);
    await view.act(() => view.current.loadMore());
    assert.deepEqual(api.calls[1]?.query, { type, q: "mint", start: size, size });
    api.calls[1]!.reply.resolve(catalogPage(size, size + 1, [`${type}-${size + 1}`]));
    await view.flush();
    assert.equal(view.current.items[0]?.id, `${type}-${size + 1}`);
    assert.equal(view.current.items.length, 1, "the previous page is replaced rather than retained");
    assert.equal(view.current.next, null);
    assert.equal(api.acquisitionRequests, 0, "search paging never triggers acquisition");
    await view.unmount();
  }
});

test("local search ignores duplicate paging actions, keeps results on retry, and ends honestly", async () => {
  const api = fakeSearchApi("one");
  const view = await harness((query: string) => useLocalSearchPage(
    (start, size, signal) => api.catalog({ type: "track", q: query, start, size }, signal), 2, [api, query], true,
  ), "same");
  api.calls[0]!.reply.resolve(catalogPage(0, 5, ["a", "b"]));
  await view.flush();
  await view.act(() => { view.current.loadMore(); view.current.loadMore(); });
  assert.equal(api.calls.length, 2, "repeated actions share the one in-flight request");
  assert.equal(api.calls[1]!.query.start, 2);
  api.calls[1]!.reply.reject(new Error("Page unavailable"));
  await view.flush();
  assert.equal(view.current.error, "Page unavailable");
  assert.deepEqual(view.current.items.map((item) => item.id), ["a", "b"]);
  await view.act(() => view.current.loadMore());
  assert.equal(api.calls.length, 2, "a failed page waits for explicit retry");
  await view.act(() => view.current.retry());
  assert.equal(api.calls[2]!.query.start, 2);
  api.calls[2]!.reply.resolve(catalogPage(2, 5, ["c", "c"]));
  await view.flush();
  assert.deepEqual(view.current.items.map((item) => item.id), ["c"], "duplicate items within a page are removed");
  assert.equal(view.current.next, 4);
  await view.act(() => view.current.loadMore());
  api.calls[3]!.reply.resolve(catalogPage(4, 5, ["e"]));
  await view.flush();
  assert.equal(view.current.next, null);
  const callsAtEnd = api.calls.length;
  await view.act(() => view.current.loadMore());
  assert.equal(api.calls.length, callsAtEnd, "no request is issued after the final result");
  await view.unmount();
});

test("local search aborts and rejects late pages after query or server changes", async () => {
  const first = fakeSearchApi("first");
  const second = fakeSearchApi("second");
  const props = { api: first, query: "old" };
  const view = await harness((value: typeof props) => useLocalSearchPage(
    (start, size, signal) => value.api.catalog({ type: "track", q: value.query, start, size }, signal),
    2, [value.api, value.query], true,
  ), props);
  await view.render({ api: first, query: "new" });
  assert.equal(first.calls[0]!.signal?.aborted, true);
  first.calls[0]!.reply.resolve(catalogPage(0, 1, ["stale-query"]));
  first.calls[1]!.reply.resolve(catalogPage(0, 3, ["new-query", "next-query"]));
  await view.flush();
  assert.deepEqual(view.current.items.map((item) => item.id), ["new-query", "next-query"]);
  await view.act(() => view.current.loadMore());
  assert.equal(first.calls[2]!.query.start, 2);
  await view.render({ api: second, query: "new" });
  assert.equal(first.calls[2]!.signal?.aborted, true);
  first.calls[2]!.reply.resolve(catalogPage(2, 3, ["stale-server"]));
  second.calls[0]!.reply.resolve(catalogPage(0, 1, ["new-server"]));
  await view.flush();
  assert.deepEqual(view.current.items.map((item) => item.id), ["new-server"]);
  await view.unmount();
});
