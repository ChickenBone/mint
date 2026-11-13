import assert from "node:assert/strict";
import { test } from "node:test";
import { createMintSdk, MintSdkError } from "../src/index";

const id = "00000000-0000-4000-8000-000000000001";
const options = { url: "http://fixture.test/trpc", gatewayToken: "a".repeat(42) + "A" };
const historyPage = {
  entries: [{
    event: { id, createdAt: "2025-01-01T00:00:00.000Z", listenedMs: 90_000, completed: true },
    track: {
      id, recordingId: null, title: "Fixture", artist: "Fixture artist",
      album: "Fixture album", version: null, durationMs: 120_000,
    },
  }],
};
const response = (data: unknown) => new Response(JSON.stringify({ result: { data } }), {
  headers: { "content-type": "application/json" },
});
const category = (code: string) => (error: unknown) => error instanceof MintSdkError && error.code === code;

test("history SDK validates contracts and uses private authenticated procedures", async () => {
  const paths: string[] = [];
  const sdk = createMintSdk({
    ...options,
    sessionToken: "b".repeat(42) + "A",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname.slice("/trpc/".length));
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-mint-gateway-token"), options.gatewayToken);
      assert.equal(headers.get("cookie"), `mint_session=${"b".repeat(42)}A`);
      assert.equal(headers.get("x-forwarded-for"), null);
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      if (url.pathname.endsWith(".list")) return response(historyPage);
      if (url.pathname.endsWith(".record")) return response({ recorded: true });
      if (url.pathname.endsWith(".privateSession")) return response(true);
      return response(null);
    },
  });
  assert.deepEqual(await sdk.playback.history.list({ page: 0 }), historyPage);
  assert.deepEqual(await sdk.playback.history.record({
    eventId: id, mediaFileId: id, listenedMs: 90_000,
  }), { recorded: true });
  assert.equal(await sdk.playback.history.privateSession(), true);
  await sdk.playback.history.setPrivateSession({ privateSession: false });
  await sdk.playback.history.delete({ entryId: id });
  assert.deepEqual(paths, [
    "playback.history.list", "playback.history.record", "playback.history.privateSession",
    "playback.history.setPrivateSession", "playback.history.delete",
  ]);
  await assert.rejects(sdk.playback.history.list({ page: 10_001 }), category("INVALID_INPUT"));
  await assert.rejects(sdk.playback.history.record({
    eventId: id, mediaFileId: id, listenedMs: 86_400_001,
  }), category("INVALID_INPUT"));
});

test("history SDK rejects malformed responses and sanitizes RPC failures", async () => {
  const malformed = createMintSdk({ ...options, fetch: async () => response({ entries: [{ userId: id }] }) });
  await assert.rejects(malformed.playback.history.list(), category("INCOMPATIBLE_RESPONSE"));
  const failed = createMintSdk({ ...options, fetch: async () => new Response("private database data", { status: 500 }) });
  await assert.rejects(failed.playback.history.delete(), category("RPC_ERROR"));
});
