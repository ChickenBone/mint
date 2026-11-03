import assert from "node:assert/strict";
import test from "node:test";
import { codecQuality, isLosslessUpgrade, libraryMatchKey, mapLibraryPath, sameRecording } from "../library-policy";
import { containerFor } from "../media";

test("only a lossy to lossless format change qualifies as an upgrade", () => {
  for (const original of ["mp3", "aac", "opus", "vorbis"]) {
    for (const candidate of ["flac", "alac", "pcm_s24le"]) assert.equal(isLosslessUpgrade(original, candidate), true);
    for (const candidate of ["mp3", "aac", "opus", null]) assert.equal(isLosslessUpgrade(original, candidate), false);
  }
  for (const original of ["flac", "alac", "pcm_s16le", null, "unknown"]) assert.equal(isLosslessUpgrade(original, "flac"), false);
  assert.equal(codecQuality("FLAC"), "lossless");
  for (const codec of ["pcm_s24le", "ape", "wavpack"]) {
    assert.equal(containerFor(codec).ext, "flac");
    assert.equal("transcode" in containerFor(codec), false);
  }
});

test("recording matches preserve editions and require close durations", () => {
  const song = { title: "Night Ferry", artist: "Halcyon Static", album: "Low Tide", durationSec: 210, codec: "mp3" };
  assert.equal(sameRecording(song, { ...song, durationSec: 214, codec: "flac" }), true);
  assert.equal(sameRecording(song, { ...song, durationSec: 216 }), false);
  assert.equal(sameRecording(song, { ...song, durationSec: null }), false);
  assert.equal(sameRecording(song, { ...song, title: "Night Ferry (Live)" }), false);
  assert.equal(sameRecording(song, { ...song, album: "Live at the Pier" }), false);
  assert.equal(libraryMatchKey("HALCYON static", "Night—Ferry"), libraryMatchKey("Halcyon Static", "Night Ferry"));
});

test("path mapping respects directory boundaries and never maps outside the read-only mount", () => {
  assert.equal(mapLibraryPath("/media/music/Artist/song.flac", "/media/music", "/existing-music"), "/existing-music/Artist/song.flac");
  for (const file of ["/media/music-old/song.flac", "/media/music/../../secret", "/music/song.flac", "/media/music"]) {
    assert.throws(() => mapLibraryPath(file, "/media/music", "/existing-music"));
  }
});
