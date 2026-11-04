import assert from "node:assert/strict";
import test from "node:test";
import { selectRequestedVideo, type YtVideo } from "./services/youtube";

test("requested-video matching requires artist, title, known duration and the requested version", () => {
  const track = { title: "First Light", artist: "Mint Fixture", durationSec: 90 };
  const video: YtVideo = { id: "abcdefghijk", title: "Mint Fixture - First Light (Official Audio)", channelTitle: "Mint Fixture - Topic",
    description: "", categoryId: "10", durationIso: "PT1M30S" };
  assert.equal(selectRequestedVideo(track, [video]), video.id);
  for (const change of [{ title: "Mint Fixture - Last Light" }, { channelTitle: "Someone Else", title: "First Light" },
    { title: `${video.title} live` }, { title: `${video.title} remix` }, { title: `${video.title} cover` },
    { durationIso: "PT3M" }, { durationIso: null }]) {
    assert.equal(selectRequestedVideo(track, [{ ...video, ...change }]), null, JSON.stringify(change));
  }
  assert.equal(selectRequestedVideo({ ...track, artist: "" }, [video]), null);
  assert.equal(selectRequestedVideo({ ...track, title: "First Light Live" }, [{ ...video, title: `${video.title} live` }]), video.id);
});
