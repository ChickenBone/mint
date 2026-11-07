import assert from "node:assert/strict";
import test from "node:test";
import { DiagnosticsPreference, diagnosticsPreferenceKey } from "../src/playback/diagnostics-preference";

test("diagnostics preferences default off and isolate server/account scopes", async () => {
  const values = new Map<string, string>();
  const storage = { getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value); } };
  const enabled: boolean[] = [];
  const first = new DiagnosticsPreference(storage, "server-a-account-a", (value) => enabled.push(value));
  await first.restore();
  assert.deepEqual(enabled, [false]);
  await first.set(true);
  assert.equal(values.get(diagnosticsPreferenceKey("server-a-account-a")), "true");
  const second: boolean[] = [];
  await new DiagnosticsPreference(storage, "server-b-account-a", (value) => second.push(value)).restore();
  assert.deepEqual(second, [false]);
  await new DiagnosticsPreference(storage, "server-a-account-b", (value) => second.push(value)).restore();
  assert.deepEqual(second, [false, false]);
});
test("restore cannot overwrite a newer toggle; dispose stops late callbacks", async () => {
  let resolve!: (value: string) => void;
  const output: boolean[] = [];
  const preference = new DiagnosticsPreference({ getItem: () => new Promise((done) => { resolve = done; }),
    setItem: async () => {} }, "scope", (value) => output.push(value));
  const pending = preference.restore();
  await preference.set(false);
  resolve("true");
  await pending;
  assert.deepEqual(output, [false, false]);
  await preference.dispose();
  await assert.rejects(preference.set(true), /Sign in/);
});
test("failed disable persistence still clears diagnostics and dispose drains pending writes", async () => {
  const output: boolean[] = [];
  const preference = new DiagnosticsPreference({ getItem: async () => "true",
    setItem: async () => { throw new Error("Storage unavailable"); } }, "scope", (value) => output.push(value));
  await preference.restore();
  await assert.rejects(preference.set(false), /Storage unavailable/);
  assert.deepEqual(output, [true, false]);
  await preference.dispose();
});
test("restore failure remains an explicit local warning until a saved toggle succeeds", async () => {
  const output: { enabled: boolean; warning?: string }[] = [];
  const preference = new DiagnosticsPreference({
    getItem: async () => { throw new Error("private device storage details"); },
    setItem: async () => {},
  }, "scope", (enabled, warning) => output.push({ enabled, warning }));
  await preference.restore();
  assert.equal(output[0]!.enabled, false);
  assert.match(output[0]!.warning!, /could not be loaded/);
  assert.doesNotMatch(output[0]!.warning!, /private device/);
  await preference.set(true);
  assert.deepEqual(output[1], { enabled: true, warning: undefined });
});
test("stale restore failure cannot warn after account disposal", async () => {
  let reject!: (error: Error) => void;
  const output: unknown[] = [];
  const preference = new DiagnosticsPreference({
    getItem: () => new Promise((_resolve, fail) => { reject = fail; }), setItem: async () => {},
  }, "scope", (...values) => output.push(values));
  const pending = preference.restore();
  await preference.dispose();
  reject(new Error("unavailable"));
  await pending;
  assert.deepEqual(output, []);
});
