const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const VERSION = "58.0.11";
const MODULE_HASH = "6613ccc5b2ed971ec6ff4fa65ccafc04cce95f88d6e21d88a12cd3d124b9a523";
const PLAYLIST_HASH = "804efa3d13ba5288e1e4285ef19b0c549a4b3a1b6d543fe7525a7d1af90c1330";
const hash = (source) => createHash("sha256").update(source).digest("hex");

const moduleEdits = [
  ["import androidx.media3.datasource.DefaultDataSource", "import androidx.media3.datasource.DefaultDataSource\nimport androidx.media3.datasource.ResolvingDataSource"],
  ["      Constructor { sources: List<AudioSource>, updateInterval: Double, loop: LoopMode ->\n        runOnMain {\n          val playlist = AudioPlaylist(",
    "      Constructor { sources: List<AudioSource>, updateInterval: Double, loop: LoopMode ->\n        runOnMain {\n          // Mint: expo/expo#51434; remove after an audited upstream SDK update.\n          val headersByUri = ConcurrentHashMap<String, Map<String, String>>()\n          val playlistHttpClient = httpClient.newBuilder()\n            .followRedirects(false)\n            .followSslRedirects(false)\n            .build()\n          val playlist = AudioPlaylist("],
  ["            DefaultDataSource.Factory(context)\n          )\n          playlist.loopMode = loop",
    "            ResolvingDataSource.Factory(\n              DefaultDataSource.Factory(context, OkHttpDataSource.Factory(playlistHttpClient)),\n              ResolvingDataSource.Resolver { dataSpec ->\n                dataSpec.withRequestHeaders(headersByUri[dataSpec.uri.toString()].orEmpty())\n              }\n            )\n          )\n          playlist.onSourcesCleared = { headersByUri.clear() }\n          playlist.loopMode = loop"],
  ["          playlist.setMediaItemCreator { source ->\n            source.uri?.let { uriString ->",
    "          playlist.setMediaItemCreator { source ->\n            source.uri?.let { uriString ->\n              headersByUri[uriString] = source.headers.orEmpty().toMap()"],
];
const playlistEdits = [
  ["  private var createMediaItemForSource: ((AudioSource) -> MediaItem?)? = null",
    "  private var createMediaItemForSource: ((AudioSource) -> MediaItem?)? = null\n  var onSourcesCleared: (() -> Unit)? = null"],
  ["    sources.clear()\n\n    sendStatusUpdate(", "    sources.clear()\n    onSourcesCleared?.invoke()\n\n    sendStatusUpdate("],
  ["  override fun releasePlayer() {\n    serviceConnection.release()",
    "  override fun releasePlayer() {\n    onSourcesCleared?.invoke()\n    onSourcesCleared = null\n    serviceConnection.release()"],
];
const recoveryEdits = [
  ["import androidx.media3.datasource.DataSource",
    "import androidx.media3.datasource.DataSource\nimport androidx.media3.datasource.HttpDataSource"],
  ["          \"code\" to error.errorCode",
    "          \"code\" to error.errorCode,\n          \"codeName\" to error.errorCodeName,\n          \"responseCode\" to (error.cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode"],
  ["    ref.addMediaItem(mediaItem)\n    sendStatusUpdate(mapOf(\"trackCount\" to trackCount))",
    "    ref.addMediaItem(mediaItem)\n    // A source error leaves ExoPlayer idle; adding a replacement does not prepare it.\n    if (ref.playbackState == Player.STATE_IDLE) ref.prepare()\n    sendStatusUpdate(mapOf(\"trackCount\" to trackCount))"],
  ["    ref.addMediaItem(index, mediaItem)\n    sendStatusUpdate(mapOf(\"trackCount\" to trackCount))",
    "    ref.addMediaItem(index, mediaItem)\n    if (ref.playbackState == Player.STATE_IDLE) ref.prepare()\n    sendStatusUpdate(mapOf(\"trackCount\" to trackCount))"],
];

function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Mint audio patch: upstream source shape changed. Audit the SDK before building.");
  return source.replace(before, after);
}
function guarded(source, expectedHash, edits, legacyEdits) {
  if (hash(source) === expectedHash) return edits.reduce((value, [before, after]) => once(value, before, after), source);
  if (legacyEdits) {
    let original = source;
    try {
      for (const [before, after] of [...legacyEdits].reverse()) original = once(original, after, before);
      if (hash(original) === expectedHash) return edits.reduce((value, [before, after]) => once(value, before, after), original);
    } catch { /* The current patch still requires full reverse/checksum verification below. */ }
  }
  let original = source;
  for (const [before, after] of [...edits].reverse()) original = once(original, after, before);
  if (hash(original) !== expectedHash) throw new Error("Mint audio patch: native source checksum changed. Refusing an unaudited build.");
  return source;
}
function patchNativeSources({ version, moduleSource, playlistSource }) {
  if (version !== VERSION) throw new Error(`Mint audio patch requires expo-audio ${VERSION}; found ${version}. Audit upstream #51434/#51745 before upgrading.`);
  return {
    moduleSource: guarded(moduleSource, MODULE_HASH, moduleEdits),
    playlistSource: guarded(playlistSource, PLAYLIST_HASH, [...playlistEdits, ...recoveryEdits], playlistEdits),
  };
}
function withAudioPlaylist(config) {
  return withDangerousMod(config, ["android", async (mod) => {
    const root = dirname(require.resolve("expo-audio/package.json", { paths: [mod.modRequest.projectRoot] }));
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const dir = join(root, "android/src/main/java/expo/modules/audio");
    const modulePath = join(dir, "AudioModule.kt"), playlistPath = join(dir, "AudioPlaylist.kt");
    const source = { version, moduleSource: readFileSync(modulePath, "utf8"), playlistSource: readFileSync(playlistPath, "utf8") };
    const patched = patchNativeSources(source);
    if (source.moduleSource !== patched.moduleSource) writeFileSync(modulePath, patched.moduleSource);
    if (source.playlistSource !== patched.playlistSource) writeFileSync(playlistPath, patched.playlistSource);
    return mod;
  }]);
}
module.exports = withAudioPlaylist;
module.exports.patchNativeSources = patchNativeSources;
