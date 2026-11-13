import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { fetchTargetLibraryPage } from "../src/components/app/target-library-browser";

const item = {
  id: "00000000-0000-4000-8000-000000000001",
  recordingId: null,
  title: "Fixture song",
  artist: "Fixture artist",
  album: "Fixture album",
  version: null,
  durationMs: 125_000,
};

test("target Library browser requests bounded verified-file pages and validates the response", async () => {
  const response = { items: [item], nextCursor: "cGFnZQ" };
  const fetcher = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "/api/library/files?limit=50&search=caf%C3%A9+song&cursor=cGFnZQ");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "same-origin");
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json(response);
  });
  try {
    assert.deepEqual(await fetchTargetLibraryPage("café song", "cGFnZQ", new AbortController().signal), response);
    assert.equal(fetcher.mock.callCount(), 1);
  } finally {
    fetcher.mock.restore();
  }
});

test("target Library browser rejects malformed API data and shows safe errors", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => Response.json({
    items: [{ ...item, path: "/private/music/song.flac" }], nextCursor: null,
  }));
  try {
    await assert.rejects(fetchTargetLibraryPage("", null, new AbortController().signal), /invalid response/);
    fetcher.mock.mockImplementation(async () => new Response(null, { status: 503 }));
    await assert.rejects(fetchTargetLibraryPage("", null, new AbortController().signal), /temporarily unavailable/);
    fetcher.mock.mockImplementation(async () => new Response(null, { status: 500 }));
    await assert.rejects(fetchTargetLibraryPage("", null, new AbortController().signal), /could not load/);
  } finally {
    fetcher.mock.restore();
  }
});
