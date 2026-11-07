import assert from "node:assert/strict";
import test from "node:test";
import type { BrowseCategoryPage, BrowseFacet, CatalogPage, ChartDefinition, Discovery, DiscoveryMode } from "@mint/client";
import type { ResourcePage } from "../src/hooks/usePagedResource";
import { harness } from "./helpers/hook-harness";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Call = { start: number; signal: AbortSignal; reply: Deferred<ResourcePage<string>> };

test("paged resource follows the server cursor, ignores duplicate end-reached events and retries the failed page", async () => {
  const { usePagedResource } = await import("../src/hooks/usePagedResource");
  const calls: Call[] = [];
  const load = (start: number, signal: AbortSignal) => { const reply = deferred<ResourcePage<string>>(); calls.push({ start, signal, reply }); return reply.promise; };
  const view = await harness((key: string) => usePagedResource(load, (item) => item, [key]), "a");
  assert.deepEqual(calls.map((call) => call.start), [0]);
  assert.equal(view.current.loading, true);
  // Duplicates are de-duplicated for display but the next request still uses the server's cursor.
  calls[0]!.reply.resolve({ items: ["x", "x", "y"], total: 9, next: 3 });
  await view.flush();
  assert.deepEqual(view.current.items, ["x", "y"]);
  assert.equal(view.current.next, 3);
  await view.act(() => { view.current.loadMore(); view.current.loadMore(); });
  await view.act(() => view.current.loadMore());
  assert.deepEqual(calls.map((call) => call.start), [0, 3]);
  assert.equal(calls[1]!.signal.aborted, false);
  calls[1]!.reply.reject(Object.assign(new Error("Server unavailable"), { status: 503 }));
  await view.flush();
  assert.equal(view.current.error, "Server unavailable");
  assert.equal(view.current.status, 503);
  assert.deepEqual(view.current.items, ["x", "y"]);
  await view.act(() => view.current.loadMore());
  assert.equal(calls.length, 2, "load more stays paused until retry");
  await view.act(() => view.current.retry());
  assert.deepEqual(calls.map((call) => call.start), [0, 3, 3]);
  calls[2]!.reply.resolve({ items: ["y", "z"], total: 9, next: 3 });
  await view.flush();
  assert.deepEqual(view.current.items, ["x", "y", "z"]);
  assert.equal(view.current.next, null, "a cursor that does not advance ends paging");
  await view.unmount();
});

test("paged resource discards late pages from previous keys and aborts them", async () => {
  const { usePagedResource } = await import("../src/hooks/usePagedResource");
  const calls: (Call & { key: string })[] = [];
  const view = await harness((key: string) => usePagedResource((start, signal) => {
    const reply = deferred<ResourcePage<string>>(); calls.push({ key, start, signal, reply }); return reply.promise;
  }, (item) => item, [key]), "old" as string);
  await view.render("new");
  assert.equal(calls[0]!.signal.aborted, true);
  calls[0]!.reply.resolve({ items: ["stale"], total: 1, next: null });
  calls[1]!.reply.resolve({ items: ["fresh"], total: 1, next: null });
  await view.flush();
  assert.deepEqual(view.current.items, ["fresh"]);
  const conflict = await harness(() => usePagedResource(() => Promise.reject(Object.assign(new Error("Still preparing"), { status: 409 })), (item: string) => item, ["chart"]), null);
  assert.equal(conflict.current.status, 409);
  await conflict.unmount();
  await view.unmount();
});

type Request = { kind: string; signal?: AbortSignal; reply: Deferred<unknown> };
function fakeApi(name: string) {
  const requests: Request[] = [];
  const pending = <T>(kind: string, signal?: AbortSignal) => { const reply = deferred<unknown>(); requests.push({ kind, signal, reply }); return reply.promise as Promise<T>; };
  const api = {
    name, requests,
    discover: (mode: DiscoveryMode = "for-you", signal?: AbortSignal) => pending<Discovery>(`mix:${mode}`, signal),
    catalog: (_query: unknown, signal?: AbortSignal) => pending<CatalogPage>("albums", signal),
    charts: (signal?: AbortSignal) => pending<{ charts: ChartDefinition[] }>("charts", signal),
    browseCategories: (facet: BrowseFacet, offset = 0, _size = 24, signal?: AbortSignal) => pending<BrowseCategoryPage>(`facet:${facet}:${offset}`, signal),
  };
  const take = (kind: string) => { const index = requests.findIndex((request) => request.kind === kind); assert.ok(index >= 0, `missing ${kind}`); return requests.splice(index, 1)[0]!; };
  return { api, take };
}
const facetPage = (facet: BrowseFacet, offset: number, nextOffset: number | null, count: number): BrowseCategoryPage => ({
  facet, offset, nextOffset, total: 99, items: Array.from({ length: count }, (_, index) => ({ value: `${facet}-${offset + index}`, label: `${offset + index}`, tracks: 1, artwork: null })),
});

test("browse catalog keeps sections independent, reports failures and retries only failed sources", async () => {
  const { useBrowseCatalog } = await import("../src/features/search/useBrowseCatalog");
  const { api, take } = fakeApi("one");
  const view = await harness((value: typeof api) => useBrowseCatalog(value, 2), api);
  assert.deepEqual(api.requests.map((request) => request.kind).sort(), ["albums", "charts", "facet:decade:0", "mix:for-you", "mix:recent", "mix:rediscover"]);
  take("mix:for-you").reply.resolve({ mode: "for-you", items: [{ item: { thumb: "/a" } }] });
  take("charts").reply.reject(Object.assign(new Error("Sign in again"), { status: 401 }));
  await view.flush();
  assert.equal(view.current.states["mix:for-you" as never], undefined);
  assert.equal(view.current.states["for-you"].status, "ready");
  assert.deepEqual(view.current.states.charts, { status: "error", error: "Sign in again" });
  assert.equal(view.current.states.recent.status, "loading");
  await view.act(() => view.current.retrySources(["charts", "recent"]));
  assert.deepEqual(api.requests.map((request) => request.kind).sort(), ["albums", "charts", "facet:decade:0", "mix:recent", "mix:rediscover"]);
  assert.equal(view.current.states.charts.status, "loading");
  assert.equal(view.current.states["for-you"].status, "ready", "successful sections stay visible during retry");
  await view.unmount();
});

test("browse catalog pages facets once at a time and resets everything when the server changes", async () => {
  const { useBrowseCatalog } = await import("../src/features/search/useBrowseCatalog");
  const first = fakeApi("first");
  const view = await harness((value: typeof first.api) => useBrowseCatalog(value, 2), first.api);
  const decade = first.take("facet:decade:0");
  await view.act(() => { view.current.loadMore(); view.current.loadMore(); });
  assert.equal(first.api.requests.filter((request) => request.kind.startsWith("facet:")).length, 0, "no duplicate page while one is in flight");
  decade.reply.resolve(facetPage("decade", 0, 1, 1));
  await view.flush();
  assert.equal(view.current.facets.decade?.length, 1);
  const pending = first.take("facet:decade:1");
  const sourceSignals = first.api.requests.map((request) => request.signal!);
  const second = fakeApi("second");
  await view.render(second.api);
  assert.ok(pending.signal!.aborted, "in-flight category page is aborted");
  assert.ok(sourceSignals.every((signal) => signal.aborted), "previous server source requests are aborted");
  assert.deepEqual(view.current.facets, {}, "old server categories are not shown for the new server");
  assert.equal(view.current.states["for-you"].status, "loading");
  pending.reply.resolve(facetPage("decade", 1, null, 3));
  for (const request of first.api.requests) request.reply.resolve({ mode: "for-you", items: [{ item: {} }] });
  await view.flush();
  assert.deepEqual(view.current.facets, {});
  assert.equal(view.current.states["for-you"].status, "loading");
  second.take("facet:decade:0").reply.resolve(facetPage("decade", 0, null, 1));
  await view.flush();
  second.take("facet:mood:0").reply.reject(new Error("Server unavailable"));
  await view.flush();
  assert.equal(view.current.facetsError, "Server unavailable");
  assert.deepEqual(view.current.facets.decade?.map((item) => item.offset), [0]);
  await view.act(() => view.current.loadMore(true));
  assert.ok(second.api.requests.some((request) => request.kind === "facet:mood:0"));
  await view.unmount();
});
