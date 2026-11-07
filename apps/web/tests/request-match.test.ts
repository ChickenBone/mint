import assert from "node:assert/strict";
import test from "node:test";
import { chooseRequestMatch, decisionChoices, identityFromVideo, matchMissingRequest, videoMatchesRequest, type CatalogRecording, type CatalogVideo } from "../src/lib/request-match";

const lilBaby: CatalogRecording = { id: "11111111-1111-4111-8111-111111111111", title: "Freestyle", artist: "Lil Baby", album: "It's Only Me", durationSec: 176 };
const other: CatalogRecording = { id: "22222222-2222-4222-8222-222222222222", title: "Freestyle", artist: "Somebody Else", album: null, durationSec: 200 };
const official: CatalogVideo = { id: "abcdefghijk", title: "Lil Baby - Freestyle (Official Audio)", channel: "Lil Baby", durationSec: 176, rank: 0 };

test("an official upload selects the catalog recording with the same duration", () => {
  const choice = chooseRequestMatch("Freestyle Lil Baby", [other, lilBaby], [
    official,
    { id: "bbbbbbbbbbb", title: "Freestyle", channel: "Somebody Else", durationSec: 200, rank: 1 },
  ]);
  assert.equal(choice?.kind, "recording");
  if (choice?.kind === "recording") {
    assert.equal(choice.recording.id, lilBaby.id);
    assert.equal(choice.videoId, official.id);
  }
});

test("a lyric or visualizer upload is not confident", () => {
  assert.equal(chooseRequestMatch("Freestyle Lil Baby", [lilBaby], [
    { id: "ccccccccccc", title: "Lil Baby - Freestyle (Official Lyric Video)", channel: "Lil Baby", durationSec: 176, rank: 0 },
  ]), null);
});

test("two official uploads of the same recording use the top result", () => {
  const choice = chooseRequestMatch("Freestyle Lil Baby", [lilBaby], [
    official,
    { id: "ddddddddddd", title: "Lil Baby - Freestyle (Official Audio)", channel: "Lil Baby - Topic", durationSec: 176, rank: 1 },
  ]);
  const videoId = choice?.kind === "recording" ? choice.videoId : choice?.kind === "video" ? choice.video.id : null;
  assert.equal(videoId, official.id);
});

test("official uploads with different durations stay unresolved", () => {
  assert.equal(chooseRequestMatch("Freestyle Lil Baby", [], [
    { ...official, durationSec: 176 },
    { id: "ddddddddddd", title: "Lil Baby - Freestyle (Official Audio)", channel: "Lil Baby", durationSec: 210, rank: 1 },
  ]), null);
});

test("close catalog candidates stay unresolved", () => {
  assert.equal(chooseRequestMatch("Freestyle Lil Baby", [lilBaby, other], [
    { ...official, rank: 1 },
    { id: "eeeeeeeeeee", title: "Somebody Else - Freestyle (Official Audio)", channel: "Somebody Else", durationSec: 200, rank: 0 },
  ]), null);
});

test("an artist's official video identifies the song when the catalog page does not", () => {
  const choice = chooseRequestMatch("Tate McRae Housewife", [other], [
    { id: "fffffffffff", title: "Tate McRae - Housewife (Official Video)", channel: "Tate McRae", durationSec: 208, rank: 0 },
    { id: "ggggggggggg", title: "Housewife Maneater (Tate McRae vs. Nelly Furtado)", channel: "Mashup Channel", durationSec: 216, rank: 1 },
  ]);
  assert.equal(choice?.kind, "video");
  if (choice?.kind === "video") assert.equal(choice.video.id, "fffffffffff");
});

test("YouTube can identify the song when the first catalog page does not", () => {
  const choice = chooseRequestMatch("Freestyle Lil Baby", [other], [official]);
  assert.equal(choice?.kind, "video");
  if (choice?.kind === "video") assert.equal(choice.video.id, official.id);
});

test("without YouTube, only one artist and title named by the query is requested", () => {
  const named = chooseRequestMatch("Freestyle Lil Baby", [other, lilBaby], null);
  assert.equal(named?.kind, "recording");
  if (named?.kind === "recording") assert.equal(named.videoId, null);
  assert.equal(chooseRequestMatch("Freestyle", [other, lilBaby], null), null);
});

test("a collaboration Topic upload is the clean chart match, and the longer music video is not", () => {
  const topic = { id: "psoukhew9iQ", title: "Solar Eclipse", channel: "Drake - Topic", durationSec: 219, rank: 1 };
  const musicVideo = { id: "vBk30V8AukM", title: "Drake, Don Toliver - Solar Eclipse", channel: "DrakeVEVO", durationSec: 245, rank: 0 };
  const featured = { id: "featuredonlyt", title: "Solar Eclipse", channel: "Don Toliver - Topic", durationSec: 219, rank: 2 };
  const wanted = { title: "Solar Eclipse", artist: "Drake & Don Toliver", durationSec: 218.389 };
  assert.equal(videoMatchesRequest(wanted, topic), true);
  assert.equal(videoMatchesRequest(wanted, musicVideo), false);
  assert.equal(videoMatchesRequest(wanted, featured), false);
  const choice = chooseRequestMatch("Drake & Don Toliver Solar Eclipse", [], [musicVideo, topic, featured]);
  assert.equal(choice?.kind, "video");
  if (choice?.kind === "video") assert.equal(choice.video.id, topic.id);
  const choices = decisionChoices("Drake & Don Toliver Solar Eclipse", [], [musicVideo, topic, featured, {
    id: "lyricvideoid", title: "Drake - Solar Eclipse (Lyrics) ft. Don Toliver", channel: "MusicLoudz", durationSec: 219, rank: 3,
  }]);
  assert.deepEqual(choices.map((item) => item.value), [`vid:${topic.id}`, "none"]);
});

test("without clean audio, only the official music video is offered", () => {
  const choices = decisionChoices("Tate McRae Housewife", [], [
    { id: "officialvid1", title: "Tate McRae - Housewife (Official Video)", channel: "TateMcRaeVEVO", durationSec: 210, rank: 0 },
    { id: "lyricvideo01", title: "Tate McRae - Housewife (Lyrics)", channel: "7clouds", durationSec: 209, rank: 1 },
    { id: "reupload0001", title: "Tate McRae - Housewife", channel: "LatinHype", durationSec: 209, rank: 2 },
  ]);
  assert.deepEqual(choices.map((item) => item.value), ["vid:officialvid1", "none"]);
});

test("a Topic preview is not the song, and a featured credit does not make the title a different song", () => {
  const preview = { id: "KEkmJAIP_A4", title: "Mr. Do Something (Preview)", channel: "Lil Baby - Topic", durationSec: 22, rank: 1 };
  const full = { id: "3EeJub4m1-E", title: "Lil Baby - Mr. Do Something", channel: "LilBabyVEVO", durationSec: 171, rank: 0 };
  const wanted = { title: "Mr. Do Something", artist: "Lil Baby", durationSec: 170.667 };
  assert.equal(videoMatchesRequest(wanted, preview), false);
  assert.equal(videoMatchesRequest(wanted, full), true);
  assert.deepEqual(decisionChoices("Lil Baby Mr. Do Something", [], [full, preview]).map((item) => item.value), [`vid:${full.id}`, "none"]);
  const lies = { id: "nhR-Ka-aKUs", title: "Zach Bryan - Lies (feat. Lana Del Rey) (Official Audio)", channel: "Zach Bryan", durationSec: 221, rank: 0 };
  assert.equal(videoMatchesRequest({ title: "Lies (feat. Lana Del Rey)", artist: "Zach Bryan & Lana Del Rey", durationSec: 220.589 }, lies), true);
  const topic = { id: "CyPa2ZkWc88", title: "LIKE ME", channel: "Future - Topic", durationSec: 133, rank: 7 };
  assert.equal(videoMatchesRequest({ title: "LIKE ME (feat. 42 Dugg & Lil Baby)", artist: "Future", durationSec: 132.987 }, topic), true);
});

test("an official video can run longer than the chart duration, and a lyric upload cannot", () => {
  const official = { id: "4F_vcZ6KD9Q", title: "Lil Baby - In A Minute (Official Video)", channel: "LilBabyVEVO", durationSec: 207, rank: 0 };
  const lyric = { id: "lyricvideoid", title: "Lil Baby - In A Minute (Lyric Video)", channel: "LilBabyVEVO", durationSec: 201, rank: 1 };
  const wanted = { title: "In A Minute", artist: "Lil Baby", durationSec: 200.471 };
  assert.equal(videoMatchesRequest(wanted, official), true);
  assert.equal(videoMatchesRequest(wanted, lyric), false);
});

test("video titles split into artist and title", () => {
  assert.deepEqual(identityFromVideo({ title: "Lil Baby - Freestyle (Official Audio)", channel: "Lil Baby - Topic" }), { artist: "Lil Baby", title: "Freestyle" });
  assert.deepEqual(identityFromVideo({ title: "Freestyle (Official Audio)", channel: "LilBabyVEVO" }), { artist: "LilBaby", title: "Freestyle" });
});

test("a confident decision is kept and a narrow one asks for a URL", async () => {
  const videos = [official];
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ answers: [{ name: "recording", choice: "vid:abcdefghijk", confidence: 0.91, probabilities: [{ value: "vid:abcdefghijk", probability: 0.84 }, { value: "none", probability: 0.08 }] }] }), { status: 200 });
  }) as typeof fetch;
  const selected = await matchMissingRequest({ query: "Freestyle Lil Baby", recordings: [lilBaby], videos, model: { enabled: true, apiKey: "sk-test" }, fetcher });
  assert.equal(selected?.kind, "video");
  const narrow = await matchMissingRequest({
    query: "Freestyle Lil Baby",
    recordings: [lilBaby],
    videos,
    model: { enabled: true, apiKey: "sk-test" },
    fetcher: (async () => new Response(JSON.stringify({ answers: [{ name: "recording", choice: `rec:${lilBaby.id}|vid:${official.id}`, confidence: 0.7, probabilities: [{ value: `rec:${lilBaby.id}|vid:${official.id}`, probability: 0.52 }, { value: "none", probability: 0.4 }] }] }), { status: 200 })) as typeof fetch,
  });
  assert.equal(narrow, null);
  const fallback = await matchMissingRequest({
    query: "Freestyle Lil Baby",
    recordings: [lilBaby],
    videos,
    model: { enabled: true, apiKey: "sk-test" },
    fetcher: (async () => { throw new Error("offline"); }) as typeof fetch,
  });
  assert.equal(fallback?.kind, "recording");
  assert.equal(calls, 1);
});
