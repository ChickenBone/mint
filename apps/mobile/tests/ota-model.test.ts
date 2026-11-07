import assert from "node:assert/strict";
import test from "node:test";
import {
  canRestartForUpdate,
  checkAndFetchUpdate,
  fetchedUpdateStatus,
  getUpdateAvailability,
  noUpdateMessage,
  restartForUpdate,
  updateErrorMessage,
  type UpdateStatus,
} from "../src/screens/ota-model";

test("OTA controls are limited to enabled native release builds, including SDK bare environments", () => {
  assert.deepEqual(getUpdateAvailability("web", "standalone", true, false), {
    available: false,
    message: "App updates are available only in the installed Android or iOS app.",
  });
  assert.equal(getUpdateAvailability("android", "storeClient", true, false).available, false);
  assert.equal(getUpdateAvailability("android", "standalone", true, true).available, false);
  assert.equal(getUpdateAvailability("android", "standalone", false, false).available, false);
  assert.deepEqual(getUpdateAvailability("android", "standalone", true, false), { available: true });
  assert.deepEqual(getUpdateAvailability("android", "bare", true, false), { available: true });
  assert.deepEqual(getUpdateAvailability("ios", "bare", true, false), { available: true });
  assert.equal(getUpdateAvailability("android", "bare", false, false).available, false);
});

test("no-update outcomes distinguish incompatibility and prior launch failure", () => {
  assert.match(noUpdateMessage("noUpdateAvailableOnServer"), /No compatible update/);
  assert.match(noUpdateMessage("updateRejectedBySelectionPolicy"), /not eligible/);
  assert.match(noUpdateMessage("updatePreviouslyFailed"), /previously failed to launch/);
  assert.match(noUpdateMessage(undefined), /No compatible update/);
});

test("download results report ready updates, embedded recovery, or no new update", () => {
  assert.deepEqual(fetchedUpdateStatus(true, false), {
    state: "ready",
    message: "The update is downloaded and ready. Restart Mint to use it.",
  });
  assert.deepEqual(fetchedUpdateStatus(false, true), {
    state: "ready",
    message: "The embedded recovery version is ready. Restart Mint to use it.",
  });
  assert.equal(fetchedUpdateStatus(false, false).state, "no-update");
});

test("update errors remain visible and restart waits until playback is idle", () => {
  assert.equal(updateErrorMessage(new Error("network timeout")), "network timeout");
  assert.match(updateErrorMessage("unknown failure"), /could not check or download/);
  assert.equal(canRestartForUpdate(true, false), false);
  assert.equal(canRestartForUpdate(false, true), false);
  assert.equal(canRestartForUpdate(false, false, true), false);
  assert.equal(canRestartForUpdate(false, false), true);
});

test("manual check checks before downloading and reports the downloaded update as ready", async () => {
  const calls: string[] = [];
  const statuses: UpdateStatus[] = [];
  await checkAndFetchUpdate({
    checkForUpdateAsync: async () => {
      calls.push("check");
      return { isAvailable: true, isRollBackToEmbedded: false };
    },
    fetchUpdateAsync: async () => {
      calls.push("fetch");
      return { isNew: true, isRollBackToEmbedded: false };
    },
    reloadAsync: async () => { calls.push("reload"); },
  }, (status) => statuses.push(status));
  assert.deepEqual(calls, ["check", "fetch"]);
  assert.deepEqual(statuses.map((status) => status.state), ["checking", "downloading", "ready"]);
});

test("manual check skips download when none is available and preserves native errors", async () => {
  const calls: string[] = [];
  const statuses: UpdateStatus[] = [];
  await checkAndFetchUpdate({
    checkForUpdateAsync: async () => {
      calls.push("check");
      return { isAvailable: false, isRollBackToEmbedded: false, reason: "noUpdateAvailableOnServer" };
    },
    fetchUpdateAsync: async () => {
      calls.push("fetch");
      return { isNew: true, isRollBackToEmbedded: false };
    },
    reloadAsync: async () => {},
  }, (status) => statuses.push(status));
  assert.deepEqual(calls, ["check"]);
  assert.equal(statuses.at(-1)?.state, "no-update");

  await checkAndFetchUpdate({
    checkForUpdateAsync: async () => { throw new Error("Expo network timeout"); },
    fetchUpdateAsync: async () => ({ isNew: true, isRollBackToEmbedded: false }),
    reloadAsync: async () => {},
  }, (status) => statuses.push(status));
  assert.equal(statuses.at(-1)?.state, "error");
  assert.equal(statuses.at(-1)?.message, "Expo network timeout");

  await checkAndFetchUpdate({
    checkForUpdateAsync: async () => ({ isAvailable: true, isRollBackToEmbedded: false }),
    fetchUpdateAsync: async () => { throw new Error("Expo asset download failed"); },
    reloadAsync: async () => {},
  }, (status) => statuses.push(status));
  assert.equal(statuses.at(-1)?.state, "error");
  assert.equal(statuses.at(-1)?.message, "Expo asset download failed");
});

test("restart requires playback, loading, and queue preparation to be idle", async () => {
  const calls: string[] = [];
  const statuses: UpdateStatus[] = [];
  const updates = { reloadAsync: async () => { calls.push("reload"); } };
  await restartForUpdate(updates, { playing: false, loading: false, queueLoading: true }, (status) => statuses.push(status));
  assert.deepEqual(calls, []);
  assert.match(statuses.at(-1)?.message ?? "", /Pause playback/);
  await restartForUpdate(updates, { playing: false, loading: false, queueLoading: false }, (status) => statuses.push(status));
  assert.deepEqual(calls, ["reload"]);
  assert.deepEqual(statuses.slice(-1).map((status) => status.state), ["restarting"]);
  await restartForUpdate({ reloadAsync: async () => { throw new Error("reload unavailable"); } },
    { playing: false, loading: false, queueLoading: false }, (status) => statuses.push(status));
  assert.equal(statuses.at(-1)?.state, "error");
  assert.equal(statuses.at(-1)?.message, "reload unavailable");
});
