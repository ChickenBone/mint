import assert from "node:assert/strict";
import test from "node:test";
import { nativeLockEntries, validateFingerprint } from "./native-runtime.mjs";

const sources = [
  { filePath: "../../node_modules/expo-audio/android" },
  { filePath: "../../node_modules/react-native/package.json" },
  { filePath: "src/playback/with-audio-playlist.cjs" },
];
const entry = (version, integrity) => ({ version, integrity, resolved: `https://registry.npmjs.org/pkg/-/${version}.tgz` });
const lock = () => ({ lockfileVersion: 3, packages: {
  "node_modules/expo-audio": entry("58.0.11", "sha512-native"),
  "node_modules/react-native": entry("0.88.1", "sha512-rn"),
  "node_modules/zod": entry("4.6.7", "sha512-js"),
  "node_modules/next": entry("16.0.0", "sha512-web"),
} });
const graph = (value) => nativeLockEntries(value, sources, "/repo/apps/mobile", "/repo");

test("JS-only and web-only resolved lockfile churn does not change native graph", () => {
  const changed = lock();
  changed.packages["node_modules/zod"] = entry("4.6.8", "sha512-new");
  changed.packages["node_modules/next"] = entry("16.0.1", "sha512-new");
  assert.deepEqual(graph(lock()), graph(changed));
});

test("native resolved versions and integrity are compatibility inputs", () => {
  const changed = lock();
  changed.packages["node_modules/expo-audio"].integrity = "sha512-repacked";
  assert.notDeepEqual(graph(lock()), graph(changed));
  changed.packages["node_modules/react-native"].version = "0.88.2";
  assert.notDeepEqual(graph(lock()), graph(changed));
});

test("nested native dependencies resolve by actual path, not just name", () => {
  const value = lock();
  value.packages["node_modules/expo/node_modules/expo-audio"] = entry("58.0.12", "sha512-nested");
  const result = nativeLockEntries(value, [
    { filePath: "../../node_modules/expo/node_modules/expo-audio/android" },
  ], "/repo/apps/mobile", "/repo");
  assert.equal(result[0].version, "58.0.12");
});

test("unknown/unresolved native graph and incomplete autolinking fail loudly", () => {
  assert.throws(() => graph({ ...lock(), lockfileVersion: 2 }), /lockfile v3/);
  const missing = lock();
  delete missing.packages["node_modules/expo-audio"];
  assert.throws(() => graph(missing), /Unresolved native/);
  assert.throws(() => validateFingerprint({ sources: [] }), /Incomplete Android/);
  const complete = { sources: [
    ...["expoConfig", "expoAutolinkingConfig:android", "rncoreAutolinkingConfig:android"].map((id) => ({ id, hash: "hash", reasons: [] })),
    { hash: "hash", reasons: ["package:react-native"] },
    { filePath: "android", hash: null, reasons: ["bareNativeDir"] },
  ] };
  validateFingerprint(complete);
  complete.sources.push({ filePath: "icon.png", hash: null, reasons: [] });
  assert.throws(() => validateFingerprint(complete), /Unhashed native/);
});
