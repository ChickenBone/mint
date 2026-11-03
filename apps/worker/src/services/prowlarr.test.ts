import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_INDEXERS, setupIndexers } from "./prowlarr";

interface Definition {
  name: string;
  definitionName: string;
  implementation: string;
  fields: Array<{ name: string; value?: unknown }>;
  enable?: boolean;
  protocol?: string;
  capabilities?: { categories: Array<{ id: number }> };
}

test("automatic music indexers preserve settings, report failures, and retry without leaking keys", async (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  Object.assign(process.env, {
    PROWLARR_URL: "http://prowlarr.test:9696", PROWLARR_API_KEY: "private-fixture-key",
    LIDARR_URL: "http://lidarr:8686", LIDARR_API_KEY: "private-lidarr-key",
  });
  delete process.env.AUTO_CONFIGURE_INDEXERS;
  delete process.env.PROWLARR_PUBLIC_INDEXERS;
  delete process.env.USENET_INDEXER_URL;
  delete process.env.USENET_INDEXER_API_KEY;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const sources: Definition[] = [{
    name: "My customized Archive", definitionName: "internetarchive", implementation: "Cardigann",
    fields: [{ name: "definitionFile", value: "internetarchive" }], enable: false,
  }];
  const original = JSON.stringify(sources[0]);
  const applications: Array<Record<string, unknown>> = [];
  const changes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let rejected = true;
  let requests = 0;
  let offline = false;
  const schemas = DEFAULT_INDEXERS.map((id) => ({
    name: id, definitionName: id, implementation: "Cardigann", privacy: "public", protocol: "torrent",
    indexerUrls: [`https://${id}.test/`], capabilities: { categories: [{ id: 3000 }] },
    fields: ["definitionFile", "baseUrl", "top100", "baseSettings.queryLimit", "baseSettings.grabLimit"].map((name) => ({
      name, value: name === "definitionFile" ? id : undefined,
    })),
  }));
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    requests++;
    if (offline) return Response.json({ message: "private-fixture-key" }, { status: 503 });
    const path = new URL(url).pathname.replace("/api/v1", "");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "private-fixture-key");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      changes.push({ path, body });
      if (path === "/indexer") {
        if (body.definitionName === "1337x" && rejected) return Response.json({ message: "private-fixture-key upstream failure" }, { status: 400 });
        sources.push(body);
      } else if (path === "/applications") applications.push(body);
      return Response.json({ id: 1 });
    }
    if (path === "/indexer/schema") return Response.json([
      ...schemas,
      { name: "Generic Newznab", definitionName: "Newznab", implementation: "Newznab", fields: [{ name: "baseUrl", value: "" }, { name: "apiKey" }, { name: "apiPath" }] },
      { name: "Private", definitionName: "private", privacy: "private" },
      { name: "NZBIndex", definitionName: "NZBIndex", privacy: "public", capabilities: { categories: [] } },
    ]);
    if (path === "/indexer") return Response.json(sources);
    if (path === "/appprofile") return Response.json([{ id: 3 }]);
    if (path === "/applications") return Response.json(applications);
    if (path === "/applications/schema") return Response.json([{
      name: "Lidarr", implementation: "Lidarr", fields: ["baseUrl", "prowlarrUrl", "apiKey", "syncCategories"].map((name) => ({ name })),
    }]);
    throw new Error(`Unexpected request: ${path}`);
  });
  const [notes, concurrentNotes] = await Promise.all([setupIndexers(), setupIndexers()]);
  assert.deepEqual(concurrentNotes, notes);
  assert.ok(notes.some((note) => note.includes("1337x")));
  assert.ok(notes.some((note) => note.includes("separate account")));
  assert.ok(!JSON.stringify(notes).includes("private-fixture-key"));
  assert.equal(JSON.stringify(sources[0]), original, "disabled/customized sources must not be re-enabled or overwritten");
  assert.equal(applications.length, 1);
  assert.equal(applications[0]!.syncLevel, "addOnly");
  const appFields = applications[0]!.fields as Definition["fields"];
  assert.equal(appFields.find((field) => field.name === "prowlarrUrl")!.value, "http://prowlarr.test:9696");
  assert.deepEqual(appFields.find((field) => field.name === "syncCategories")!.value, [3000, 3010, 3040, 3050, 3060]);
  const tpb = sources.find((source) => source.definitionName === "thepiratebay")!;
  assert.equal(tpb.fields.find((field) => field.name === "top100")!.value, 0);
  const count = requests;
  assert.deepEqual(await setupIndexers(), notes);
  assert.equal(requests, count, "setup must respect retry cooldown");
  now += 10 * 60_000 + 1;
  rejected = false;
  await setupIndexers();
  assert.equal(sources.filter((source) => source.definitionName === "1337x").length, 1);
  assert.equal(applications.length, 1);
  assert.ok(changes.some((change) => change.path === "/command" && change.body.name === "ApplicationIndexerSync"));
  now += 10 * 60_000 + 1;
  process.env.PROWLARR_PUBLIC_INDEXERS = "private,NZBIndex";
  process.env.USENET_INDEXER_URL = "https://usenet.test";
  process.env.USENET_INDEXER_API_KEY = "private-usenet-key";
  const extraNotes = await setupIndexers();
  assert.ok(extraNotes.some((note) => note.includes("private: no public music-category")));
  assert.ok(extraNotes.some((note) => note.includes("NZBIndex: no public music-category")));
  const usenet = sources.find((source) => source.implementation === "Newznab")!;
  assert.equal(usenet.fields.find((field) => field.name === "apiKey")!.value, "private-usenet-key");
  assert.equal(usenet.fields.find((field) => field.name === "baseUrl")!.value, "https://usenet.test");
  assert.equal(usenet.fields.find((field) => field.name === "apiPath")!.value, "/api");
  now += 10 * 60_000 + 1;
  await setupIndexers();
  assert.equal(sources.filter((source) => source.implementation === "Newznab").length, 1);
  now += 10 * 60_000 + 1;
  offline = true;
  const unavailable = await setupIndexers();
  assert.ok(unavailable.some((note) => note.includes("one minute")));
  assert.ok(!JSON.stringify(unavailable).includes("private-fixture-key"));
  const afterFailure = requests;
  now += 59_000;
  assert.deepEqual(await setupIndexers(), unavailable);
  assert.equal(requests, afterFailure);
  now += 2000;
  offline = false;
  await setupIndexers();
  assert.ok(requests > afterFailure);
  process.env.AUTO_CONFIGURE_INDEXERS = "false";
  const beforeDisable = requests;
  assert.deepEqual(await setupIndexers(), []);
  assert.equal(requests, beforeDisable);
});
