import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  GATEWAY_TOKEN_HEADER_NAME,
  type PlaybackQueuePage,
} from "@mint/contracts";
import { PlaybackQueueError, type PlaybackQueueRepository } from "@mint/domain-playback";
import { createMintSdk, MintSdkError } from "@mint/sdk";
import { createApiServer } from "../src/server";

const gatewayToken = randomBytes(32).toString("base64url");
const sessionToken = "fixture_browser_session_token";
const hash = createHash("sha256").update(sessionToken).digest("hex");
const userId = "00000000-0000-4000-8000-000000000001";
const queueId = "00000000-0000-4000-8000-000000000002";
const entryId = "00000000-0000-4000-8000-000000000003";
const mediaFileId = "00000000-0000-4000-8000-000000000004";
const page: PlaybackQueuePage = {
  context: { id: queueId, revision: 1, total: 1, shuffle: false, offset: 0, position: 0 },
  items: [{
    id: mediaFileId, recordingId: null, title: "Track", artist: "Artist",
    album: "Album", version: null, durationMs: 120_000, queueId: entryId,
  }],
};

test("queue API authorizes fresh persisted members, scopes repository calls, and maps errors safely", async (t) => {
  const calls: unknown[][] = [];
  let actorStatus: "active" | "disabled" = "active";
  let repositoryError: PlaybackQueueError | undefined;
  const repository: PlaybackQueueRepository = {
    async open(actor, input) {
      calls.push(["open", actor, input]);
      if (repositoryError) throw repositoryError;
      return page;
    },
    async page(actor, id, position) {
      calls.push(["page", actor, id, position]);
      if (repositoryError) throw repositoryError;
      return page;
    },
    async edit(actor, id, input) {
      calls.push(["edit", actor, id, input]);
      if (repositoryError) throw repositoryError;
      return page;
    },
  };
  const app = createApiServer({
    gatewayToken,
    sessions: {
      async findByTokenHash(value) {
        return value === hash ? {
          expiresAt: new Date(Date.now() + 60_000),
          principal: {
            id: userId, email: "member@example.test", name: "Member", role: "user", status: actorStatus,
          },
        } : null;
      },
    },
    decisions: { decidePendingAccess: async () => {}, countPending: async () => 0 },
    playbackQueues: repository,
    notifyAccessRequests: async () => {},
    errors: { error: () => {} },
  });
  t.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const sdk = createMintSdk({ url: `${address}/trpc`, gatewayToken, sessionToken });

  assert.deepEqual(await sdk.playback.queue.open({
    selection: { source: "items", items: [{ mediaFileId }] }, shuffle: false,
  }), page);
  assert.deepEqual(await sdk.playback.queue.page(queueId, { position: 0 }), page);
  assert.deepEqual(await sdk.playback.queue.edit(queueId, {
    revision: 1, currentEntryId: entryId, edit: { action: "clear" },
  }), page);
  assert.deepEqual(calls, [
    ["open", userId, { selection: { source: "items", items: [{ mediaFileId }] }, shuffle: false }],
    ["page", userId, queueId, 0],
    ["edit", userId, queueId, { revision: 1, currentEntryId: entryId, edit: { action: "clear" } }],
  ]);
  assert.equal((await fetch(`${address}/trpc/playback.queue.open`, {
    method: "POST",
    headers: {
      [GATEWAY_TOKEN_HEADER_NAME]: gatewayToken, "content-type": "application/json",
      "x-user-id": "00000000-0000-4000-8000-000000000099", "x-user-role": "admin",
    },
    body: JSON.stringify({ selection: { source: "items", items: [{ mediaFileId }] }, shuffle: false }),
  })).status, 401);
  const callsBefore = calls.length;
  actorStatus = "disabled";
  await assert.rejects(sdk.playback.queue.page(queueId, { position: 0 }), MintSdkError);
  assert.equal(calls.length, callsBefore);
  actorStatus = "active";

  for (const [failure, status] of [
    [new PlaybackQueueError("NOT_FOUND", "This listening queue expired or belongs to another account."), 404],
    [new PlaybackQueueError("CONFLICT", "This queue changed on another device."), 409],
    [new PlaybackQueueError("INVALID_SELECTION", "Queue position must be a nonnegative integer."), 400],
    [new PlaybackQueueError("EMPTY_SELECTION", "No verified songs are available."), 400],
  ] as const) {
    repositoryError = failure;
    const response = await fetch(`${address}/trpc/playback.queue.page?input=${encodeURIComponent(
      JSON.stringify({ queueId, position: 0 }),
    )}`, {
      headers: { [GATEWAY_TOKEN_HEADER_NAME]: gatewayToken, cookie: `mint_session=${sessionToken}` },
    });
    assert.equal(response.status, status);
    assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
    assert.doesNotMatch(await response.text(), /password|SELECT|stack/);
  }
});

test("queue routes and SDK reject malformed input/output and report unavailable services", async (t) => {
  let pageValue: unknown = page;
  const dependencies = {
    gatewayToken,
    sessions: { async findByTokenHash(value) {
      return value === hash ? {
        expiresAt: new Date(Date.now() + 60_000),
        principal: { id: userId, email: "user@example.test", name: "User", role: "user", status: "active" },
      } : null;
    } },
    decisions: { decidePendingAccess: async () => {}, countPending: async () => 0 },
    playbackQueues: {
      open: async () => pageValue as PlaybackQueuePage,
      page: async () => pageValue as PlaybackQueuePage,
      edit: async () => pageValue as PlaybackQueuePage,
    },
    notifyAccessRequests: async () => {},
    errors: { error: () => {} },
  };
  const app = createApiServer(dependencies);
  t.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const sdk = createMintSdk({ url: `${address}/trpc`, gatewayToken, sessionToken });
  const validOpen = { selection: { source: "items" as const, items: [{ mediaFileId }] }, shuffle: false };
  const invalidOpen = [
    { ...validOpen, userId }, { ...validOpen, shuffle: "false" }, { selection: { source: "items", items: [] }, shuffle: false },
  ];
  for (const input of invalidOpen) {
    await assert.rejects(sdk.playback.queue.open(input as never), (error) =>
      error instanceof MintSdkError && error.code === "INVALID_INPUT");
  }
  await assert.rejects(sdk.playback.queue.page("bad", { position: 0 }), (error) =>
    error instanceof MintSdkError && error.code === "INVALID_INPUT");
  await assert.rejects(sdk.playback.queue.edit(queueId, {
    revision: 1, currentEntryId: entryId, edit: { action: "clear" }, actor: { role: "admin" },
  } as never), (error) => error instanceof MintSdkError && error.code === "INVALID_INPUT");

  pageValue = { ...page, items: [{ id: "invalid" }] };
  await assert.rejects(sdk.playback.queue.open(validOpen), (error) =>
    error instanceof MintSdkError && error.code === "INCOMPATIBLE_RESPONSE");

  const unavailable = createApiServer({
    ...dependencies, playbackQueues: undefined,
  });
  t.after(() => unavailable.close());
  const unavailableAddress = await unavailable.listen({ host: "127.0.0.1", port: 0 });
  const unavailableSdk = createMintSdk({
    url: `${unavailableAddress}/trpc`, gatewayToken, sessionToken,
  });
  await assert.rejects(unavailableSdk.playback.queue.open(validOpen), (error) =>
    error instanceof MintSdkError && error.code === "RPC_ERROR");
});
