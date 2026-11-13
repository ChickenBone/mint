import assert from "node:assert/strict";
import { test } from "node:test";
import { libraryFilePageSchema, libraryListInputSchema } from "@mint/contracts";
import { createMintSdk, MintSdkError } from "../src/index";

const options = { url: "http://fixture.test/trpc", gatewayToken: "a".repeat(42) + "A" };
const item = {
  id: "00000000-0000-0000-0000-000000000001", recordingId: null,
  title: "Fixture", artist: "Unknown artist", album: "Unknown album",
  version: null, durationMs: null,
};
const page = { items: [item], nextCursor: null };
const response = (data: unknown) => new Response(JSON.stringify({ result: { data } }), {
  headers: { "content-type": "application/json" },
});
const category = (code: string) => (error: unknown) => error instanceof MintSdkError && error.code === code;

test("Library SDK validates both boundaries and forwards only approved credentials", async () => {
  let calls = 0;
  const sdk = createMintSdk({
    ...options, sessionToken: "b".repeat(42) + "A",
    fetch: async (input, init) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.pathname, "/trpc/library.listFiles");
      assert.deepEqual(JSON.parse(url.searchParams.get("input")!), { search: "Fixture", limit: 1 });
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-mint-gateway-token"), options.gatewayToken);
      assert.equal(headers.get("cookie"), `mint_session=${"b".repeat(42)}A`);
      assert.equal(headers.get("x-forwarded-for"), null);
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      return response(page);
    },
  });
  assert.deepEqual(await sdk.library.listFiles({ search: "Fixture", limit: 1 }), page);
  await assert.rejects(sdk.library.listFiles({ limit: 101 }), category("INVALID_INPUT"));
  await assert.rejects(sdk.library.listFiles({ search: "\0" }), category("INVALID_INPUT"));
  assert.equal(calls, 1);
});

test("Library shared schemas enforce exact public DTOs and numeric, UUID, null and length bounds", () => {
  assert.ok(libraryFilePageSchema.safeParse(page).success);
  assert.ok(libraryFilePageSchema.safeParse({ items: [], nextCursor: null }).success);
  for (const invalid of [
    { ...item, id: "invalid" }, { ...item, recordingId: "" },
    { ...item, durationMs: 0 }, { ...item, durationMs: 1.2 }, { ...item, durationMs: 2147483648 },
    { ...item, title: "" }, { ...item, title: "x".repeat(2001) }, { ...item, artist: "\0" },
    { ...item, version: "" }, { ...item, rootId: item.id }, { ...item, relativePath: "private.flac" },
    { ...item, verifiedAt: new Date().toISOString() },
  ]) {
    assert.equal(libraryFilePageSchema.safeParse({ items: [invalid], nextCursor: null }).success, false);
  }
  for (const invalid of [
    { items: Array.from({ length: 101 }, () => item), nextCursor: null },
    { items: [], nextCursor: "abc" }, { items: [item], nextCursor: "" },
    { ...page, root: "/private" },
  ]) assert.equal(libraryFilePageSchema.safeParse(invalid).success, false);
  for (const invalid of [
    { limit: 0 }, { limit: 101 }, { limit: 1.1 }, { search: "x".repeat(201) },
    { cursor: "x".repeat(2049) }, { cursor: "!" }, { cursor: "" }, { actor: "admin" },
  ]) assert.equal(libraryListInputSchema.safeParse(invalid).success, false);
});

test("Library SDK rejects incompatible pages, including pages exceeding the requested window", async () => {
  for (const value of [
    { ...page, items: [{ ...item, relativePath: "secret.flac" }] },
    { ...page, items: [{ ...item, durationMs: -1 }] }, null,
    { items: [item, item], nextCursor: null },
  ]) {
    const sdk = createMintSdk({ ...options, fetch: async () => response(value) });
    await assert.rejects(sdk.library.listFiles({ limit: 1 }), category("INCOMPATIBLE_RESPONSE"));
  }
});

test("Library SDK preserves abort and sanitized RPC/transport failure categories", async () => {
  const controller = new AbortController();
  const reason = new Error("fixture cancellation");
  const sdk = createMintSdk({
    ...options,
    fetch: async (_input, init) => {
      assert.ok(init?.signal);
      controller.abort(reason);
      init.signal.throwIfAborted();
      return response(page);
    },
  });
  await assert.rejects(sdk.library.listFiles({}, { signal: controller.signal }), (error: unknown) => error === reason);
  const unreachable = createMintSdk({
    ...options, fetch: async () => { throw new Error("private database address"); },
  });
  await assert.rejects(unreachable.library.listFiles(), category("TRANSPORT_ERROR"));
  const rejected = createMintSdk({
    ...options, fetch: async () => new Response("private database error", { status: 500 }),
  });
  await assert.rejects(rejected.library.listFiles(), category("RPC_ERROR"));
});
