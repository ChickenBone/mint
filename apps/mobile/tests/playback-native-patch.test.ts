import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

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

test("the exact previous header-only patch upgrades in place while altered legacy sources are rejected", () => {
  const patched = patchNativeSources(source);
  const legacy = patched.playlistSource
    .replace("\nimport androidx.media3.datasource.HttpDataSource", "")
    .replace('          "code" to error.errorCode,\n          "codeName" to error.errorCodeName,\n          "responseCode" to (error.cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode',
      '          "code" to error.errorCode')
    .replace("    // A source error leaves ExoPlayer idle; adding a replacement does not prepare it.\n", "")
    .replaceAll("    if (ref.playbackState == Player.STATE_IDLE) ref.prepare()\n", "");
  assert.deepEqual(patchNativeSources({ ...patched, version: source.version, playlistSource: legacy }), patched);
  assert.throws(() => patchNativeSources({ ...patched, version: source.version,
    playlistSource: `${legacy}\n// unaudited legacy change` }), /checksum|shape/);
});

test("native SDK version or source drift fails the build loudly", () => {
  assert.throws(() => patchNativeSources({ ...source, version: "58.0.12" }), /requires expo-audio/);
  assert.throws(() => patchNativeSources({ ...source, moduleSource: `${source.moduleSource}\n// unknown edit` }), /checksum|shape/);
  assert.throws(() => patchNativeSources({ ...source, playlistSource: source.playlistSource.replace("sources.clear()", "sources.removeAll()") }), /checksum|shape/);
});

test("idle Android playlists are prepared when replacing a failed source, without restarting ready or buffering playback", () => {
  const { playlistSource } = patchNativeSources(source);
  for (const method of ["add", "insert"]) {
    const body = playlistSource.slice(playlistSource.indexOf(`  fun ${method}(`));
    assert.match(body, /ref\.addMediaItem\([^\n]+\)\n(?:    \/\/[^\n]+\n)?    if \(ref\.playbackState == Player\.STATE_IDLE\) ref\.prepare\(\)\n    sendStatusUpdate/);
  }
  assert.equal((playlistSource.match(/if \(ref.playbackState == Player.STATE_IDLE\) ref.prepare\(\)/g) ?? []).length, 2);
});

test("actual patched add statements prepare IDLE only; the Media3 empty ENDED playlist buffers automatically on its first addition", () => {
  const { playlistSource } = patchNativeSources(source);
  const Player = { STATE_IDLE: 1, STATE_BUFFERING: 2, STATE_READY: 3, STATE_ENDED: 4 };
  for (const method of ["add", "insert"]) {
    const body = playlistSource.slice(playlistSource.indexOf(`  fun ${method}(`));
    // These particular Kotlin statements are valid JavaScript too. Execute the
    // actual patch against a model of Media3 1.9.1's setMediaSourcesInternal;
    // this is deliberately not claimed as Kotlin or Android execution.
    const statements = body.slice(body.indexOf("    ref.addMediaItem("), body.indexOf("    sendStatusUpdate("));
    assert.ok(statements);
    for (const initial of Object.values(Player)) {
      let count = initial === Player.STATE_READY || initial === Player.STATE_BUFFERING ? 1 : 0;
      let prepared = 0;
      const ref = {
        playbackState: initial,
        addMediaItem() {
          if (count++ === 0 && this.playbackState !== Player.STATE_IDLE) this.playbackState = Player.STATE_BUFFERING;
        },
        prepare() {
          prepared++;
          if (this.playbackState === Player.STATE_IDLE) this.playbackState = count ? Player.STATE_BUFFERING : Player.STATE_ENDED;
        },
      };
      runInNewContext(statements, { ref, Player, mediaItem: {}, index: 0 });
      assert.equal(prepared, initial === Player.STATE_IDLE ? 1 : 0);
      assert.equal(ref.playbackState, initial === Player.STATE_READY ? Player.STATE_READY : Player.STATE_BUFFERING);
    }
  }
});

test("native HTTP failures include safe structured Media3 and response codes rather than private URLs or headers", () => {
  const { playlistSource } = patchNativeSources(source);
  const errorBody = playlistSource.slice(playlistSource.indexOf("override fun onPlayerError"), playlistSource.indexOf("  fun next()"));
  assert.match(errorBody, /"codeName" to error\.errorCodeName/);
  assert.match(errorBody, /"responseCode" to \(error\.cause as\? HttpDataSource\.InvalidResponseCodeException\)\?\.responseCode/);
  assert.doesNotMatch(errorBody, /httpHeaderFields|responseBody|stackTrace|toString\(\)/);
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
