import assert from "node:assert/strict";
import { test } from "node:test";
import { createMintSdk, MintSdkError } from "../src/index";

const gatewayToken = "a".repeat(42) + "A";
const sessionToken = "b".repeat(42) + "A";
const queueId = "00000000-0000-4000-8000-000000000001";
const mediaFileId = "00000000-0000-4000-8000-000000000002";
const entryId = "00000000-0000-4000-8000-000000000003";
const itemId = "00000000-0000-4000-8000-000000000004";
const queuePage = {
  context: { id: queueId, total: 1, revision: 1, offset: 0, position: 0, shuffle: false },
  items: [{
    id: itemId, recordingId: null, title: "Track", artist: "Artist",
    album: "Album", version: null, durationMs: 10_000, queueId: entryId,
  }],
};
const rpc = (data: unknown) => Response.json({ result: { data } });
const errorCode = (code: string) => (error: unknown) => error instanceof MintSdkError && error.code === code;

test("queue SDK validates inputs, sends only explicit credentials and checks page responses", async () => {
  const calls: { path: string; input: unknown; cookie: string | null }[] = [];
  let value: unknown = queuePage;
  const sdk = createMintSdk({
    url: "http://fixture.test/trpc", gatewayToken, sessionToken,
    fetch: async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname.slice("/trpc/".length),
        input: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        cookie: new Headers(init?.headers).get("cookie"),
      });
      assert.equal(new Headers(init?.headers).get("x-user-role"), null);
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      return rpc(value);
    },
  });
  const open = { selection: { source: "items" as const, items: [{ mediaFileId }] }, shuffle: false };
  assert.deepEqual(await sdk.playback.queue.open(open), queuePage);
  assert.deepEqual(await sdk.playback.queue.page(queueId, { position: 0 }), queuePage);
  const edit = { revision: 1, currentEntryId: entryId, edit: { action: "clear" as const } };
  assert.deepEqual(await sdk.playback.queue.edit(queueId, edit), queuePage);
  assert.deepEqual(calls, [
    { path: "playback.queue.open", input: open, cookie: `mint_session=${sessionToken}` },
    { path: "playback.queue.page", input: { queueId, position: 0 }, cookie: `mint_session=${sessionToken}` },
    { path: "playback.queue.edit", input: { queueId, ...edit }, cookie: `mint_session=${sessionToken}` },
  ]);

  for (const malformed of [
    { ...open, actor: { role: "admin" } },
    { ...open, selection: { source: "items", items: [] } },
  ]) await assert.rejects(sdk.playback.queue.open(malformed as never), errorCode("INVALID_INPUT"));
  await assert.rejects(sdk.playback.queue.page(queueId, { position: -1 }), errorCode("INVALID_INPUT"));
  await assert.rejects(sdk.playback.queue.edit(queueId, { ...edit, revision: 0 }), errorCode("INVALID_INPUT"));
  assert.equal(calls.length, 3, "invalid SDK arguments do not reach transport");

  for (const malformed of [null, {}, { ...queuePage, items: new Array(101).fill(queuePage.items[0]) }]) {
    value = malformed;
    await assert.rejects(sdk.playback.queue.page(queueId, { position: 0 }), errorCode("INCOMPATIBLE_RESPONSE"));
  }
});

test("queue SDK sanitizes RPC/transport errors and preserves abort reasons", async () => {
  const network = createMintSdk({
    url: "http://fixture.test/trpc", gatewayToken,
    fetch: async () => { throw new Error("private db password"); },
  });
  await assert.rejects(network.playback.queue.page(queueId, { position: 0 }), errorCode("TRANSPORT_ERROR"));
  const failed = createMintSdk({
    url: "http://fixture.test/trpc", gatewayToken,
    fetch: async () => new Response("private db password", { status: 500 }),
  });
  await assert.rejects(failed.playback.queue.open({
    selection: { source: "items", items: [{ mediaFileId }] }, shuffle: false,
  }), errorCode("RPC_ERROR"));

  const reason = new Error("queue request aborted");
  const controller = new AbortController();
  controller.abort(reason);
  const cancelled = createMintSdk({
    url: "http://fixture.test/trpc", gatewayToken,
    fetch: async () => { assert.fail("aborted requests must not fetch"); },
  });
  await assert.rejects(cancelled.playback.queue.page(queueId, { position: 0 }, { signal: controller.signal }),
    (error) => error === reason);
});
