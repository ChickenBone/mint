import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

const load = createRequire(import.meta.url);
type NativeSources = { version: string; moduleSource: string; playlistSource: string };
const { patchNativeSources }: { patchNativeSources(source: NativeSources): Omit<NativeSources, "version"> } = load("../src/playback/with-audio-playlist.cjs");
const root = dirname(load.resolve("expo-audio/package.json"));
const native = join(root, "android/src/main/java/expo/modules/audio");
const source: NativeSources = {
  version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  moduleSource: readFileSync(join(native, "AudioModule.kt"), "utf8"),
  playlistSource: readFileSync(join(native, "AudioPlaylist.kt"), "utf8"),
};

test("native SDK58 patch is deterministic and idempotent on the exact audited release", () => {
  const patched = patchNativeSources(source);
  assert.deepEqual(patchNativeSources({ ...patched, version: source.version }), patched);
  assert.equal((patched.moduleSource.match(/val headersByUri/g) ?? []).length, 1);
});

test("native SDK version or source drift fails the build loudly", () => {
  assert.throws(() => patchNativeSources({ ...source, version: "58.0.12" }), /requires expo-audio/);
  assert.throws(() => patchNativeSources({ ...source, moduleSource: `${source.moduleSource}\n// unknown edit` }), /checksum|shape/);
  assert.throws(() => patchNativeSources({ ...source, playlistSource: source.playlistSource.replace("sources.clear()", "sources.removeAll()") }), /checksum|shape/);
});

test("every native source replaces its own headers, unknown sources get none, ranges retain DataSpec position and redirects are disabled", () => {
  const patched = patchNativeSources(source);
  assert.match(patched.moduleSource, /ConcurrentHashMap<String, Map<String, String>>/);
  assert.match(patched.moduleSource, /headersByUri\[uriString\] = source\.headers\.orEmpty\(\)\.toMap\(\)/);
  assert.match(patched.moduleSource, /dataSpec\.withRequestHeaders\(headersByUri\[dataSpec\.uri\.toString\(\)\]\.orEmpty\(\)\)/);
  assert.doesNotMatch(patched.moduleSource, /dataSpec\.withUri|headersByUri\.values/);
  assert.match(patched.moduleSource, /\.followRedirects\(false\)/);
  assert.match(patched.moduleSource, /\.followSslRedirects\(false\)/);
  assert.match(patched.moduleSource, /playlist\.onSourcesCleared = \{ headersByUri\.clear\(\) \}/);
  assert.match(patched.playlistSource, /sources\.clear\(\)\s+onSourcesCleared\?\.invoke\(\)/);
  assert.match(patched.playlistSource, /override fun releasePlayer\(\) \{\s+onSourcesCleared\?\.invoke\(\)\s+onSourcesCleared = null/);
});
