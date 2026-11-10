import assert from "node:assert/strict";
import test from "node:test";
import { classifyRequestedVideo } from "./services/matching-classifier";
import { sameRequestedVersion, selectRequestedVideo, type YtVideo } from "./services/youtube";

test("requested-video matching requires artist, title, known duration and the requested version", () => {
  const track = { title: "First Light", artist: "Mint Fixture", durationSec: 90 };
  const video: YtVideo = { id: "abcdefghijk", title: "Mint Fixture - First Light (Official Audio)", channelTitle: "Mint Fixture - Topic",
    description: "", categoryId: "10", durationIso: "PT1M30S" };
  assert.equal(selectRequestedVideo(track, [video]), video.id);
  for (const change of [{ title: "Mint Fixture - Last Light" }, { channelTitle: "Someone Else", title: "First Light" },
    { channelTitle: "Another Singer", title: "Mint Fixture - First Light" },
    { title: `${video.title} live` }, { title: `${video.title} remix` }, { title: `${video.title} cover` },
    { title: `${video.title} remastered` }, { title: `${video.title} acoustic` },
    { durationIso: "PT1M34S" }, { durationIso: "PT3M" }, { durationIso: null }]) {
    assert.equal(selectRequestedVideo(track, [{ ...video, ...change }]), null, JSON.stringify(change));
  }
  assert.equal(selectRequestedVideo({ ...track, artist: "" }, [video]), null);
  assert.equal(selectRequestedVideo({ ...track, durationSec: null }, [video]), null);
  assert.equal(selectRequestedVideo(track, [video, { ...video, id: "other-video" }]), null, "Ambiguous sources must not silently choose the first video");
  assert.equal(selectRequestedVideo({ ...track, title: "First Light Live" }, [{ ...video, title: `${video.title} live` }]), video.id);
  assert.equal(selectRequestedVideo(track, [{ ...video, channelTitle: "MintFixtureVEVO" }]), video.id);
});

test("official VEVO audio outranks Topic and visualizers are rejected", () => {
  const drake = { title: "Janice STFU", artist: "Drake", durationSec: 237 };
  const vevo: YtVideo = { id: "drake-vevo", title: "Drake - Janice STFU", channelTitle: "DrakeVEVO", description: "", categoryId: "10", durationIso: "PT3M57S" };
  const topic: YtVideo = { id: "drake-topic", title: "Janice STFU", channelTitle: "Drake - Topic", description: "", categoryId: "10", durationIso: "PT3M58S" };
  assert.equal(selectRequestedVideo(drake, [topic, vevo]), vevo.id);

  const baby = { title: "Dead Fresh", artist: "Lil Baby", durationSec: 157 };
  const visualizer: YtVideo = { id: "baby-visualizer", title: "Lil Baby - Dead Fresh (Visualizer)", channelTitle: "LilBabyVEVO", description: "", categoryId: "10", durationIso: "PT2M38S" };
  const babyTopic: YtVideo = { id: "baby-topic", title: "Dead Fresh", channelTitle: "Lil Baby - Topic", description: "", categoryId: "10", durationIso: "PT2M38S" };
  assert.equal(selectRequestedVideo(baby, [visualizer, babyTopic]), babyTopic.id);
});

test("requested-video matching accepts compact official VEVO channels", () => {
  const ella = { title: "Choosin' Texas", artist: "Ella Langley", durationSec: 208 };
  const official: YtVideo = {
    id: "ella-langley",
    title: "Ella Langley - Choosin' Texas (Official Audio)",
    channelTitle: "EllaLangleyVEVO",
    description: "",
    categoryId: "10",
    durationIso: "PT3M28S",
  };
  assert.equal(selectRequestedVideo(ella, [official]), official.id);
});

test("a visualizer is a different version from the requested recording", () => {
  assert.equal(sameRequestedVersion("BbY WOW", "KAROL G, Judeline, rusowsky - BbY WOW (Visualizer)"), false);
  assert.equal(sameRequestedVersion("BbY WOW", "BbY WOW"), true);
});

test("a slash-separated credit matches the first artist's upload", () => {
  const track = { title: "BbY WOW", artist: "KAROL G / Judeline / rusowsky", durationSec: 225 };
  const topic: YtVideo = { id: "bby-topic", title: "BbY WOW", channelTitle: "KAROL G - Topic", description: "", categoryId: "10", durationIso: "PT3M45S" };
  assert.equal(selectRequestedVideo(track, [topic]), topic.id);
});

const requested = { title: "Take Me Back to Eden", artist: "Sleep Token", durationSec: 500 };
const candidates: YtVideo[] = [
  { id: "vFHBOKa_ZG0", title: "Sleep Token - Take Me Back To Eden", channelTitle: "SleepTokenVEVO",
    description: "", categoryId: "10", durationIso: "PT8M21S" },
  { id: "-fImbmUEalo", title: "Sleep Token - Take Me Back To Eden (Lyrics)", channelTitle: "Lyric Cloud Studios",
    description: "", categoryId: "10", durationIso: "PT8M21S" },
];

const apiKey = "sk-test-key-1234567890abcdef";

function classifierResponse(choice: string, confidence = 0.9, probabilities: Record<string, number> = {
  [choice]: 0.8, none: 0.1, other: 0.1,
}) {
  return new Response(JSON.stringify({
    model: "gpt-6-luna",
    answers: [{
      type: "choice",
      name: "recording",
      choice,
      confidence,
      probabilities: Object.entries(probabilities).map(([value, probability]) => ({ value, probability })),
    }],
  }), { headers: { "content-type": "application/json" } });
}

test("OpenAI decision matching is model-primary but bounded to offered candidates and confidence", async () => {
  const selected = await classifyRequestedVideo(requested, candidates, {
    enabled: true, apiKey, fetchImpl: async () => classifierResponse("vFHBOKa_ZG0"),
  });
  assert.deepEqual(selected, { status: "selected", id: "vFHBOKa_ZG0", confidence: 0.9 });

  const none = await classifyRequestedVideo(requested, candidates, {
    enabled: true, apiKey,
    fetchImpl: async () => classifierResponse("none", 0.9, { none: 0.8, vFHBOKa_ZG0: 0.1, "-fImbmUEalo": 0.1 }),
  });
  assert.deepEqual(none, { status: "none", confidence: 0.9 });

  const uncertain = await classifyRequestedVideo(requested, candidates, {
    enabled: true, apiKey,
    fetchImpl: async () => classifierResponse("vFHBOKa_ZG0", 0.4, { vFHBOKa_ZG0: 0.45, none: 0.4 }),
  });
  assert.deepEqual(uncertain, { status: "fallback", reason: "uncertain" });

  const lowMargin = await classifyRequestedVideo(requested, candidates, {
    enabled: true, apiKey,
    fetchImpl: async () => classifierResponse("vFHBOKa_ZG0", 0.9, { vFHBOKa_ZG0: 0.51, none: 0.49 }),
  });
  assert.deepEqual(lowMargin, { status: "fallback", reason: "uncertain" });

  const invented = await classifyRequestedVideo(requested, candidates, {
    enabled: true, apiKey, fetchImpl: async () => classifierResponse("invented-video"),
  });
  assert.deepEqual(invented, { status: "fallback", reason: "invalid" });

  const malformed = await classifyRequestedVideo(requested, candidates, {
    enabled: true, apiKey, fetchImpl: async () => new Response(JSON.stringify({ answers: [] })),
  });
  assert.deepEqual(malformed, { status: "fallback", reason: "invalid" });
});

test("OpenAI decision sends only bounded public candidate metadata", async () => {
  const many = Array.from({ length: 11 }, (_, index): YtVideo => ({
    id: `candidate${String(index).padStart(2, "0")}`,
    title: `Candidate ${index}`,
    channelTitle: `Channel ${index}`,
    description: `private-looking description ${index}`,
    categoryId: "10",
    durationIso: "PT8M20S",
  }));
  let sentUrl = "", sent: Record<string, unknown> | undefined, authorization = "";
  await classifyRequestedVideo(requested, many, {
    enabled: true,
    apiKey,
    fetchImpl: async (input, init) => {
      sentUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      sent = JSON.parse(String(init?.body));
      return classifierResponse(many[0]!.id);
    },
  });
  const choices = (sent?.questions as Array<{ choices: Array<{ value: string }> }>)[0]!.choices;
  assert.equal(sentUrl, "https://api.openai.com/v1/decisions");
  assert.equal(authorization, `Bearer ${apiKey}`);
  assert.equal(choices.length, 11, "ten candidates plus none");
  assert.equal(choices.some((choice) => choice.value === many[10]!.id), false);
  assert.ok(!JSON.stringify(sent).includes("private-looking description"));
  assert.ok(!JSON.stringify(sent).includes(apiKey));
});

test("OpenAI decision matching fails open when disabled, unconfigured, unavailable or timed out", async () => {
  let calls = 0;
  const disabled = await classifyRequestedVideo(requested, candidates, {
    enabled: false, apiKey, fetchImpl: async () => { calls++; return classifierResponse("none"); },
  });
  assert.deepEqual(disabled, { status: "fallback", reason: "disabled" });
  assert.equal(calls, 0);

  assert.deepEqual(
    await classifyRequestedVideo(requested, candidates, { enabled: true }),
    { status: "fallback", reason: "unconfigured" },
  );
  assert.deepEqual(
    await classifyRequestedVideo(requested, [], { enabled: true, apiKey }),
    { status: "fallback", reason: "invalid" },
  );

  const unavailable = await classifyRequestedVideo(requested, candidates, {
    enabled: true, apiKey, fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(unavailable, { status: "fallback", reason: "unavailable" });

  const timedOut = await classifyRequestedVideo(requested, candidates, {
    enabled: true, apiKey, timeoutMs: 5,
    fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("Request did not abort")), 100);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(new DOMException("Timed out", "AbortError"));
      }, { once: true });
    }),
  });
  assert.deepEqual(timedOut, { status: "fallback", reason: "unavailable" });
});
