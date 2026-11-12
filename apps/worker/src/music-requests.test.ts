import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { artistCreditsMatch, audioSearchQueries, audioSearchSatisfied, audioSourceRejection, audioSourceScore, downloadedLengthMatches, pauseYoutubeSearch, recordingDurationMatches, reserveYoutubeSearch,
  reviewableAudioSources, sourceSelectionDiagnostics, sourceSelectionMessage, validatedViewCount, withInferredDurations, YoutubeSearchDeferredError,
  youtubeSearchDay } from "@mint/core/matching";
import { addMatchLogLine, emptyMatchReport, formatMatchReport, MATCH_FAILURE_MESSAGE } from "./match-report";
import { encrypt } from "@mint/core/crypto";
import { closeDb, getDb } from "@mint/core/db";
import { YoutubeScrapeAccessError, type ScrapedYoutubeVideo } from "@mint/core/youtube-scrape";
import { classifyRequestedVideo } from "./services/matching-classifier";
import { wireIntegrations } from "./integrations";
import { log } from "./log";
import { audioCandidate, findRequestedVideo, sameRequestedVersion, selectRequestedVideo, validateRequestedVideo, videosById, type YtVideo } from "./services/youtube";

const requested = { title: "First Light", artist: "Mint Fixture", durationSec: 181 };
const audio: YtVideo = { id: "audio000001", title: "Mint Fixture - First Light (Official Audio)", channelTitle: "Mint Fixture",
  description: "", categoryId: "10", durationIso: "PT2M56S" };
const vevo: YtVideo = { ...audio, id: "vevo0000001", title: "Mint Fixture - First Light (Audio)", channelTitle: "MintFixtureVEVO" };
const topic: YtVideo = { ...audio, id: "topic000001", title: "First Light", channelTitle: "Mint Fixture - Topic" };
const lyric: YtVideo = { ...audio, id: "lyric000001", title: "Mint Fixture - First Light (Lyrics)", channelTitle: "Fictional Lyrics",
  durationIso: "PT3M1S", viewCount: 12345 };
const video: YtVideo = { ...audio, id: "video000001", title: "Mint Fixture - First Light (Official Music Video)", channelTitle: "MintFixtureVEVO",
  durationIso: "PT4M2S" };
const apiKey = "sk-fixture-not-a-real-key";

test("official audio, VEVO audio, Topic, then real view-count lyric fallback", () => {
  const pool = [lyric, topic, vevo, audio, video];
  assert.equal(selectRequestedVideo(requested, pool), audio.id);
  assert.equal(selectRequestedVideo(requested, pool.filter((item) => item.id !== audio.id)), vevo.id);
  assert.equal(selectRequestedVideo(requested, [topic, lyric, video]), topic.id);
  assert.equal(selectRequestedVideo(requested, [video, lyric]), lyric.id);
  assert.equal(selectRequestedVideo(requested, [{ ...lyric, id: "less0000001", viewCount: 1 }, lyric]), lyric.id);
  assert.equal(selectRequestedVideo(requested, [lyric, { ...lyric, id: "tie00000001" }]), lyric.id);
});

test("structured names support collaboration separators, aliases, punctuation and diacritics without inventing guests", () => {
  for (const artist of ["Mint Fixture / Amber Example", "Mint Fixture and Amber Example", "Mint Fixture featuring Amber Example"]) {
    assert.equal(artistCreditsMatch(artist, [{ name: "Mint Fixture" }, { name: "Amber Example" }]), true);
    assert.equal(selectRequestedVideo({ ...requested, artist }, [{
      ...vevo, title: "Mint Fixture, Amber Example - First Light (Audio)",
    }]), vevo.id);
  }
  assert.equal(artistCreditsMatch("Earth, Wind & Fire", [{ name: "Earth, Wind & Fire" }]), true);
  assert.equal(artistCreditsMatch("Florence and the Machine", [{ name: "Florence and the Machine" }]), true);
  assert.equal(artistCreditsMatch("AC/DC", [{ name: "AC/DC" }]), true);
  assert.equal(artistCreditsMatch("Sigur Ros", [{ name: "Sigur R\u00f3s" }]), true);
  assert.equal(artistCreditsMatch("Mint", [{ name: "Mint Fixture", aliases: ["Mint"] }]), true);
  for (const artist of ["Mint Fixture and Wrong Guest", "Mint Fixture and Amber Example and Wrong Guest", "Amber Example and Mint Fixture"]) {
    assert.equal(artistCreditsMatch(artist, [{ name: "Mint Fixture" }, { name: "Amber Example" }]), false);
  }
  assert.equal(selectRequestedVideo(requested, [{ ...audio, title: "Mint Fixture, Wrong Guest - First Light (Official Audio)" }]), null);
  for (const artist of ["Earth, Wind & Fire", "Florence and the Machine", "AC/DC", "Sigur R\u00f3s"]) {
    assert.equal(selectRequestedVideo({ ...requested, artist }, [{ ...audio, title: `${artist} - First Light (Official Audio)`,
      channelTitle: artist }]), audio.id, "whole band-name channel association survives punctuation");
  }
});

test("a collaboration credited 'with' a guest accepts that guest's remix label only with duration evidence", () => {
  assert.equal(artistCreditsMatch("Mint Fixture with Amber Example", [{ name: "Mint Fixture" }, { name: "Amber Example" }]), true);
  const wanted = { title: "First Light", artist: "Mint Fixture with Amber Example", durationSec: 210 };
  const guestRemix: YtVideo = { ...lyric, id: "guestremix1", title: "Mint Fixture, Amber Example - First Light (Amber Example Remix) (Lyrics)",
    durationIso: "PT3M30S", viewCount: 63_000_000 };
  const labelled: YtVideo = { ...guestRemix, id: "guestremix2", title: "Mint Fixture - First Light (Amber Example Remix - Official Lyric Video) ft. Amber Example" };
  const solo: YtVideo = { ...lyric, id: "solooriginl", title: "Mint Fixture - First Light (Lyrics)", durationIso: "PT3M26S", viewCount: 90_000_000 };
  assert.equal(selectRequestedVideo(wanted, [solo, guestRemix]), guestRemix.id, "the solo cut fails duration; the guest label is the request");
  assert.equal(selectRequestedVideo(wanted, [labelled]), labelled.id);
  assert.equal(selectRequestedVideo({ ...wanted, durationSec: null }, [guestRemix]), null, "unconfirmed remix labels stay a different version");
  for (const title of ["Mint Fixture - First Light (Wrong Guest Remix) (Lyrics)", "Mint Fixture - First Light (Amber Example Remix) (Official Video)"]) {
    assert.equal(selectRequestedVideo(wanted, [{ ...guestRemix, title }]), null, title);
  }
  assert.equal(selectRequestedVideo({ ...wanted, artist: "Mint Fixture" }, [guestRemix]), null, "an uncredited remixer is another version");
});

test("181/176 studio audio is allowed but 242-second or same-duration music videos never are", () => {
  assert.equal(selectRequestedVideo(requested, [audio]), audio.id);
  for (const item of [video, { ...video, durationIso: "PT3M1S" }, { ...audio, title: `${audio.title} (Official HD Video)` },
    { ...vevo, title: "Mint Fixture - First Light" }, { ...topic, title: "First Light (Official Video)" }]) {
    assert.equal(selectRequestedVideo(requested, [item]), null);
  }
  for (const seconds of [173, 189, 242, 0, NaN, Infinity]) assert.equal(recordingDurationMatches(181, seconds, "official-audio"), false);
  assert.equal(recordingDurationMatches(1000, 1011, "official-audio"), false, "absolute bound remains ten seconds");
  assert.equal(recordingDurationMatches(181, 176, "lyric"), false);
});

test("identity, collaboration, version, missing metadata and equal support stay conservative", () => {
  for (const change of [{ title: "Mint Fixture - Last Light (Official Audio)" },
    { title: "Somebody Else - First Light (Official Audio)" },
    { title: `${audio.title} Preview` }, { title: `${audio.title} live` }, { title: `${audio.title} remix` },
    { title: `${audio.title} cover` }, { title: `${audio.title} acoustic` }, { title: `${audio.title} remastered` },
    { title: `${audio.title} slowed` }, { title: `${audio.title} edit` }, { title: `${audio.title} visualizer` },
    { title: `${audio.title} outro` }, { durationIso: null }, { durationIso: "PT0S" }, { durationIso: "PT4M" }]) {
    assert.equal(selectRequestedVideo(requested, [{ ...audio, ...change }]), null, JSON.stringify(change));
  }
  assert.equal(selectRequestedVideo({ ...requested, durationSec: null }, [audio]), audio.id);
  const fanAudio = { ...audio, channelTitle: "Somebody Else" };
  assert.equal(selectRequestedVideo(requested, [fanAudio]), audio.id, "an official-audio upload with a matching length is enough evidence");
  assert.equal(selectRequestedVideo({ ...requested, durationSec: null }, [fanAudio]), null, "but not without a length");
  assert.equal(selectRequestedVideo({ ...requested, artist: "" }, [audio]), null);
  assert.equal(selectRequestedVideo(requested, [audio, { ...audio, id: "tie00000001" }]), audio.id);
  assert.equal(selectRequestedVideo(requested, [{ ...audio, viewCount: 10 }, { ...audio, id: "tie00000001", viewCount: 20 }]), "tie00000001");
  assert.equal(selectRequestedVideo(requested, [{ ...audio, rank: 2 }, { ...audio, id: "tie00000001", rank: 1 }]), "tie00000001");
  assert.equal(selectRequestedVideo({ ...requested, durationSec: null }, [lyric]), null);
  assert.equal(selectRequestedVideo({ ...requested, durationSec: null }, [topic]), null);
  assert.equal(selectRequestedVideo(requested, [{ ...lyric, viewCount: undefined }]), null);
  assert.equal(selectRequestedVideo({ ...requested, artist: "Mint Fixture / Amber Example" }, [topic]), topic.id);
  assert.equal(selectRequestedVideo({ ...requested, artist: "Mint Fixture & Amber Example" }, [{ ...topic, channelTitle: "Amber Example - Topic" }]), null);
  assert.equal(sameRequestedVersion("First Light", "First Light (Lyrics)"), true);
  assert.equal(sameRequestedVersion("First Light (Live)", "First Light"), false);
  assert.equal(selectRequestedVideo(requested, [{ ...audio, title: "Mint Fixture - First Light (feat. Unrelated Singer) (Official Audio)" }]), null);
  assert.equal(selectRequestedVideo({ ...requested, artist: "Mint Fixture / Amber Example" },
    [{ ...audio, title: "Mint Fixture - First Light (feat. Amber Example) (Official Audio)" }]), audio.id);
});

test("diagnostics separate missing candidates, metadata, unsafe versions, identity and duration", () => {
  assert.match(sourceSelectionMessage(requested, []), /no source candidates/);
  for (const [candidate, expected] of [[video, "music-video"], [{ ...audio, durationIso: null }, "metadata"],
    [{ ...audio, durationIso: "PT4M" }, "duration"], [{ ...audio, title: `${audio.title} remix` }, "version"],
    [{ ...audio, title: "Wrong Song" }, "identity"]] as const) {
    assert.equal(audioSourceRejection(requested, audioCandidate(candidate)), expected);
  }
});

test("remaster labels, unlabelled artist-channel uploads and credit-free queries widen matching only with duration evidence", () => {
  const queen = { title: "Bohemian Rhapsody", artist: "Queen", durationSec: 355 };
  const remasterTopic: YtVideo = { ...topic, id: "remaster001", title: "Bohemian Rhapsody (Remastered 2011)", channelTitle: "Queen - Topic", durationIso: "PT5M55S" };
  assert.equal(selectRequestedVideo(queen, [remasterTopic]), remasterTopic.id);
  for (const title of ["Bohemian Rhapsody - Remastered 2011", "Bohemian Rhapsody (2011 Remaster)", "Bohemian Rhapsody [Digitally Remastered]"]) {
    assert.equal(selectRequestedVideo(queen, [{ ...remasterTopic, title }]), remasterTopic.id, title);
  }
  assert.equal(selectRequestedVideo({ ...queen, title: "Bohemian Rhapsody (Remastered 2011)" }, [{ ...remasterTopic, title: "Bohemian Rhapsody" }]), remasterTopic.id);
  assert.equal(selectRequestedVideo({ ...queen, durationSec: null }, [remasterTopic]), null, "no remaster equivalence without an expected length");
  assert.equal(selectRequestedVideo(queen, [{ ...remasterTopic, durationIso: "PT6M10S" }]), null);
  assert.equal(selectRequestedVideo(queen, [{ ...remasterTopic, title: "Bohemian Rhapsody (Live Aid Remastered)" }]), null);

  const plain: YtVideo = { ...audio, id: "plain000001", title: "Mint Fixture - First Light", channelTitle: "Mint Fixture", durationIso: "PT3M1S" };
  assert.equal(selectRequestedVideo(requested, [plain]), plain.id);
  assert.equal(selectRequestedVideo(requested, [plain, lyric]), plain.id, "an exact-length artist-channel upload outranks a third-party lyric upload");
  assert.equal(selectRequestedVideo(requested, [{ ...plain, durationIso: "PT2M57S" }]), null, "unlabelled uploads need a 2.5 second match");
  assert.equal(selectRequestedVideo({ ...requested, durationSec: null }, [plain]), null);
  for (const change of [{ channelTitle: "MintFixtureVEVO" }, { channelTitle: "Fan Uploads" },
    { title: "Mint Fixture - First Light (Teaser)" }, { title: "Mint Fixture - First Light | Live Session" }]) {
    assert.equal(selectRequestedVideo(requested, [{ ...plain, ...change }]), null, JSON.stringify(change));
  }

  assert.deepEqual(audioSearchQueries("Mark Ronson Uptown Funk (feat. Bruno Mars)").map((query) => query.q)[3], "Mark Ronson Uptown Funk");
  assert.equal(audioSearchQueries("Queen Bohemian Rhapsody - Remastered 2011")[3]!.q, "Queen Bohemian Rhapsody");
  assert.equal(audioSearchQueries("Mark Ronson Uptown Funk ft. Bruno Mars")[3]!.q, "Mark Ronson Uptown Funk");
  assert.equal(audioSearchQueries("Mint Fixture First Light").length, 5, "no duplicate credit-free round");
  assert.equal(audioSearchSatisfied([audioCandidate(plain)], 1), false);
  assert.equal(audioSearchSatisfied([audioCandidate(plain)], 2), true, "any eligible source skips the credit-free round");
});

test("diagnostics name the deciding rejection and the report tallies it", () => {
  const diagnostic = sourceSelectionDiagnostics(requested, [audioCandidate(video), audioCandidate({ ...audio, durationIso: "PT4M" })]);
  assert.equal(diagnostic.closestRejection, "duration");
  assert.deepEqual(diagnostic.rejectionCounts, { "music-video": 1, duration: 1 });
  assert.equal(sourceSelectionDiagnostics(requested, []).closestRejection, null);
  const report = emptyMatchReport();
  for (const line of [
    JSON.stringify({ msg: MATCH_FAILURE_MESSAGE, ...diagnostic }),
    JSON.stringify({ msg: MATCH_FAILURE_MESSAGE, closestRejection: "identity", rejectionCounts: { identity: 3 }, expected: { artist: "A", title: "B" } }),
    JSON.stringify({ msg: "unrelated", closestRejection: "duration" }), "not json " + MATCH_FAILURE_MESSAGE,
  ]) addMatchLogLine(report, line);
  assert.equal(report.failures, 2);
  assert.deepEqual(report.closest, { duration: 1, identity: 1 });
  assert.deepEqual(report.candidates, { "music-video": 1, duration: 1, identity: 3 });
  assert.match(formatMatchReport(report), /duration\s+1/);
});

test("real misses: labelled remix audio, small catalog length drift and chopped editions", () => {
  const lemon = { title: "Lemon (Drake remix)", artist: "N.E.R.D & Rihanna feat. Drake", durationSec: 220 };
  const remixAudio: YtVideo = { ...audio, id: "fzCct3j-pH8", title: "N.E.R.D, Rihanna - Lemon (Drake Remix - Audio) ft. Drake", channelTitle: "NERD", durationIso: "PT3M48S" };
  assert.equal(selectRequestedVideo(lemon, [remixAudio]), remixAudio.id);
  assert.equal(selectRequestedVideo(lemon, [{ ...remixAudio, title: "N.E.R.D, Rihanna - Lemon (Drake Remix) (Clean Edit)" }]), null);
  assert.equal(selectRequestedVideo(lemon, [{ ...remixAudio, durationIso: "PT3M51S" }]), null, "more than 10 seconds off");
  assert.equal(selectRequestedVideo({ ...lemon, title: "Lemon" }, [remixAudio]), null, "a remix never stands in for the original");
  assert.equal(selectRequestedVideo(requested, [{ ...audio, title: "Mint Fixture - First Light (8D Audio)" }]), null);
  assert.equal(recordingDurationMatches(181, 188, "official-audio"), true);
  assert.equal(recordingDurationMatches(181, 189, "official-audio"), false);
  assert.equal(recordingDurationMatches(400, 410, "topic-audio"), true);
  assert.equal(recordingDurationMatches(400, 411, "topic-audio"), false, "capped at 10 seconds");
  assert.equal(recordingDurationMatches(181, 184, "lyric"), false);
  const connect = { title: "Connect", artist: "Drake", durationSec: 295 };
  const chopped: YtVideo = { ...audio, id: "chopped0001", title: "Drake - Connect (Chopped and Screwed) (Official Audio)", channelTitle: "Drake", durationIso: "PT4M55S" };
  assert.equal(selectRequestedVideo(connect, [chopped]), null);
});

test("import and selection agree on typographic artist/title separators without weakening identity or version checks", () => {
  for (const separator of ["-", "\u2013", "\u2014"]) {
    const candidate = { ...audio, title: `Mint Fixture ${separator} First Light (Official Audio)` };
    assert.equal(selectRequestedVideo(requested, [candidate]), audio.id);
    assert.equal(selectRequestedVideo({ ...requested, durationSec: null }, [candidate]), audio.id);
    for (const title of [`Other Artist ${separator} First Light (Official Audio)`,
      `Mint Fixture ${separator} Other Song (Official Audio)`, `${candidate.title} (Live)`,
      `Mint Fixture ${separator} First Light (Official Music Video)`]) {
      assert.equal(selectRequestedVideo(requested, [{ ...candidate, title }]), null);
    }
  }
});

test("failed-source diagnostics expose individual metadata gaps, not descriptions or media URLs", () => {
  const diagnostic = sourceSelectionDiagnostics({ ...requested, durationSec: null },
    [audioCandidate(audio), audioCandidate({ ...lyric, viewCount: undefined }), audioCandidate(video)]);
  assert.equal(diagnostic.expected.durationSec, null);
  assert.equal(diagnostic.candidates[0]!.rejection, null);
  assert.deepEqual(diagnostic.candidates[1]!.missing, ["expected-duration"]);
  assert.equal(diagnostic.candidates[2]!.rejection, "music-video");
  assert.equal(diagnostic.candidates[1]!.kind, "lyric");
  assert.equal(diagnostic.candidates[0]!.durationSec, 176);
  const bounded = sourceSelectionDiagnostics({ ...requested, title: "x".repeat(300) },
    Array.from({ length: 40 }, () => ({ ...audioCandidate(audio), channel: "a\n".repeat(300), description: "private-url" })));
  assert.equal(bounded.expected.title.length, 200);
  assert.equal(bounded.candidates.length, 40);
  assert.equal(bounded.candidates[0]!.channel.length, 200);
  assert.ok(!JSON.stringify(bounded).includes("private-url"));
  assert.ok(!bounded.candidates[0]!.channel.includes("\n"));
});

test("alternative official lengths enable popular lyric audio but reject a short namesake Topic upload", async () => {
  const wanted = { ...requested, durationSec: null, officialDurationsSec: [267, 229] };
  const shortTopic = { ...topic, durationIso: "PT2M34S" };
  const longVideo = { ...video, durationIso: "PT4M56S" };
  const popular = { ...lyric, durationIso: "PT4M28S", viewCount: 9000 };
  const lessPopular = { ...popular, id: "less0000001", viewCount: 100 };
  const unverified = [
    { ...audio, title: "Mint Fixture - First Light (Explicit)", durationIso: "PT4M26S" },
    { ...audio, channelTitle: "Mint Fixture Media", durationIso: "PT4M27S" },
    { ...audio, title: "Mint Fixture - First Light", channelTitle: "Fictional Entertainment", durationIso: "PT4M28S" },
  ];
  const pool = [shortTopic, longVideo, ...unverified, lessPopular, popular];
  assert.equal(selectRequestedVideo(wanted, pool), popular.id);
  assert.equal(audioSourceRejection(wanted, audioCandidate(shortTopic)), "duration");
  assert.equal(audioSourceRejection(wanted, audioCandidate(longVideo)), "music-video");
  assert.deepEqual(unverified.map((candidate) => audioSourceRejection(wanted, audioCandidate(candidate))),
    ["identity", null, "unverified-source"], "an official-audio label with an official length is evidence; an unlabelled third-party upload is not");
  assert.equal(selectRequestedVideo({ ...wanted, durationSec: 229 }, [popular]), null, "alternatives never override a known recording length");
  assert.equal(selectRequestedVideo({ ...wanted, officialDurationsSec: [NaN, -1] }, [shortTopic, popular]), null);
  assert.equal(selectRequestedVideo(wanted, [{ ...popular, durationIso: "PT4M31S" }]), null, "lyric tolerance stays 2.5 seconds");
  assert.equal(selectRequestedVideo(wanted, [{ ...shortTopic, durationIso: "PT3M49S" }, popular]), shortTopic.id);
  assert.equal(selectRequestedVideo(wanted, [
    { ...topic, durationIso: "PT4M25S", viewCount: 9000 },
    { ...topic, id: "closer00001", durationIso: "PT3M50S", viewCount: 1 },
  ]), "closer00001", "duration closeness is measured against the nearest official length before studio-audio views");
  assert.equal(selectRequestedVideo(wanted, [{ ...popular, title: `${popular.title} (Live)` }]), null);
  const chosen = await classifyRequestedVideo(wanted, pool, { enabled: true, apiKey, fetchImpl: async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.questions[0].choices.map((item: { value: string }) => item.value), [popular.id, "none"]);
    assert.deepEqual(body.input[0].content[1].data.requested.official_durations_seconds, [267, 229]);
    return classifierResponse(shortTopic.id);
  } });
  assert.deepEqual(chosen, { status: "fallback", reason: "invalid" }, "AI cannot restore the namesake Topic candidate");
});

function classifierResponse(choice: string, confidence = 0.9,
  probabilities: Record<string, number> = { [choice]: 0.8, [choice === "none" ? audio.id : "none"]: 0.1 }) {
  return Response.json({ answers: [{ type: "choice", name: "recording", choice, confidence,
    probabilities: Object.entries(probabilities).map(([value, probability]) => ({ value, probability })) }] });
}

test("AI cannot override safety, source priority, identity, duration or lyric popularity", async () => {
  for (const forbidden of [video, topic, lyric, { ...audio, id: "wrong000001", durationIso: "PT5M" }]) {
    const result = await classifyRequestedVideo(requested, [audio, forbidden], {
      enabled: true, apiKey, fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        const choices = body.questions[0].choices.map((item: { value: string }) => item.value);
        assert.deepEqual(choices, [audio.id, "none"]);
        return classifierResponse(forbidden.id);
      },
    });
    assert.deepEqual(result, { status: "fallback", reason: "invalid" });
  }
  assert.deepEqual(await classifyRequestedVideo(requested, [audio], {
    enabled: true, apiKey, fetchImpl: async () => classifierResponse(audio.id),
  }), { status: "selected", id: audio.id, confidence: 0.9 });
});

test("AI handles none, uncertainty, unavailable and disabled without weakening deterministic policy", async () => {
  const run = (fetchImpl: typeof fetch) => classifyRequestedVideo(requested, [audio], { enabled: true, apiKey, fetchImpl });
  assert.deepEqual(await run(async () => classifierResponse("none")), { status: "none", confidence: 0.9 });
  assert.deepEqual(await run(async () => classifierResponse(audio.id, 0.4)), { status: "fallback", reason: "uncertain" });
  assert.deepEqual(await run(async () => classifierResponse(audio.id, 0.9, { [audio.id]: 0.51, none: 0.49 })),
    { status: "fallback", reason: "uncertain" });
  assert.deepEqual(await run(async () => Response.json({ answers: [] })), { status: "fallback", reason: "invalid" });
  assert.deepEqual(await run(async () => { throw new Error("offline"); }), { status: "fallback", reason: "unavailable" });
  assert.deepEqual(await classifyRequestedVideo(requested, [audio], { enabled: false }), { status: "fallback", reason: "disabled" });
  assert.deepEqual(await classifyRequestedVideo(requested, [audio], { enabled: true }), { status: "fallback", reason: "unconfigured" });
  assert.deepEqual(await classifyRequestedVideo(requested, [video], { enabled: true, apiKey }), { status: "fallback", reason: "invalid" });
  assert.deepEqual(await classifyRequestedVideo(requested, [audio], { enabled: true, apiKey, timeoutMs: 5,
    fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("Fixture did not abort")), 100);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(new DOMException("Timed out", "AbortError"));
      }, { once: true });
    }) }), { status: "fallback", reason: "unavailable" });
});

test("AI sends at most ten public candidates and no provider descriptions or credentials", async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ ...audio, id: `fixture${String(i).padStart(4, "0")}`, description: "not for model" }));
  await classifyRequestedVideo(requested, many, { enabled: true, apiKey, fetchImpl: async (_input, init) => {
    const text = String(init?.body), body = JSON.parse(text);
    assert.equal(body.questions[0].choices.length, 11);
    assert.ok(!text.includes("not for model") && !text.includes(apiKey));
    return classifierResponse(many[0]!.id);
  } });
});

test("provider details request real statistics and validate counts rather than inventing popularity", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    calls++;
    const url = new URL(input);
    assert.ok(url.searchParams.get("part")?.includes("statistics"));
    return Response.json({ items: [
      { id: audio.id, snippet: { title: audio.title, channelTitle: audio.channelTitle }, contentDetails: { duration: audio.durationIso }, statistics: { viewCount: "12345" } },
      { id: lyric.id, snippet: { title: lyric.title, channelTitle: lyric.channelTitle }, contentDetails: { duration: lyric.durationIso }, statistics: { viewCount: "1.2M" } },
    ] });
  });

  const found = await videosById("fixture-token", [audio.id, lyric.id]);
  assert.equal(found[0]!.viewCount, 12345);
  assert.equal(found[1]!.viewCount, null);
  assert.equal(calls, 1);
  for (const value of ["", "12K", "-1", 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, null]) assert.equal(validatedViewCount(value), null);
  assert.equal(validatedViewCount("0"), 0);
  assert.deepEqual(audioSearchQueries("Mint Fixture First Light").map((query) => query.order), ["relevance", "relevance", "viewCount", "relevance", "relevance"]);
});

test("requested and pinned worker paths use bounded provider evidence and never substitute unsafe pins", async (t) => {
    const savedUrl = process.env.DATABASE_URL, savedKey = process.env.ENCRYPTION_KEY;
    process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/unused";
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    try {
      const db = getDb();
      let active = true;
      t.mock.method(db.query.users, "findFirst", async () => ({ status: active ? "active" : "disabled" }));
      t.mock.method(db.query.youtubeAccounts, "findFirst", async () => ({
        expiresAt: new Date(Date.now() + 3600_000), accessTokenEnc: encrypt("fixture-access-token"),
      }));
      t.mock.method(db, "select", () => { throw new Error("Fixture matching settings unavailable"); });
      let pool = [video, lyric, topic, vevo, audio], unavailable = false, failProvider = false;
      let details = 0;
      const warnings: Array<Record<string, unknown>> = [];
      t.mock.method(log, "warn", (data: unknown) => {
        if (data && typeof data === "object") warnings.push(data as Record<string, unknown>);
      });
      let searchPools: YtVideo[][] | null = null;
      const searches: URL[] = [];
      const find = (track = requested) => findRequestedVideo("fixture-member", track, { reserve: async () => {}, pause: async () => {} });
      t.mock.method(globalThis, "fetch", async (input: string) => {
        const url = new URL(input);
        assert.equal(url.origin, "https://www.googleapis.com", "no media download or other network access");
        if (failProvider) return new Response("fixture provider refusal", { status: 403 });
        if (url.pathname.endsWith("/search")) {
          searches.push(url);
          assert.equal(url.searchParams.get("maxResults"), "10");
          return Response.json({ items: (searchPools?.[searches.length - 1] ?? pool).map((item) => ({ id: { videoId: item.id } })) });
        }
        assert.equal(url.pathname, "/youtube/v3/videos");
        details++;
        const ids = url.searchParams.get("id")!.split(",");
        assert.equal(new Set(ids).size, ids.length, "overlapping searches deduplicate IDs");
        return Response.json({ items: unavailable ? [] : pool.filter((item) => ids.includes(item.id)).map((item) => ({
          id: item.id, snippet: { title: item.title, channelTitle: item.channelTitle, categoryId: item.categoryId },
          contentDetails: { duration: item.durationIso }, statistics: { viewCount: item.viewCount?.toString() },
        })) });
      });
      assert.equal(await find(), audio.id);
      assert.deepEqual(searches.map((url) => url.searchParams.get("order")), ["relevance"]);
      assert.equal(details, 1);
      for (const [candidate, count] of [[vevo, 1], [topic, 1], [lyric, 3],
        [{ ...audio, title: "Mint Fixture \u2013 First Light (Official Audio)" }, 1]] as const) {
        pool = [candidate]; searches.length = 0; details = 0;
        assert.equal(await find(), candidate.id);
        assert.equal(searches.length, count);
        assert.equal(details, 1, "overlapping rounds do not fetch old IDs again");
      }
      pool = [video, topic, lyric]; searchPools = [[video], [video, topic], [lyric]];
      searches.length = 0; details = 0;
      assert.equal(await find(), topic.id);
      assert.equal(searches.length, 2);
      assert.equal(details, 2);
      searchPools = null;
      pool = [audio];
      await validateRequestedVideo("fixture-member", requested, audio.id);
      await validateRequestedVideo("fixture-member", { ...requested, durationSec: null }, audio.id);
      searches.length = 0;
      assert.equal(await findRequestedVideo("fixture-member", { ...requested, durationSec: null }, { reserve: async () => {} }), audio.id);
      assert.equal(searches.length, 1);
      pool = [{ ...topic, durationIso: "PT2M34S" }, { ...lyric, durationIso: "PT4M28S" }];
      searches.length = 0;
      let selectedDuration: number | null = null;
      assert.equal(await findRequestedVideo("fixture-member", {
        ...requested, durationSec: null, officialDurationsSec: [267, 229],
      }, { reserve: async () => {}, onSelected: (candidate) => {
        selectedDuration = candidate.durationSec;
      } }), lyric.id);
      assert.equal(searches.length, 3, "the short namesake Topic result cannot stop the lyric search");
      assert.equal(selectedDuration, 268);
      pool = [{ ...audio, channelTitle: "Fictional Label" }];
      await validateRequestedVideo("fixture-member", requested, audio.id);
      pool = [video];
      await assert.rejects(validateRequestedVideo("fixture-member", requested, video.id), /Pinned source rejected.*music videos are not allowed/);
      pool = [{ ...video, durationIso: "PT3M1S" }];
      await assert.rejects(validateRequestedVideo("fixture-member", requested, video.id), /music videos are not allowed/);
      await assert.rejects(find(), { name: "UnrecoverableError", message: /music videos are not allowed/ });
      assert.deepEqual(warnings.at(-1), {
        ...sourceSelectionDiagnostics(requested, pool.map(audioCandidate)),
        rounds: [{ round: 1, freshIds: 1, metadataCount: 1 }, { round: 2, freshIds: 0, metadataCount: 0 },
          { round: 3, freshIds: 0, metadataCount: 0 }, { round: 4, freshIds: 0, metadataCount: 0 }, { round: 5, freshIds: 0, metadataCount: 0 }],
      });
      pool = [audio]; unavailable = true;
      await assert.rejects(validateRequestedVideo("fixture-member", requested, audio.id), /metadata is unavailable/);
      await assert.rejects(find(), { name: "Error", message: /metadata is unavailable/ });
      unavailable = false; pool = [];
      await assert.rejects(find(), { name: "UnrecoverableError", message: /no source candidates/ });
      pool = [audio]; failProvider = true;
      await assert.rejects(find(), (error: Error) =>
        error.name !== "UnrecoverableError" && /403/.test(error.message));
      failProvider = false; searches.length = 0;
      await assert.rejects(findRequestedVideo("fixture-member", requested, {
        reserve: async () => { throw new YoutubeSearchDeferredError("Quota cooldown", 300_000); },
      }), YoutubeSearchDeferredError);
      assert.equal(searches.length, 0, "waiting jobs must not spend provider quota");
      pool = [lyric]; searches.length = 0;
      let reservations = 0;
      assert.equal(await findRequestedVideo("fixture-member", requested, { reserve: async () => {
        if (++reservations === 2) throw new YoutubeSearchDeferredError("Quota cooldown", 300_000);
      } }), lyric.id, "eligible lyric from round one survives exhausted quota in round two");
      assert.equal(searches.length, 1);
      assert.ok(warnings.some((warning) => warning.reason === "quota-or-budget"));
      active = false;
      await assert.rejects(validateRequestedVideo("fixture-member", requested, audio.id), /no longer has approved access/);
    } finally {
      await closeDb();
      if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
      if (savedKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = savedKey;
    }
});

test("provider failures preserve only eligible completed rounds and remain retryable without one", async (t) => {
  const savedUrl = process.env.DATABASE_URL, savedKey = process.env.ENCRYPTION_KEY;
  process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/unused";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
  try {
    const db = getDb();
    t.mock.method(db.query.users, "findFirst", async () => ({ status: "active" }));
    t.mock.method(db.query.youtubeAccounts, "findFirst", async () => ({
      expiresAt: new Date(Date.now() + 3600000), accessTokenEnc: encrypt("fixture"),
    }));
    t.mock.method(db, "select", () => { throw new Error("Fixture matching settings unavailable"); });
    const failures = [
      () => new Response("quotaExceeded", { status: 403 }),
      () => new Response("busy", { status: 429 }),
      () => new Response("busy", { status: 503 }),
      () => { throw new Error("network unavailable"); },
      () => Response.json({ unexpected: [] }),
      () => new Response("{invalid-json"),
    ];
    let response: () => Response = failures[0]!, searches = 0, includeEligible = true, failAtDetails = false;
    t.mock.method(globalThis, "fetch", async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/search")) {
        searches++;
        if (searches > 1 || !includeEligible) return failAtDetails
          ? Response.json({ items: [{ id: { videoId: audio.id } }] }) : response();
        return Response.json({ items: [{ id: { videoId: lyric.id } }] });
      }
      if (failAtDetails && (searches > 1 || !includeEligible)) return response();
      return Response.json({ items: [{ id: lyric.id, snippet: { title: lyric.title, channelTitle: lyric.channelTitle },
        contentDetails: { duration: lyric.durationIso }, statistics: { viewCount: String(lyric.viewCount) } }] });
    });
    for (failAtDetails of [false, true]) for (response of failures) {
      searches = 0; includeEligible = true;
      assert.equal(await findRequestedVideo("member", requested, { reserve: async () => {}, pause: async () => {} }), lyric.id);
      searches = 0; includeEligible = false;
      await assert.rejects(findRequestedVideo("member", requested, { reserve: async () => {}, pause: async () => {} }),
        (error: Error) => error.name !== "UnrecoverableError");
    }
    failAtDetails = false;
    for (const status of [401, 403]) {
      searches = 0; includeEligible = true; response = () => new Response("permission refused", { status });
      await assert.rejects(findRequestedVideo("member", requested, { reserve: async () => {}, pause: async () => {} }),
        { status }, "revoked access must not reuse earlier account results");
    }
  } finally {
    await closeDb();
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = savedKey;
  }
});

test("authorized worker matching and pins use public metadata without accounts, API quota or unsafe substitution", async (t) => {
  const savedUrl = process.env.DATABASE_URL, savedFlag = process.env.YOUTUBE_SCRAPE_AUTHORIZED;
  process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/unused";
  process.env.YOUTUBE_SCRAPE_AUTHORIZED = "true";
  try {
    const db = getDb();
    let active = true, searches = 0, details = 0, providerCalls = 0;
    t.mock.method(db.query.users, "findFirst", async () => ({ status: active ? "active" : "disabled" }));
    t.mock.method(db.query.youtubeAccounts, "findFirst", async () => { throw new Error("OAuth must not be used"); });
    t.mock.method(db, "select", () => { throw new Error("Fixture matching settings unavailable"); });
    t.mock.method(globalThis, "fetch", async () => { providerCalls++; throw new Error("Unexpected provider request"); });
    const first: ScrapedYoutubeVideo = { ...audioCandidate(audio), viewCount: 200, rank: 0 };
    const next: ScrapedYoutubeVideo = { ...first, id: "audio000002", viewCount: 100, rank: 1 };
    const unsafe: ScrapedYoutubeVideo = { ...audioCandidate(video), viewCount: 300, rank: 2 };
    let firstAvailable = true;
    const options = {
      reserve: async () => { throw new Error("Data API quota must not be reserved"); },
      pause: async () => { throw new Error("Data API quota must not be paused"); },
      scrapeSearch: async () => { searches++; return [first, next, unsafe]; },
      scrapeVideo: async (id: string) => {
        details++;
        if (id === first.id) return firstAvailable ? first : null;
        if (id === next.id) return next;
        return unsafe;
      },
    };
    assert.equal(await findRequestedVideo("member", requested, options), first.id);
    firstAvailable = false;
    assert.equal(await findRequestedVideo("member", requested, options), next.id, "unavailable automatic sources may be replaced by another eligible source");
    assert.equal(await findRequestedVideo("member", requested, {
      ...options,
      scrapeSearch: async () => [{ ...first, watchVerified: true }],
      scrapeVideo: async () => { throw new Error("A completed watch check must not be repeated during provider cooldown"); },
    }), first.id);
    await validateRequestedVideo("member", requested, next.id, options);
    await assert.rejects(validateRequestedVideo("member", requested, unsafe.id, options), /music videos are not allowed/);
    await assert.rejects(validateRequestedVideo("member", requested, first.id, options), /metadata is unavailable/);
    await assert.rejects(findRequestedVideo("member", requested, {
      ...options, scrapeSearch: async () => { throw new YoutubeScrapeAccessError(); },
    }), YoutubeSearchDeferredError);
    active = false;
    await assert.rejects(findRequestedVideo("member", requested, options), /no longer has approved access/);
    assert.equal(searches, 2);
    assert.equal(details, 6);
    assert.equal(providerCalls, 0, "scraper mode never calls Google, OAuth or media endpoints");
  } finally {
    await closeDb();
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
    if (savedFlag === undefined) delete process.env.YOUTUBE_SCRAPE_AUTHORIZED; else process.env.YOUTUBE_SCRAPE_AUTHORIZED = savedFlag;
  }
});

test("temporary pinned metadata failures delay the real acquisition job without consuming a retry", () => {
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    import * as database from "@mint/core/db";
    import {YoutubeSearchDeferredError} from "@mint/core/matching";
    process.env.INDEX_EXISTING_LIBRARY="false";
    const track={id:"fixture",title:"First Light",artist:"Mint Fixture",durationSec:181,
      youtubeVideoId:"audio000001",existingFilePath:null,filePath:null,stage:"queued"};
    const patches=[];
    mock.module("@mint/core/db",{namedExports:{...database,getDb:()=>({query:{tracks:{findFirst:async()=>track}}})}});
    mock.module(new URL("./src/queues.ts",import.meta.url),{namedExports:{queues:{},connection:{}}});
    mock.module(new URL("./src/track-state.ts",import.meta.url),{namedExports:{
      updateTrack:async(_id,patch)=>patches.push(patch),stage:async()=>{},progress:async()=>{}
    }});
    mock.module(new URL("./src/services/youtube.ts",import.meta.url),{namedExports:{NeedsSourceError:class NeedsSourceError extends Error{},
      findRequestedVideo:async()=>null,validateRequestedVideo:async()=>{throw new YoutubeSearchDeferredError("metadata waiting",45000);}
    }});
    const {processAcquire}=await import("./src/jobs/acquire.ts");
    const before=Date.now();
    let delayedUntil=0;
    const job={data:{trackId:track.id,requestedBy:"member",step:"cobalt"},
      async updateData(data){this.data=data;},async moveToDelayed(time){delayedUntil=time;}};
    await assert.rejects(processAcquire(job),{name:"DelayedError"});
    assert.equal(patches.at(-1).stage,"queued");
    assert.equal(patches.at(-1).detail,"metadata waiting");
    assert.ok(delayedUntil >= before+45000);
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("legacy jobs without a requester resolve an approved owner under the selected provider mode", () => {
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    import * as database from "@mint/core/db";
    process.env.INDEX_EXISTING_LIBRARY="false";
    process.env.YOUTUBE_SCRAPE_AUTHORIZED="true";
    const track={id:"fixture",title:"First Light",artist:"Mint Fixture",durationSec:181,
      youtubeVideoId:null,existingFilePath:null,filePath:null,stage:"queued"};
    let accountJoins=0,memberJoins=0,foundOwner="",verifiedOwner="";
    const db={
      query:{tracks:{findFirst:async()=>({...track})}},
      update:()=>({set:patch=>({where:async()=>Object.assign(track,patch)})}),
      select:()=>{const chain={
        from(table){this.table=table;return this;},
        innerJoin(table){if(table===database.schema.users)memberJoins++;if(table===database.schema.youtubeAccounts)accountJoins++;return this;},
        where(){return this;},
        async limit(){return this.table===database.schema.userTracks?[{userId:"approved-owner"}]:[];}
      };return chain;}
    };
    mock.module("@mint/core/db",{namedExports:{...database,getDb:()=>db}});
    mock.module(new URL("./src/queues.ts",import.meta.url),{namedExports:{queues:{},connection:{}}});
    mock.module(new URL("./src/config.ts",import.meta.url),{namedExports:{config:{remoteMode:"always"}}});
    mock.module(new URL("./src/track-state.ts",import.meta.url),{namedExports:{
      updateTrack:async(_id,patch)=>Object.assign(track,patch),stage:async()=>{},progress:async()=>{}
    }});
    mock.module(new URL("./src/existing-track.ts",import.meta.url),{namedExports:{
      assignSourceVideo:async(_id,videoId)=>{track.youtubeVideoId=videoId;return null;},
      keepExisting:async()=>{},reusePendingTrack:async()=>null
    }});
    mock.module(new URL("./src/services/musicbrainz.ts",import.meta.url),{namedExports:{matchRecording:async()=>null}});
    mock.module(new URL("./src/services/youtube.ts",import.meta.url),{namedExports:{NeedsSourceError:class NeedsSourceError extends Error{},
      findRequestedVideo:async(user)=>{foundOwner=user;return "audio000001";},
      validateRequestedVideo:async(user)=>{verifiedOwner=user;}
    }});
    const {processAcquire}=await import("./src/jobs/acquire.ts");
    const job={data:{trackId:track.id,forceCobalt:true},
      async updateData(data){this.data=data;},async moveToDelayed(){}};
    await assert.rejects(processAcquire(job),{name:"DelayedError"});
    assert.equal(foundOwner,"approved-owner");
    assert.equal((await processAcquire(job)).source,"remote");
    assert.equal(verifiedOwner,"approved-owner");
    assert.equal(accountJoins,0);
    assert.equal(memberJoins,2);
    process.env.YOUTUBE_SCRAPE_AUTHORIZED="false";
    assert.equal((await processAcquire(job)).source,"remote");
    assert.equal(accountJoins,1,"legacy Data API mode still requires a linked owner");
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("the selected official duration survives the Cobalt transition and remote pin validation", () => {
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    import * as database from "@mint/core/db";
    import {audioSourceRejection} from "@mint/core/matching";
    process.env.INDEX_EXISTING_LIBRARY="false";
    const track={id:"fixture",title:"First Light",artist:"Mint Fixture",durationSec:null,
      mbRecordingId:null,youtubeVideoId:null,existingFilePath:null,filePath:null,stage:"queued"};
    const selected={id:"lyric000001",title:"Mint Fixture - First Light (Lyrics)",channel:"Fictional Lyrics",
      durationSec:268,viewCount:9000};
    const db={
      query:{tracks:{findFirst:async()=>({...track})}},
      update:()=>({set:patch=>({where:async()=>{if("durationSec" in patch)Object.assign(track,patch);}})}),
      select:()=>({from:()=>({where:()=>({limit:async()=>[]})})})
    };
    mock.module("@mint/core/db",{namedExports:{...database,getDb:()=>db}});
    mock.module(new URL("./src/queues.ts",import.meta.url),{namedExports:{queues:{},connection:{}}});
    mock.module(new URL("./src/config.ts",import.meta.url),{namedExports:{config:{remoteMode:"always"}}});
    mock.module(new URL("./src/track-state.ts",import.meta.url),{namedExports:{
      updateTrack:async(_id,patch)=>Object.assign(track,patch),stage:async()=>{},progress:async()=>{}
    }});
    mock.module(new URL("./src/existing-track.ts",import.meta.url),{namedExports:{
      assignSourceVideo:async(_id,videoId)=>{track.youtubeVideoId=videoId;return null;},
      keepExisting:async()=>{},reusePendingTrack:async()=>null
    }});
    mock.module(new URL("./src/services/musicbrainz.ts",import.meta.url),{namedExports:{
      matchRecording:async()=>({recordingId:"ambiguous-best",releaseGroupId:"fixture-release",
        artistId:"fixture-artist",album:"Fixture Album",year:null,durationSec:null,officialDurationsSec:[267],
        ambiguous:true})
    }});
    let validated=false;
    mock.module(new URL("./src/services/youtube.ts",import.meta.url),{namedExports:{NeedsSourceError:class NeedsSourceError extends Error{},
      findRequestedVideo:async(_user,evidence,options)=>{
        assert.deepEqual(evidence.officialDurationsSec,[267]);
        assert.equal(audioSourceRejection(evidence,selected),null);
        options.onSelected(selected);return selected.id;
      },
      validateRequestedVideo:async(_user,evidence,id)=>{
        assert.equal(id,selected.id);
        assert.equal(evidence.durationSec,267);
        assert.equal(audioSourceRejection(evidence,selected,true),null);
        validated=true;
      }
    }});
    const {processAcquire}=await import("./src/jobs/acquire.ts");
    const job={data:{trackId:track.id,requestedBy:"fixture-member",forceCobalt:true},
      async updateData(data){this.data=data;},async moveToDelayed(){}};
    await assert.rejects(processAcquire(job),{name:"DelayedError"});
    assert.equal(track.durationSec,267,"save supporting catalog length rather than music-video or measured-source length");
    assert.equal(track.mbRecordingId,null,"duration support must not pin an arbitrary ambiguous recording ID");
    assert.equal(job.data.step,"cobalt");
    assert.deepEqual(await processAcquire(job),{source:"remote"});
    assert.equal(validated,true,"stored-pin validation sees the supported duration without job-only evidence");
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("a throttled re-check trusts only this job's fresh selection of the same video", () => {
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    import * as database from "@mint/core/db";
    import {YoutubeSearchDeferredError} from "@mint/core/matching";
    process.env.INDEX_EXISTING_LIBRARY="false";
    const track={id:"fixture",title:"First Light",artist:"Mint Fixture",durationSec:181,
      mbRecordingId:null,youtubeVideoId:null,existingFilePath:null,filePath:null,stage:"queued"};
    const db={
      query:{tracks:{findFirst:async()=>({...track})}},
      update:()=>({set:()=>({where:async()=>{}})}),
      select:()=>({from:()=>({where:()=>({limit:async()=>[]})})})
    };
    mock.module("@mint/core/db",{namedExports:{...database,getDb:()=>db}});
    mock.module(new URL("./src/queues.ts",import.meta.url),{namedExports:{queues:{},connection:{}}});
    mock.module(new URL("./src/config.ts",import.meta.url),{namedExports:{config:{remoteMode:"always"}}});
    mock.module(new URL("./src/track-state.ts",import.meta.url),{namedExports:{
      updateTrack:async(_id,patch)=>Object.assign(track,patch),stage:async()=>{},progress:async()=>{}
    }});
    mock.module(new URL("./src/existing-track.ts",import.meta.url),{namedExports:{
      assignSourceVideo:async(_id,videoId)=>{track.youtubeVideoId=videoId;return null;},
      keepExisting:async()=>{},reusePendingTrack:async()=>null
    }});
    mock.module(new URL("./src/services/musicbrainz.ts",import.meta.url),{namedExports:{matchRecording:async()=>null}});
    mock.module(new URL("./src/services/youtube.ts",import.meta.url),{namedExports:{NeedsSourceError:class NeedsSourceError extends Error{},
      findRequestedVideo:async()=>"audio000001",
      validateRequestedVideo:async()=>{throw new YoutubeSearchDeferredError("YouTube metadata is temporarily rate limited",60_000);}
    }});
    const {processAcquire}=await import("./src/jobs/acquire.ts");
    const job={data:{trackId:track.id,requestedBy:"member",forceCobalt:true},
      async updateData(data){this.data=data;},async moveToDelayed(){}};
    await assert.rejects(processAcquire(job),{name:"DelayedError"});
    assert.equal(job.data.verifiedVideo.id,"audio000001");
    assert.deepEqual(await processAcquire(job),{source:"remote"});
    for (const verifiedVideo of [undefined,{id:"other000001",at:Date.now()},{id:"audio000001",at:Date.now()-31*60_000}]) {
      const stale={data:{trackId:track.id,requestedBy:"member",step:"cobalt",verifiedVideo},
        async updateData(data){this.data=data;},async moveToDelayed(){}};
      await assert.rejects(processAcquire(stale),{name:"DelayedError"});
    }
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("catalog outages use sufficient independent evidence, while quota and insufficient evidence stay retryable", () => {
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    import * as database from "@mint/core/db";
    import {UnrecoverableError} from "bullmq";
    import {YoutubeSearchDeferredError} from "@mint/core/matching";
    process.env.INDEX_EXISTING_LIBRARY="false";
    const track={id:"fixture",title:"First Light",artist:"Mint Fixture",durationSec:null,
      youtubeVideoId:null,existingFilePath:null,filePath:null,stage:"queued"};
    const patches=[];
    let behavior="selected",assigned=false,syncOrigin=false;
    const db={
      query:{tracks:{findFirst:async()=>({...track})}},
      update:()=>({set:()=>({where:async()=>{}})}),
      select:()=>({from:()=>({where:()=>({limit:async()=>syncOrigin?[{id:"import-alias"}]:[]})})})
    };
    mock.module("@mint/core/db",{namedExports:{...database,getDb:()=>db}});
    mock.module(new URL("./src/queues.ts",import.meta.url),{namedExports:{queues:{},connection:{}}});
    mock.module(new URL("./src/track-state.ts",import.meta.url),{namedExports:{
      updateTrack:async(_id,patch)=>patches.push(patch),stage:async()=>{},progress:async()=>{}
    }});
    mock.module(new URL("./src/existing-track.ts",import.meta.url),{namedExports:{
      assignSourceVideo:async()=>{assigned=true;return null;},keepExisting:async()=>{},reusePendingTrack:async()=>null
    }});
    mock.module(new URL("./src/services/musicbrainz.ts",import.meta.url),{namedExports:{
      matchRecording:async()=>{throw new Error("catalog503");}
    }});
    mock.module(new URL("./src/services/youtube.ts",import.meta.url),{namedExports:{NeedsSourceError:class NeedsSourceError extends Error{},
      findRequestedVideo:async(_user,evidence,options)=>{
        assert.equal(evidence.durationSec,null);
        assert.equal(options.syncOrigin,syncOrigin);
        if(behavior==="insufficient")throw new UnrecoverableError("No eligible audio source");
        if(behavior==="quota")throw new YoutubeSearchDeferredError("quota waiting",300000);
        return "audio000001";
      },validateRequestedVideo:async()=>{}
    }});
    const {processAcquire}=await import("./src/jobs/acquire.ts");
    for(syncOrigin of [false,true])for(behavior of ["selected","insufficient","quota"]){
      assigned=false;
      const job={data:{trackId:track.id,requestedBy:"member",forceCobalt:true},
        async updateData(data){this.data=data;},async moveToDelayed(){}};
      if(behavior==="insufficient")await assert.rejects(processAcquire(job),error=>
        error.name!=="UnrecoverableError" && /temporarily unavailable/.test(error.message));
      else await assert.rejects(processAcquire(job),{name:"DelayedError"});
      assert.equal(assigned,behavior==="selected");
      if(behavior==="selected")assert.equal(job.data.step,"cobalt");
      if(behavior==="quota")assert.equal(patches.at(-1).stage,"queued");
    }
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("Pacific-day sync budgets and shared short exhaustion cooldowns defer without provider calls", async () => {
  const values = new Map<string, number>();
  let cooldown = 0;
  const store = {
    ttl: async () => cooldown,
    setex: async (_key: string, seconds: number) => { cooldown = seconds; },
    eval: async (_script: string, _count: number, _cooldown: string, key: string, sync: string | number, limit: string | number, reset: string | number) => {
      if (cooldown) return cooldown;
      if (Number(sync) === 0) return 0;
      if ((values.get(key) ?? 0) >= Number(limit)) return Number(reset);
      values.set(key, (values.get(key) ?? 0) + 1);
      return 0;
    },
  };
  const now = Date.parse("2026-03-08T09:00:00Z");
  await reserveYoutubeSearch(store, true, 1, now);
  await assert.rejects(reserveYoutubeSearch(store, true, 1, now), YoutubeSearchDeferredError);
  await reserveYoutubeSearch(store, false, 1, now);
  await pauseYoutubeSearch(store);
  await assert.rejects(reserveYoutubeSearch(store, false, 1, now), YoutubeSearchDeferredError);
  cooldown = 0;
  await reserveYoutubeSearch(store, true, 1, now + 86400_000);
  await assert.rejects(reserveYoutubeSearch(store, true, NaN, now), /DAILY_LIMIT/);
  const spring = youtubeSearchDay(Date.parse("2026-03-08T08:00:00Z"));
  const fall = youtubeSearchDay(Date.parse("2026-11-01T07:00:00Z"));
  assert.ok(Math.abs(spring.resetMs - 23 * 3600_000) < 1000);
  assert.ok(Math.abs(fall.resetMs - 25 * 3600_000) < 1000);
});

test("sync classifies clean pins and unsafe imports without searching or using video-edit duration", () => {
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    mock.module(new URL("./src/queues.ts",import.meta.url),{namedExports:{queues:{},connection:{}}});
    const {importedSource} = await import("./src/jobs/sync.ts");
    const audio = ${JSON.stringify(audio)}, video = ${JSON.stringify(video)}, lyric = ${JSON.stringify(lyric)};
    for (const candidate of [audio, {...audio,channelTitle:"Fictional Label"}, lyric,
      {...audio,title:"Mint Fixture "+String.fromCharCode(8211)+" First Light (Official Audio)"},
      {...audio,title:"Mint Fixture "+String.fromCharCode(8212)+" First Light (Official Audio)"}]) {
      assert.equal(importedSource(candidate).youtubeVideoId,candidate.id);
    }
    for (const candidate of [video,{...audio,title:"Mint Fixture - First Light"}, {...lyric,viewCount:null},
      {...audio,title:audio.title+" (Live)"}]) {
      assert.equal(importedSource(candidate).youtubeVideoId,null);
      assert.equal(importedSource(candidate).durationSec,null);
    }
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("acquisition re-reads trusted catalog duration before searching, while unknown duration stays unknown", () => {
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    import * as database from "@mint/core/db";
    process.env.INDEX_EXISTING_LIBRARY="false";
    let track, length, lookedUp;
    const db={
      query:{tracks:{findFirst:async()=>({...track})}},
      update:()=>({set:()=>({where:async()=>{}})}),
      select:()=>({from:()=>({where:()=>({limit:async()=>[]})})})
    };
    mock.module("@mint/core/db",{namedExports:{...database,getDb:()=>db}});
    mock.module(new URL("./src/queues.ts",import.meta.url),{namedExports:{queues:{},connection:{}}});
    mock.module(new URL("./src/track-state.ts",import.meta.url),{namedExports:{
      updateTrack:async(_id,patch)=>Object.assign(track,patch),stage:async()=>{},progress:async()=>{}
    }});
    mock.module(new URL("./src/services/musicbrainz.ts",import.meta.url),{namedExports:{
      matchRecording:async()=>({recordingId:"fixture-recording",releaseGroupId:"fixture-release",
        artistId:"fixture-artist",album:"Fixture Album",year:null,durationSec:length,officialDurationsSec:[267,229]})
    }});
    mock.module(new URL("./src/services/youtube.ts",import.meta.url),{namedExports:{NeedsSourceError:class NeedsSourceError extends Error{},
      findRequestedVideo:async(_user,evidence)=>{lookedUp=evidence;throw new Error("stop-before-media");},
      validateRequestedVideo:async()=>{throw new Error("must not download");}
    }});
    const {processAcquire}=await import("./src/jobs/acquire.ts");
    for (length of [181,null]) {
      track={id:"fixture",title:"First Light",artist:"Mint Fixture",durationSec:null,
        youtubeVideoId:null,existingFilePath:null,filePath:null,stage:"queued"};
      const job={data:{trackId:track.id,requestedBy:"fixture-member",forceCobalt:true},
        async updateData(data){this.data=data;}};
      await assert.rejects(processAcquire(job),
        /stop-before-media/);
      assert.equal(lookedUp.durationSec,length,"lookup must receive persisted catalog evidence, not stale import metadata");
      assert.deepEqual(lookedUp.officialDurationsSec,length===null?[267,229]:undefined);
      assert.deepEqual(job.data.officialDurationsSec,[267,229],"alternatives survive delayed job transitions");
    }
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("import aliases, concurrent placeholders, exact-source merging and re-sync references are atomic", {
  skip: !process.env.MUSIC_TEST_DATABASE_URL && "Set MUSIC_TEST_DATABASE_URL to scratch PostgreSQL",
}, () => {
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    import {randomUUID} from "node:crypto";
    import {readFile} from "node:fs/promises";
    import pg from "pg";
    import {drizzle} from "drizzle-orm/node-postgres";
    import {eq} from "drizzle-orm";
    import {schema} from "@mint/core/db";
    import {encrypt} from "@mint/core/crypto";
    const queued=[];
    mock.module(new URL("./src/queues.ts",import.meta.url),{namedExports:{queues:{
      acquire:{addBulk:async jobs=>queued.push(...jobs)},maintenance:{add:async()=>{}}
    },connection:{}}});
    const {upsertTracks,processSync} = await import("./src/jobs/sync.ts");
    const {processAcquire} = await import("./src/jobs/acquire.ts");
    const {assignSourceVideo} = await import("./src/existing-track.ts");
    const namespace="source_"+randomUUID().replaceAll("-","");
    const admin=new pg.Pool({connectionString:process.env.MUSIC_TEST_DATABASE_URL,max:1});
    await admin.query('create schema "'+namespace+'"');
    const pool=new pg.Pool({connectionString:process.env.MUSIC_TEST_DATABASE_URL,max:8,options:"-c search_path="+namespace+",public"});
    const db=drizzle(pool,{schema});
    globalThis.__mintDb={db,pool};
    globalThis.__mintRedis={del:async()=>1,publish:async()=>0,eval:async()=>0};
    process.env.ENCRYPTION_KEY=Buffer.alloc(32,1).toString("base64");
    process.env.INDEX_EXISTING_LIBRARY="false";
    const video=${JSON.stringify(video)},audio=${JSON.stringify(audio)};
    try {
      for (const migration of ["0000_init","0001_workers","0002_drop_previews","0003_track_artwork_url","0004_existing_library","0009_playback_scale","0012_charts", "0019_source_choices"]) {
        const source=await readFile(new URL("../../packages/core/migrations/"+migration+".sql",import.meta.url),"utf8");
        for(const statement of source.replaceAll('"public".','"'+namespace+'".').split("--> statement-breakpoint"))
          if(statement.trim()) await pool.query(statement);
      }
      const [user]=await db.insert(schema.users).values({email:"source@fixture.test",name:"Fixture Member",passwordHash:"fixture",status:"active"}).returning();
      const batches=[];
      const options={db,indexReady:async()=>{},upgrade:async()=>{},enqueue:async rows=>batches.push(...rows)};
      const maps=await Promise.all(Array.from({length:6},()=>upsertTracks([video],user.id,options)));
      const pendingId=maps[0].get(video.id);
      assert.equal(new Set(maps.map(map=>map.get(video.id))).size,1);
      assert.equal(batches.length,1);
      const [pending]=await db.select().from(schema.tracks).where(eq(schema.tracks.id,pendingId));
      assert.equal(pending.youtubeVideoId,null);assert.equal(pending.durationSec,null);
      assert.equal((await upsertTracks([video],user.id,options)).get(video.id),pendingId);
      assert.equal(batches.length,1,"re-sync never re-queues an imported alias");
      const [playlist]=await db.insert(schema.playlists).values({userId:user.id,youtubePlaylistId:"fixture-list",title:"Fixtures",syncEnabled:true}).returning();
      await db.insert(schema.userTracks).values({userId:user.id,trackId:pendingId});
      await db.insert(schema.playlistTracks).values({playlistId:playlist.id,trackId:pendingId,position:0});
      await db.insert(schema.trackEvents).values({trackId:pendingId,stage:"queued",message:"fixture"});
      await db.insert(schema.chartEntryLinks).values({userId:user.id,provider:"fixture",entryId:"song",identity:"fixture",trackId:pendingId});
      const [owner]=await db.insert(schema.tracks).values({title:"First Light",artist:"Mint Fixture",youtubeVideoId:audio.id,stage:"ready",filePath:"/fixture/untouched.flac"}).returning();
      await db.insert(schema.userTracks).values({userId:user.id,trackId:owner.id});
      await db.insert(schema.playlistTracks).values({playlistId:playlist.id,trackId:owner.id,position:1});
      let invalidated=0;
      assert.equal(await assignSourceVideo(pendingId,audio.id,{db,invalidate:async()=>{invalidated++;}}),owner.id);
      assert.equal(invalidated,1);
      assert.equal(await db.$count(schema.tracks),1);
      for(const table of [schema.userTracks,schema.playlistTracks,schema.trackVideos,schema.trackEvents,schema.chartEntryLinks]) {
        assert.ok((await db.select().from(table)).every(row=>row.trackId===owner.id));
      }
      assert.equal((await upsertTracks([video],user.id,options)).get(video.id),owner.id,"playlist maps preserve imported alias after merge");
      assert.equal(batches.length,1);
      const [a,b]=await db.insert(schema.tracks).values([
        {title:"First Light",artist:"Mint Fixture"},{title:"First Light",artist:"Mint Fixture"}
      ]).returning();
      const collisionId="race0000001";
      await Promise.all([assignSourceVideo(a.id,collisionId,{db,invalidate:async()=>{}}),assignSourceVideo(b.id,collisionId,{db,invalidate:async()=>{}})]);
      assert.equal(await db.$count(schema.tracks),2,"two placeholders selecting the same source collapse");
      const [aliasOnly]=await db.insert(schema.trackVideos).values({videoId:"alias000001",trackId:owner.id}).returning();
      const [c]=await db.insert(schema.tracks).values({title:"First Light",artist:"Mint Fixture"}).returning();
      assert.equal(await assignSourceVideo(c.id,aliasOnly.videoId,{db,invalidate:async()=>{}}),owner.id);
      await assert.rejects(assignSourceVideo(owner.id,"other000001",{db}),/acquired track/);
      await db.insert(schema.youtubeAccounts).values({userId:user.id,googleSub:"fixture",scope:"fixture",
        accessTokenEnc:encrypt("fixture"),refreshTokenEnc:encrypt("fixture"),expiresAt:new Date(Date.now()+3600000)});
      const [jobTrack]=await db.insert(schema.tracks).values({title:"First Light",artist:"Mint Fixture",durationSec:181}).returning();
      await db.insert(schema.trackVideos).values({videoId:"import00001",trackId:jobTrack.id});
      globalThis.fetch=async input=>{
        const url=new URL(input);
        assert.equal(url.origin,"https://www.googleapis.com","a collision must never download media");
        if(url.pathname.endsWith("/search")) return Response.json({items:[{id:{videoId:audio.id}}]});
        return Response.json({items:[{id:audio.id,snippet:{title:audio.title,channelTitle:audio.channelTitle},
          contentDetails:{duration:audio.durationIso}}]});
      };
      const linked=await processAcquire({data:{trackId:jobTrack.id,requestedBy:user.id,step:"cobalt"}});
      assert.equal(linked.linked,owner.id);
      assert.equal(await db.$count(schema.tracks,eq(schema.tracks.id,jobTrack.id)),0);
      let liked=true;
      globalThis.fetch=async input=>{
        const url=new URL(input);
        assert.equal(url.origin,"https://www.googleapis.com");
        assert.ok(!url.pathname.endsWith("/search"),"sync never searches");
        if(url.pathname.endsWith("/videos")) return Response.json({items:liked||url.searchParams.has("id")?[{
          id:video.id,snippet:{title:video.title,channelTitle:video.channelTitle,description:"",categoryId:"10"},
          contentDetails:{duration:video.durationIso}
        }]:[]});
        if(url.pathname.endsWith("/playlistItems")) return Response.json({items:[{contentDetails:{videoId:video.id}}]});
        return Response.json({items:[{id:"fixture-list",snippet:{title:"Fixtures",description:""},contentDetails:{itemCount:1}}]});
      };
      await processSync({data:{userId:user.id}});
      await processSync({data:{userId:user.id}});
      assert.equal(queued.length,0,"known imported aliases do not queue again");
      assert.equal((await db.select().from(schema.playlistTracks))[0].trackId,owner.id);
      liked=false;
      await processSync({data:{userId:user.id}});
      assert.equal(await db.$count(schema.userTracks),0,"un-like resolves merged aliases and removes the member link, not files");
      assert.equal((await db.select().from(schema.tracks).where(eq(schema.tracks.id,owner.id)))[0].filePath,"/fixture/untouched.flac");
    } finally {
      delete globalThis.__mintDb;delete globalThis.__mintRedis;
      await pool.end();await admin.query('drop schema "'+namespace+'" cascade');await admin.end();
    }
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe", timeout: 60_000 });
});

test("an unrecoverable first acquisition failure marks the track failed instead of retrying", () => {
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import * as database from "@mint/core/db";
    import { UnrecoverableError } from "bullmq";
    const patches = [];
    mock.module("@mint/core/db", { namedExports: {...database, getDb: () => ({query:{tracks:{findFirst:async()=>({existingFilePath:null})}}})} });
    mock.module(new URL("./src/queues.ts", import.meta.url), { namedExports: {queues:{},connection:{}} });
    mock.module(new URL("./src/track-state.ts", import.meta.url), { namedExports: {
      updateTrack: async (_id, patch) => patches.push(patch), stage: async()=>{}, progress:async()=>{}
    } });
    const { onAcquireFailed } = await import("./src/jobs/acquire.ts");
    const job = {data:{trackId:"fixture"},attemptsMade:1,opts:{attempts:3}};
    await onAcquireFailed(job, new UnrecoverableError("No eligible audio source"));
    assert.equal(patches.at(-1).stage,"failed");
    await onAcquireFailed(job, new Error("Temporary provider failure"));
    assert.match(patches.at(-1).detail,/Retrying/);
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
});

test("admin setup retains an honest Cobalt incident warning without probing a real source", async () => {
  const keys = ["COBALT_URL", "PLEX_URL", "LIDARR_URL"] as const;
  const saved = keys.map((key) => process.env[key]);
  try {
    process.env.COBALT_URL = "http://cobalt.fixture:9000";
    process.env.PLEX_URL = "";
    process.env.LIDARR_URL = "";
    const notes = await wireIntegrations();
    assert.ok(notes.some((note) => /API health is not proof of audio delivery/.test(note) && /VISIONOS on stock 11 alone is insufficient/.test(note)));
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
    });
  }
});

test("evidence scoring: independent uploads agree on an unknown length, but one upload or a split vote is not evidence", () => {
  const demo = { title: "Expectation (demo)", artist: "Tame Impala", durationSec: null };
  const fan = (id: string, channel: string, iso: string): YtVideo => ({ ...audio, id, title: "Tame Impala - Expectation (demo) (Official Audio)",
    channelTitle: channel, durationIso: iso, viewCount: 4000 });
  const first = fan("fanupload01", "Psych Archive", "PT6M2S"), second = fan("fanupload02", "Demo Vault", "PT6M3S");
  assert.equal(selectRequestedVideo(demo, [first]), null, "one third-party upload cannot vouch for its own length");
  assert.ok([first.id, second.id].includes(selectRequestedVideo(demo, [first, second])!), "two channels agreeing within 2.5s infer the length");
  assert.deepEqual(withInferredDurations(demo, [first, second].map(audioCandidate)).inferredDurationsSec, [363]);
  assert.equal(withInferredDurations(demo, [first, { ...second, channelTitle: "Psych Archive" }].map(audioCandidate)).inferredDurationsSec, undefined,
    "the same channel twice is one vote");
  const rival = [first, fan("fanupload03", "Other", "PT4M1S"), fan("fanupload04", "Another", "PT4M2S"), second];
  assert.equal(selectRequestedVideo(demo, rival), null, "an equally supported different length is ambiguous");
  assert.equal(selectRequestedVideo({ ...demo, catalogVideoIds: [first.id] }, [first]), first.id, "a catalog-linked upload is evidence");
  assert.equal(selectRequestedVideo({ ...demo, title: "Expectation" }, [first, second]), null, "consensus never relaxes the version veto");
});

test("member pins pass any veto-clean upload, review choices stay vetted, and downloads must match the recording length", () => {
  const fanOnly = { ...audio, channelTitle: "Somebody Else", title: "Mint Fixture - First Light", durationIso: "PT2M10S" };
  const noLength = { ...requested, durationSec: null };
  assert.notEqual(audioSourceRejection(noLength, audioCandidate(fanOnly)), null);
  assert.equal(audioSourceRejection(noLength, audioCandidate(fanOnly), "member"), null);
  assert.equal(audioSourceRejection(requested, audioCandidate(fanOnly), "member"), "duration", "a known length still applies");
  for (const vetoed of [video, { ...audio, title: `${audio.title} (Live)` }, { ...audio, title: "Wrong Artist - First Light (Official Audio)" }]) {
    assert.notEqual(audioSourceRejection(requested, audioCandidate(vetoed), "member"), null, vetoed.title);
  }
  const choices = reviewableAudioSources(noLength, [video, fanOnly, topic, lyric].map(audioCandidate));
  assert.deepEqual(choices.map((choice) => choice.id).sort(), [fanOnly.id, lyric.id, topic.id].sort());
  assert.ok(choices.length <= 3);
  assert.equal(audioSourceScore(requested, audioCandidate(video)), null);
  assert.ok(audioSourceScore(requested, audioCandidate(topic))! > audioSourceScore(requested, audioCandidate(lyric))!);
  assert.equal(downloadedLengthMatches(181, 185), true);
  assert.equal(downloadedLengthMatches(181, 200), false);
  assert.equal(downloadedLengthMatches(400, 423), true, "six percent on long recordings");
  assert.equal(downloadedLengthMatches(null, 999), true);
});

test("catalog evidence makes the search stop as soon as a confident source exists", () => {
  assert.equal(audioSearchSatisfied([audioCandidate(topic)], 0, requested), true);
  assert.equal(audioSearchSatisfied([audioCandidate({ ...lyric, viewCount: 50 })], 0, requested), false);
  const linked = { ...requested, durationSec: null, catalogVideoIds: [lyric.id] };
  assert.equal(audioSourceRejection(linked, audioCandidate({ ...lyric, viewCount: null })), null);
});