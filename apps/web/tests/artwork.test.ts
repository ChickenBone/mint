import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { verifyToken } from "@mint/core/crypto";
import { trackArtworkUrl } from "@mint/core/artwork";
import { GET, HEAD } from "../src/app/api/artwork/[id]/route";

test("public artwork proxies only signed track-specific image requests without leaking private configuration", async (t) => {
  const signing = process.env.MINT_SIGNING_SECRET, worker = process.env.PLAYBACK_WORKER_URL;
  process.env.MINT_SIGNING_SECRET = "test-only-artwork-signing-secret-not-for-production";
  process.env.PLAYBACK_WORKER_URL = "http://private-worker:8080";
  t.after(() => {
    if (signing === undefined) delete process.env.MINT_SIGNING_SECRET; else process.env.MINT_SIGNING_SECRET = signing;
    if (worker === undefined) delete process.env.PLAYBACK_WORKER_URL; else process.env.PLAYBACK_WORKER_URL = worker;
  });
  const id = randomUUID(), params = Promise.resolve({ id }), png = Buffer.from([137, 80, 78, 71]);
  let calls = 0, status = 200, type = "image/png";
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    calls++;
    assert.equal(input, `http://private-worker:8080/artwork/${id}`);
    const token = new Headers(init?.headers).get("authorization")?.slice(7);
    assert.equal(verifyToken<{ trackId: string }>("artwork", token)?.trackId, id);
    assert.equal(verifyToken("playback", token), null);
    assert.equal(init?.redirect, "error");
    return new Response(init?.method === "HEAD" || status !== 200 ? null : png, { status,
      headers: { "content-type": type, "content-length": "4", "cache-control": "public, max-age=3600", etag: '"fixture"',
        "x-mint-cache-age": "86410", "x-mint-cache-status": "stale" } });
  });
  const response = await GET(new Request(`https://mint.example/api/artwork/${id}`), { params });
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-mint-cache-age"), "86410");
  assert.equal(response.headers.get("x-mint-cache-status"), "stale");
  assert.ok(!JSON.stringify([...response.headers]).includes("private-worker"));
  const notModified = await GET(new Request(`https://mint.example/api/artwork/${id}`, { headers: { "if-none-match": '"fixture"' } }), { params });
  assert.equal(notModified.status, 304); assert.equal(await notModified.text(), "");
  const head = await HEAD(new Request(`https://mint.example/api/artwork/${id}`, { method: "HEAD" }), { params });
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
  assert.equal((await GET(new Request("https://mint.example/api/artwork/no"), { params: Promise.resolve({ id: "no" }) })).status, 400);
  assert.equal(calls, 3);
  for (status of [404, 401, 503]) {
    const failure = await GET(new Request(`https://mint.example/api/artwork/${id}`), { params });
    assert.equal(failure.status, status === 404 ? 404 : 503);
    assert.equal(failure.headers.get("cache-control"), "no-store");
  }
  status = 200; type = "text/html";
  assert.equal((await GET(new Request(`https://mint.example/api/artwork/${id}`), { params })).status, 502);
  assert.equal(trackArtworkUrl({ id, plexRatingKey: "42", artworkUrl: null, youtubeVideoId: null, mbReleaseGroupId: null }), `/api/artwork/${id}`);
  assert.equal(trackArtworkUrl({ id, plexRatingKey: null, artworkUrl: null, youtubeVideoId: null, mbReleaseGroupId: null }), "");
});
