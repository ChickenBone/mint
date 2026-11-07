import assert from "node:assert/strict";
import { test } from "node:test";
import { serializedCredentials } from "../src/auth/persistence";
import { credentialStorage } from "../src/auth/storage";

test("web credentials are memory-only and explicitly removable", async () => {
  await credentialStorage.set("test", "opaque");
  assert.equal(await credentialStorage.get("test"), "opaque");
  await credentialStorage.remove("test");
  assert.equal(await credentialStorage.get("test"), null);
});
test("logout cleanup waits for prior credential writes and later operations survive failure", async () => {
  let value: string | null = null;
  let release: () => void = () => {};
  const delay = new Promise<void>((resolve) => { release = resolve; });
  const serialize = serializedCredentials({
    async get() { return value; },
    async set(_key, next) { await delay; value = next; },
    async remove() { value = null; },
  });
  const writing = serialize((storage) => storage.set("credential", "old"));
  const removing = serialize((storage) => storage.remove("credential"));
  release();
  await Promise.all([writing, removing]);
  assert.equal(value, null);
  await assert.rejects(serialize(async () => { throw new Error("Storage unavailable"); }));
  assert.equal(await serialize((storage) => storage.get("credential")), null);
});
test("new sign-in storage work waits for complete account/media cleanup", async () => {
  const serialize = serializedCredentials(credentialStorage);
  let finishCleanup: () => void = () => {};
  const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
  const events: string[] = [];
  const signingOut = serialize(async (storage) => {
    await storage.remove("credential");
    await cleanup;
    events.push("account-cleaned");
  });
  const signingIn = serialize(async (storage) => {
    await storage.get("installation");
    events.push("sign-in-started");
  });
  await Promise.resolve();
  assert.deepEqual(events, []);
  finishCleanup();
  await Promise.all([signingOut, signingIn]);
  assert.deepEqual(events, ["account-cleaned", "sign-in-started"]);
});
