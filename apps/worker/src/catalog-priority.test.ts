import assert from "node:assert/strict";
import { test } from "node:test";
import { syncCatalogPriority } from "./catalog-priority";

const mbid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test("priority batches survive restarts, progress beyond 100 artists, reconcile removals and replay failed acknowledgements", async () => {
  let library = Array.from({ length: 125 }, (_, i) => mbid(i + 1));
  let state = { addAfter: "", removeAfter: "" };
  const acknowledged = new Set<string>();
  const remote = new Set<string>();
  const batches: { add: string[]; remove: string[] }[] = [];
  let unavailable = false, stateFailure = false;
  const bridge = {
    async priority(add: string[], remove: string[]) {
      if (unavailable) throw new Error("Fixture upstream unavailable");
      assert.ok(add.length <= 50 && remove.length <= 50);
      assert.equal(new Set([...add, ...remove]).size, add.length + remove.length);
      batches.push({ add, remove });
      add.forEach((id) => remote.add(id)); remove.forEach((id) => remote.delete(id));
    },
  };
  const store = () => ({
    state: async () => state,
    current: async (after: string) => library.filter((id) => id > after).slice(0, 50),
    acknowledged: async (after: string) => [...acknowledged].sort().filter((id) => id > after).slice(0, 50),
    retained: async (ids: string[]) => ids.filter((id) => library.includes(id)),
    async save(add: string[], remove: string[], next: typeof state) {
      if (stateFailure) throw new Error("Fixture Redis unavailable");
      add.forEach((id) => acknowledged.add(id)); remove.forEach((id) => acknowledged.delete(id));
      state = next;
    },
  });
  await syncCatalogPriority(bridge, store());
  await syncCatalogPriority(bridge, store()); // Fresh store instance models process restart.
  const before = { ...state };
  unavailable = true;
  await assert.rejects(syncCatalogPriority(bridge, store()), /upstream unavailable/);
  assert.deepEqual(state, before);
  assert.equal(remote.size, 100);
  unavailable = false; stateFailure = true;
  await assert.rejects(syncCatalogPriority(bridge, store()), /Redis unavailable/);
  assert.deepEqual(state, before);
  stateFailure = false;
  await syncCatalogPriority(bridge, store());
  assert.equal(remote.size, 125);
  assert.equal(acknowledged.size, 125);
  library = library.filter((id) => ![mbid(1), mbid(80), mbid(120)].includes(id));
  for (let i = 0; i < 4; i++) await syncCatalogPriority(bridge, store());
  assert.equal(remote.size, 122);
  assert.deepEqual([...remote].sort(), library);
  assert.ok(batches.some(({ remove }) => remove.includes(mbid(120))));
});

test("a failed library read never turns into a removal feed or advances acknowledged state", async () => {
  let requests = 0, saved = false;
  await assert.rejects(syncCatalogPriority({ priority: async () => { requests++; } }, {
    state: async () => ({ addAfter: "", removeAfter: "" }),
    current: async () => { throw new Error("Fixture DB unavailable"); },
    acknowledged: async () => [mbid(1)],
    retained: async () => [],
    save: async () => { saved = true; },
  }), /DB unavailable/);
  assert.equal(requests, 0);
  assert.equal(saved, false);
});
