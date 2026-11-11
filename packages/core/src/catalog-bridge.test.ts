import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { CatalogBridge, CatalogBridgeError, configuredCatalogBridge } from "./catalog-bridge";

const id = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const token = "fixture-only-not-a-production-token-12345";
const entry = (key = id) => ({ id: key, title: "Fixture album", artist: "Fixture artist", url: `https://musicbrainz.org/release-group/${key}` });

test("catalog transport is optional and rejects unsafe/private-credential URLs", () => {
  assert.equal(configuredCatalogBridge({}), null);
  for (const url of ["http://mint-catalog-bridge:8080", "https://user:password@example.com", "https://example.com/path",
    "https://example.com?token=x", "https://example.com#x", "ftp://example.com"]) {
    assert.throws(() => new CatalogBridge(url, token), CatalogBridgeError);
  }
  assert.throws(() => configuredCatalogBridge({ CATALOG_BRIDGE_URL: "https://example.com" }), CatalogBridgeError);
  assert.throws(() => configuredCatalogBridge({ CATALOG_BRIDGE_TOKEN: token }), CatalogBridgeError);
  assert.throws(() => new CatalogBridge("https://example.com", `${token}\r\n`), CatalogBridgeError);
  assert.throws(() => new CatalogBridge("https://example.com", "x".repeat(257)), CatalogBridgeError);
});

test("real loopback HTTP bridge sends only bounded IDs, canonical keyset pages and private bearer headers", async () => {
  const requests: { path: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers["cache-control"], "no-store");
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url!, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.method === "POST" ? { added: 0, removed: 0 } :
      { items: [entry(second)], next_cursor: second }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const bridge = new CatalogBridge(`http://127.0.0.1:${address.port}`, token);
    const page = await bridge.page("artists", id, id, 1);
    assert.equal(page.next_cursor, second);
    await bridge.priority([id], [second]);
    assert.deepEqual(requests, [
      { path: `/v1/artists/${id}/albums?limit=1&after=${id}`, body: "" },
      { path: "/v1/priority/artists", body: JSON.stringify({ add: [id], remove: [second] }) },
    ]);
    await assert.rejects(bridge.priority([id], [id]), /Invalid catalog priority/);
    await assert.rejects(bridge.priority(Array(101).fill(id), []), /Invalid catalog priority/);
    await assert.rejects(bridge.page("artists", "artist name"), /Invalid/);
    await assert.rejects(bridge.page("artists", id, null, 101), /Too big/);
    assert.equal(requests.length, 2, "invalid input is rejected before transport");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("catalog pages reject cross-source IDs/URLs, invalid cursors, oversized and reordered results", async () => {
  const badPages = [
    { items: [{ ...entry(), url: "https://example.com/private" }], next_cursor: null },
    { items: [{ ...entry(), id: "123" }], next_cursor: null },
    { items: [entry()], next_cursor: second },
    { items: [entry(second), entry()], next_cursor: null },
    { items: [entry(), entry()], next_cursor: null },
    { items: [], next_cursor: id },
    { items: [entry()], next_cursor: null, token: "never expose upstream extras" },
  ];
  for (const bad of badPages) {
    const bridge = new CatalogBridge("https://example.com", token, async () => Response.json(bad));
    await assert.rejects(bridge.page("artists", id), CatalogBridgeError);
  }
  const bridge = new CatalogBridge("https://example.com", token,
    async () => new Response("x".repeat(1_000_001), { headers: { "content-type": "application/json" } }));
  await assert.rejects(bridge.page("artists", id), CatalogBridgeError);
});

test("upstream failures remain redacted errors, never empty success; caller cancellation remains cancellation", async () => {
  for (const status of [401, 404, 429, 500, 503]) {
    const bridge = new CatalogBridge("https://example.com", token, async () => Response.json({ secret: token }, { status }));
    await assert.rejects(bridge.page("artists", id), (error: unknown) =>
      error instanceof CatalogBridgeError && error.kind === (status === 404 ? "not-found" : "unavailable") &&
      !error.message.includes(token) && !error.message.includes("example.com"));
  }
  const bridge = new CatalogBridge("https://example.com", token, async (_url, init) => {
    assert.equal(init?.redirect, "error");
    throw new Error(`secret: ${token}`);
  });
  await assert.rejects(bridge.page("artists", id), CatalogBridgeError);
  const controller = new AbortController();
  controller.abort(new Error("Cancelled fixture"));
  await assert.rejects(bridge.page("artists", id, null, 50, controller.signal), /Cancelled fixture/);
});

test("a stalled upstream body is cancelled at the five-second deadline", async () => {
  let cancelled = false;
  const bridge = new CatalogBridge("https://example.com", token, async () => new Response(
    new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { "content-type": "application/json" } },
  ));
  const started = Date.now();
  // Keep the test alive while AbortSignal.timeout's unreferenced timer is pending.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(bridge.page("artists", id), CatalogBridgeError);
    assert.equal(cancelled, true);
    assert.ok(Date.now() - started >= 4500 && Date.now() - started < 8000);
  } finally { clearInterval(keepAlive); }
});
