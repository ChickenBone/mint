import assert from "node:assert/strict";
import test from "node:test";
import { audioSourceRejection, eligibleAudioSources } from "./matching";
import { PublicCacheUnavailableError, PublicProviderBusyError, PublicReadCache, publicCacheKey } from "./public-cache";
import { publicCacheFixture } from "./public-cache-fixture";
import {
  parseYoutubeSearchPage,
  parseYoutubeWatchPage,
  readYoutubeScrapeSearch,
  readYoutubeScrapeVideo,
  readYoutubeScrapeVideoOrListing,
  searchYoutubeScraped,
  YoutubeScrapeAccessError,
  YoutubeScrapeRateLimitError,
  YoutubeScrapeUnavailableError,
  YoutubeWatchBlockedError,
  youtubeScrapeDeferred,
  youtubeScrapeRedirect,
  youtubeScrapingAuthorized,
  type ScrapedYoutubeVideo,
} from "./youtube-scrape";

const requested = { title: "First Light", artist: "Mint Fixture", durationSec: 181 };
const audio: ScrapedYoutubeVideo = { id: "audio000001", title: "Mint Fixture - First Light (Official Audio)",
  channel: "Mint Fixture", durationSec: 181, viewCount: 1234, rank: 0 };
const lyric: ScrapedYoutubeVideo = { ...audio, id: "lyric000001", title: "Mint Fixture - First Light (Lyrics)",
  channel: "Fictional Lyrics", viewCount: 456 };
const video: ScrapedYoutubeVideo = { ...audio, id: "video000001",
  title: "Mint Fixture - First Light (Official Music Video)" };

const savedAuthorization = process.env.YOUTUBE_SCRAPE_AUTHORIZED;
test.before(() => { process.env.YOUTUBE_SCRAPE_AUTHORIZED = "true"; });
test.after(() => {
  if (savedAuthorization === undefined) delete process.env.YOUTUBE_SCRAPE_AUTHORIZED;
  else process.env.YOUTUBE_SCRAPE_AUTHORIZED = savedAuthorization;
});

function document(name: string, value: unknown) {
  return `<html><script>var ${name} = ${JSON.stringify(value)};</script></html>`;
}

function renderer(item: ScrapedYoutubeVideo, views = "1,234 views") {
  return { videoRenderer: {
    videoId: item.id, title: { runs: [{ text: item.title }] }, ownerText: { simpleText: item.channel },
    lengthText: { simpleText: "3:01" }, viewCountText: { simpleText: views },
    descriptionSnippet: { simpleText: "private-fixture-description-do-not-cache" },
  } };
}

function searchPage(items: unknown[]) {
  return document("ytInitialData", { contents: { twoColumnSearchResultsRenderer: { primaryContents: {
    sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] },
  } } } });
}

function watchPage(item: ScrapedYoutubeVideo, status = "OK") {
  return document("ytInitialPlayerResponse", { playabilityStatus: { status }, videoDetails: {
    videoId: item.id, title: item.title, author: item.channel, lengthSeconds: String(item.durationSec),
    viewCount: String(item.viewCount), shortDescription: "private-fixture-description-do-not-cache",
  }, streamingData: { formats: [{ url: "https://media.invalid/do-not-cache" }] } });
}

test("operator authorization is explicit and invalid values are not silently enabled", () => {
  const saved = process.env.YOUTUBE_SCRAPE_AUTHORIZED;
  try {
    delete process.env.YOUTUBE_SCRAPE_AUTHORIZED;
    assert.equal(youtubeScrapingAuthorized(), false);
    for (const value of ["false", " FALSE ", ""]) {
      process.env.YOUTUBE_SCRAPE_AUTHORIZED = value;
      assert.equal(youtubeScrapingAuthorized(), false);
    }
    process.env.YOUTUBE_SCRAPE_AUTHORIZED = "true";
    assert.equal(youtubeScrapingAuthorized(), true);
    process.env.YOUTUBE_SCRAPE_AUTHORIZED = "yes";
    assert.throws(youtubeScrapingAuthorized, /must be true or false/);
  } finally {
    if (saved === undefined) delete process.env.YOUTUBE_SCRAPE_AUTHORIZED;
    else process.env.YOUTUBE_SCRAPE_AUTHORIZED = saved;
  }
});

test("public metadata reads require authorization even with an injected fetcher or cached result", async () => {
  const fixture = publicCacheFixture();
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(searchPage([renderer(audio)])); };
  const options = { cache: fixture.cache, fetcher };
  try {
    delete process.env.YOUTUBE_SCRAPE_AUTHORIZED;
    await assert.rejects(readYoutubeScrapeSearch("first", options), /YOUTUBE_SCRAPE_AUTHORIZED=true/);
    await assert.rejects(readYoutubeScrapeVideo(audio.id, options), /YOUTUBE_SCRAPE_AUTHORIZED=true/);
    assert.equal(calls, 0);
    process.env.YOUTUBE_SCRAPE_AUTHORIZED = "true";
    await readYoutubeScrapeSearch("first", options);
    process.env.YOUTUBE_SCRAPE_AUTHORIZED = "false";
    await assert.rejects(readYoutubeScrapeSearch("first", options), /YOUTUBE_SCRAPE_AUTHORIZED=true/);
    assert.equal(calls, 1, "disabling scraping blocks both upstream and cached reads");
  } finally {
    process.env.YOUTUBE_SCRAPE_AUTHORIZED = "true";
  }
});

test("search parsing is ordered, bounded, exact-count-only and ignores unrelated page data", () => {
  const items = [renderer(audio), renderer({ ...lyric, id: "lyric000002" }, "1.2M views"),
    renderer(lyric, "No views"), renderer(video)];
  const parsed = parseYoutubeSearchPage(searchPage(items));
  assert.deepEqual(parsed.map((item) => item.id), [audio.id, "lyric000002", lyric.id, video.id]);
  assert.deepEqual(parsed.map((item) => item.viewCount), [1234, null, 0, 1234]);
  assert.ok(parsed.every((item) => item.durationSec === 181));
  assert.equal(audioSourceRejection(requested, parsed[0]!), null);
  assert.equal(audioSourceRejection(requested, parsed[1]!), "metadata");
  assert.equal(audioSourceRejection(requested, parsed[3]!), "music-video");
  assert.equal(JSON.stringify(parsed).includes("private-fixture-description"), false);
  const many = Array.from({ length: 15 }, (_, index) => renderer({ ...audio, id: `item${String(index).padStart(7, "0")}` }));
  assert.equal(parseYoutubeSearchPage(searchPage(many)).length, 10);
  const duplicate = parseYoutubeSearchPage(searchPage([renderer(audio), renderer(audio), renderer(lyric)]));
  assert.deepEqual(duplicate.map((item) => item.id), [audio.id, lyric.id]);
});

test("missing, changed or excessively nested search layouts are retryable, not empty results", () => {
  assert.throws(() => parseYoutubeSearchPage("<html>missing</html>"), YoutubeScrapeUnavailableError);
  assert.throws(() => parseYoutubeSearchPage("<script>var ytInitialData = {bad};</script>"), YoutubeScrapeUnavailableError);
  assert.throws(() => parseYoutubeSearchPage(document("ytInitialData", {})), YoutubeScrapeUnavailableError);
  assert.throws(() => parseYoutubeSearchPage(searchPage([])), YoutubeScrapeUnavailableError);
  assert.throws(() => parseYoutubeSearchPage(searchPage([{ videoRenderer: { videoId: "bad" } }])), YoutubeScrapeUnavailableError);
  assert.deepEqual(parseYoutubeSearchPage(searchPage([{ messageRenderer: { text: { simpleText: "No results found" } } }])), []);
  const ageGate = { backgroundPromoRenderer: { title: { runs: [{ text: "Confirm your age" }] }, icon: { iconType: "EMPTY_SEARCH" } } };
  assert.deepEqual(parseYoutubeSearchPage(searchPage([ageGate])), [], "an age-gated query is empty, not a provider outage");
  assert.throws(() => parseYoutubeSearchPage(searchPage([{ backgroundPromoRenderer: { title: { simpleText: "Try again" } } }])),
    YoutubeScrapeUnavailableError);
  let deep: unknown = renderer(audio);
  for (let index = 0; index < 65; index++) deep = { child: deep };
  assert.throws(() => parseYoutubeSearchPage(searchPage([deep])), /parsing budget/);
  assert.throws(() => parseYoutubeSearchPage("<html>Our systems have detected unusual traffic</html>"), YoutubeScrapeAccessError);
  assert.throws(() => parseYoutubeSearchPage(`${searchPage([renderer(audio)])}<form action="/sorry">`), YoutubeScrapeAccessError);
  const embedded = renderer(audio);
  embedded.videoRenderer.descriptionSnippet.simpleText = '<form action="/sorry">Our systems have detected unusual traffic from your computer network';
  assert.equal(parseYoutubeSearchPage(searchPage([embedded]))[0]!.id, audio.id, "quoted page data is not an access challenge");
});

test("watch parsing validates the requested ID, availability and public metadata without retaining media", () => {
  assert.deepEqual(parseYoutubeWatchPage(watchPage(audio), audio.id), { ...audio, watchVerified: true });
  assert.throws(() => parseYoutubeWatchPage(watchPage(audio), lyric.id), /mismatched video metadata/);
  assert.throws(() => parseYoutubeWatchPage(watchPage(audio, "LOGIN_REQUIRED"), audio.id),
    (error: unknown) => error instanceof YoutubeScrapeAccessError && error.reason === "sign-in");
  assert.equal(parseYoutubeWatchPage(watchPage(audio, "UNPLAYABLE"), audio.id), null);
  assert.throws(() => parseYoutubeWatchPage(document("ytInitialPlayerResponse", {
    playabilityStatus: { status: "ERROR", reason: "Temporarily unavailable. Please try again later." },
  }), audio.id), YoutubeScrapeUnavailableError);
  assert.throws(() => parseYoutubeWatchPage(watchPage(audio), "bad"), /Invalid YouTube video ID/);
  const parsed = parseYoutubeWatchPage(watchPage(audio), audio.id);
  assert.ok(!JSON.stringify(parsed).includes("media.invalid"));
  assert.ok(!JSON.stringify(parsed).includes("private-fixture-description"));
});

test("cache stores only validated public fields, coalesces reads and never sends credentials", async () => {
  const fixture = publicCacheFixture();
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://www.youtube.com");
    assert.equal(url.pathname, "/results");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(new Headers(init?.headers).has("cookie"), false);
    return new Response(searchPage([renderer(audio)]));
  };
  const options = { cache: fixture.cache, fetcher };
  const [first, second] = await Promise.all([
    readYoutubeScrapeSearch("Mint Fixture First Light", options),
    readYoutubeScrapeSearch("Mint Fixture First Light", options),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  first[0]!.title = "Mutated";
  assert.equal((await readYoutubeScrapeSearch("Mint Fixture First Light", options))[0]!.title, audio.title);
  const stored = JSON.stringify([...fixture.entries]);
  assert.ok(!stored.includes("private-fixture-description") && !stored.includes("media.invalid"));
  assert.ok(!stored.includes("Mint Fixture First Light"), "query cache keys are hashed");
});

test("one public watch request returns only validated fields and inaccessible sources are not substituted", async () => {
  const fixture = publicCacheFixture();
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.pathname, "/watch");
    assert.equal(url.searchParams.get("v"), audio.id);
    assert.equal(init?.credentials, "omit");
    return new Response(watchPage(audio));
  };
  assert.deepEqual(await readYoutubeScrapeVideo(audio.id, { cache: fixture.cache, fetcher }), { ...audio, watchVerified: true });
  assert.deepEqual(await readYoutubeScrapeVideo(audio.id, { cache: fixture.instance(), fetcher }), { ...audio, watchVerified: true });
  assert.equal(calls, 1);
});

test("redirects follow one same-page YouTube hop, refuse challenges and back off briefly otherwise", async () => {
  const from = new URL("https://www.youtube.com/results?search_query=x");
  assert.equal(String(youtubeScrapeRedirect(from, "/results?search_query=y")), "https://www.youtube.com/results?search_query=y");
  for (const [location, reason] of [["https://www.google.com/sorry/index", "challenge"], ["https://consent.youtube.com/m", "redirect"],
    ["https://accounts.google.com/ServiceLogin", "sign-in"]] as const) {
    const result = youtubeScrapeRedirect(from, location);
    assert.ok(result instanceof YoutubeScrapeAccessError && result.reason === reason, location);
  }
  for (const location of ["https://m.youtube.com/results", "http://www.youtube.com/results", null, "https://www.youtube.com/channel/x"]) {
    const result = youtubeScrapeRedirect(from, location);
    assert.ok(result instanceof YoutubeScrapeRateLimitError && !(result instanceof YoutubeScrapeAccessError), String(location));
    assert.equal(result.retryAfter, 300);
  }
  let calls = 0;
  const fetcher: typeof fetch = async (input) => {
    calls++;
    return new URL(String(input)).searchParams.get("hop") ? new Response(searchPage([renderer(audio)]))
      : new Response(null, { status: 302, headers: { location: "/results?search_query=hop&hop=1" } });
  };
  assert.equal((await readYoutubeScrapeSearch("hop", { cache: publicCacheFixture().cache, fetcher }))[0]!.id, audio.id);
  assert.equal(calls, 2);
  const loop: typeof fetch = async () => new Response(null, { status: 302, headers: { location: "/results?again=1" } });
  await assert.rejects(readYoutubeScrapeSearch("loop", { cache: publicCacheFixture().cache, fetcher: loop }),
    (error: unknown) => error instanceof PublicProviderBusyError && !(error instanceof YoutubeScrapeAccessError));
});

test("access refusal blocks even fresh cached results across instances; 429 honors shared cooldown", async () => {
  let now = 100_000, calls = 0, mode: "ok" | "denied" = "ok";
  const fixture = publicCacheFixture(() => now);
  const fetcher: typeof fetch = async () => {
    calls++;
    return mode === "ok" ? new Response(searchPage([renderer(audio)])) : new Response("refused", { status: 403 });
  };
  await readYoutubeScrapeSearch("first", { cache: fixture.cache, fetcher });
  now += 3000;
  mode = "denied";
  await assert.rejects(readYoutubeScrapeSearch("other", { cache: fixture.instance(), fetcher }),
    (error: unknown) => error instanceof YoutubeScrapeAccessError && error.reason === "http-403");
  await assert.rejects(readYoutubeScrapeSearch("first", { cache: fixture.instance(), fetcher }), PublicProviderBusyError);
  assert.equal(calls, 2, "cached metadata cannot bypass a shared refusal");

  const throttled = publicCacheFixture();
  let throttleCalls = 0;
  const busy: typeof fetch = async () => { throttleCalls++; return new Response("busy", {
    status: 429, headers: { "retry-after": "120" },
  }); };
  await assert.rejects(readYoutubeScrapeSearch("first", { cache: throttled.cache, fetcher: busy }),
    (error: unknown) => error instanceof YoutubeScrapeRateLimitError && error.retryAfter === 120);
  await assert.rejects(readYoutubeScrapeSearch("second", { cache: throttled.instance(), fetcher: busy }), PublicProviderBusyError);
  assert.equal(throttleCalls, 1);
  assert.match(youtubeScrapeDeferred(new PublicProviderBusyError("fixture", 60))!.message, /temporarily paused/);
});

test("a concurrent refusal blocks completed cache loads and lease-waiter results", async () => {
  const cooldown = "mint:public:cooldown:YouTubeMetadata";
  const fixture = publicCacheFixture();
  const fetcher: typeof fetch = async () => {
    await fixture.store.set(cooldown, String(Date.now() + 60_000), 60);
    return new Response(searchPage([renderer(audio)]));
  };
  await assert.rejects(readYoutubeScrapeSearch("in-flight", { cache: fixture.cache, fetcher }), PublicProviderBusyError);
  assert.equal(fixture.entries.has(publicCacheKey("YouTubeMetadata", "search-v1", "in-flight")), false);

  const waiting = publicCacheFixture();
  const key = publicCacheKey("YouTubeMetadata", "search-v1", "waiting");
  await waiting.store.set(`${key}:lease`, "another-process", 60);
  let reads = 0, requests = 0;
  const cache = new PublicReadCache({ ...waiting.store, get: async (name) => {
    if (name === key && ++reads === 2) {
      await waiting.store.set(cooldown, String(Date.now() + 60_000), 60);
      const now = Date.now();
      return JSON.stringify({ value: [audio], fetchedAt: now, freshUntil: now + 60_000, keepUntil: now + 60_000 });
    }
    return waiting.store.get(name);
  } });
  const forbidden: typeof fetch = async () => { requests++; return new Response(); };
  await assert.rejects(readYoutubeScrapeSearch("waiting", { cache, fetcher: forbidden }), PublicProviderBusyError);
  assert.equal(requests, 0);
});

test("cache outage, oversized responses and invalid pages fail closed without success-shaped emptiness", async () => {
  const fixture = publicCacheFixture();
  let calls = 0;
  const unavailable = new PublicReadCache({ ...fixture.store, get: async () => { throw new Error("offline"); } });
  const fetcher: typeof fetch = async () => { calls++; return new Response(searchPage([])); };
  await assert.rejects(readYoutubeScrapeSearch("first", { cache: unavailable, fetcher }), PublicCacheUnavailableError);
  assert.equal(calls, 0);
  await assert.rejects(readYoutubeScrapeSearch("first", { cache: publicCacheFixture().cache, fetcher }), YoutubeScrapeUnavailableError);
  const large: typeof fetch = async () => new Response("x".repeat(6 * 1024 * 1024 + 1));
  await assert.rejects(readYoutubeScrapeSearch("large", { cache: publicCacheFixture().cache, fetcher: large }), /response budget/);
});

test("completed eligible rounds survive transient failure, never explicit or ambiguous refusal", async () => {
  const eligible = (videos: ScrapedYoutubeVideo[]) => eligibleAudioSources(requested, videos);
  for (const failure of [new YoutubeScrapeUnavailableError("offline"), new YoutubeScrapeRateLimitError("fixture", 60)]) {
    let calls = 0, degraded = 0, details = 0;
    const found = await searchYoutubeScraped("Mint Fixture First Light", {
      eligible,
      search: async () => { if (++calls === 1) return [lyric]; throw failure; },
      video: async () => { details++; return lyric; },
      onDegraded: () => { degraded++; },
    });
    assert.equal(found[0]!.id, lyric.id);
    assert.equal(found[0]!.watchVerified, true);
    assert.equal(calls, 2);
    assert.equal(details, 1, "the eligible completed round is verified before later requests can fail");
    assert.equal(degraded, 1);
    await assert.rejects(searchYoutubeScraped("Mint Fixture First Light", {
      eligible, search: async () => { throw failure; },
    }), failure);
  }
  for (const failure of [new YoutubeScrapeAccessError(), new PublicProviderBusyError("fixture", 60), new Error("programming fault")]) {
    let calls = 0;
    await assert.rejects(searchYoutubeScraped("Mint Fixture First Light", {
      eligible, search: async () => { if (++calls === 1) return [lyric]; throw failure; }, video: async () => lyric,
    }), failure);
  }
});

test("a request deadline retains verified candidates or reports a retryable timeout", async () => {
  const eligible = (videos: ScrapedYoutubeVideo[]) => eligibleAudioSources(requested, videos);
  const completed = new AbortController();
  let rounds = 0, degraded = 0;
  const found = await searchYoutubeScraped("Mint Fixture First Light", {
    eligible, signal: completed.signal,
    search: async () => {
      if (++rounds === 1) return [lyric];
      completed.abort();
      throw completed.signal.reason;
    },
    video: async () => lyric,
    onDegraded: () => { degraded++; },
  });
  assert.equal(found[0]!.id, lyric.id);
  assert.equal(found[0]!.watchVerified, true);
  assert.equal(degraded, 1);

  const expired = new AbortController();
  expired.abort();
  await assert.rejects(searchYoutubeScraped("Mint Fixture First Light", {
    eligible, signal: expired.signal, search: async () => { throw new Error("must not search"); },
  }), YoutubeScrapeUnavailableError);
  let calls = 0;
  await assert.rejects(readYoutubeScrapeSearch("expired", {
    cache: publicCacheFixture().cache, signal: expired.signal,
    fetcher: async () => { calls++; return new Response(); },
  }), expired.signal.reason);
  assert.equal(calls, 0);
});

test("missing lyric counts are confirmed from watch metadata and are never invented", async () => {
  const eligible = (videos: ScrapedYoutubeVideo[]) => eligibleAudioSources(requested, videos);
  let details = 0;
  const found = await searchYoutubeScraped("Mint Fixture First Light", {
    eligible,
    search: async () => [{ ...lyric, viewCount: null }],
    video: async () => { details++; return lyric; },
  });
  assert.equal(details, 1);
  assert.equal(found[0]!.viewCount, lyric.viewCount);
  assert.equal(eligible(found)[0]!.id, lyric.id);
  const unknown = await searchYoutubeScraped("Mint Fixture First Light", {
    eligible, search: async () => [{ ...lyric, viewCount: null }], video: async () => null,
  });
  assert.equal(unknown[0]!.viewCount, null);
  assert.deepEqual(eligible(unknown), []);
  const noDuration = await searchYoutubeScraped("Mint Fixture First Light", {
    eligible: (videos) => eligibleAudioSources({ ...requested, durationSec: null }, videos),
    search: async () => [{ ...lyric, viewCount: null }], video: async () => lyric,
  });
  assert.equal(noDuration[0]!.viewCount, lyric.viewCount, "later catalog duration evidence can use verified lyric popularity");
  assert.deepEqual(eligibleAudioSources({ ...requested, durationSec: null }, noDuration), []);
  details = 0;
  await searchYoutubeScraped("Mint Fixture First Light", {
    eligible, search: async () => [audio, { ...lyric, viewCount: null }], video: async (id) => {
      details++; assert.equal(id, audio.id); return audio;
    },
  });
  assert.equal(details, 1, "an eligible higher-tier source does not trigger lyric metadata requests");
});

test("a watch-page challenge pauses only watch pages; search listings and pinned listings stay usable", async () => {
  const fixture = publicCacheFixture();
  let watchCalls = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/watch") {
      watchCalls++;
      return new Response(null, { status: 302, headers: { location: "https://www.google.com/sorry/index" } });
    }
    return new Response(searchPage([renderer(audio)]));
  };
  await assert.rejects(readYoutubeScrapeVideo(audio.id, { cache: fixture.cache, fetcher }),
    (error: unknown) => error instanceof YoutubeWatchBlockedError && error.blocked instanceof YoutubeScrapeAccessError);
  assert.ok(await fixture.store.get("mint:public:cooldown:YouTubeWatch"));
  assert.equal(await fixture.store.get("mint:public:cooldown:YouTubeMetadata"), null);
  await assert.rejects(readYoutubeScrapeVideo(audio.id, { cache: fixture.instance(), fetcher }), YoutubeWatchBlockedError);
  assert.equal(watchCalls, 1, "the watch cooldown is shared");
  assert.equal((await readYoutubeScrapeSearch("still works", { cache: fixture.instance(), fetcher }))[0]!.id, audio.id);
  assert.deepEqual(await readYoutubeScrapeVideoOrListing(audio.id, { cache: fixture.instance(), fetcher }),
    { ...audio, rank: 0, watchVerified: false });
  await assert.rejects(readYoutubeScrapeVideoOrListing("missing0001", { cache: fixture.instance(), fetcher }), YoutubeWatchBlockedError);
  const titled: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/watch") return new Response(null, { status: 302, headers: { location: "https://www.google.com/sorry/index" } });
    return new Response(searchPage([renderer(url.searchParams.get("search_query") === "Mint Fixture First Light lyrics" ? audio : { ...audio, id: "other000001" })]));
  };
  assert.deepEqual(await readYoutubeScrapeVideoOrListing(audio.id, { cache: publicCacheFixture().cache, fetcher: titled,
    queries: ["Mint Fixture First Light official audio", "Mint Fixture First Light lyrics"] }), { ...audio, rank: 0, watchVerified: false },
  "a bare-ID search miss falls back to title listings for the same exact ID");
  await assert.rejects(readYoutubeScrapeVideoOrListing("missing0001", { cache: publicCacheFixture().cache, fetcher: titled,
    queries: ["Mint Fixture First Light lyrics"] }), YoutubeWatchBlockedError, "a different listed video is never substituted");

  let blocked = 0, details = 0;
  const found = await searchYoutubeScraped("Mint Fixture First Light", {
    eligible: (videos) => eligibleAudioSources(requested, videos),
    search: async () => [audio],
    video: async () => { details++; throw new YoutubeWatchBlockedError(new YoutubeScrapeAccessError()); },
    onWatchBlocked: () => { blocked++; },
  });
  assert.equal(found[0]!.id, audio.id);
  assert.equal(found[0]!.watchVerified, false);
  assert.equal(details, 1, "no further watch requests after a refusal");
  assert.equal(blocked, 1);
});

test("unavailable automatic choices are removed before a different audio source is selected", async () => {
  const second = { ...audio, id: "audio000002", viewCount: 100 };
  const checked: string[] = [];
  const found = await searchYoutubeScraped("Mint Fixture First Light", {
    eligible: (videos) => eligibleAudioSources(requested, videos),
    search: async () => [audio, second, video],
    video: async (id) => { checked.push(id); return id === audio.id ? null : second; },
  });
  assert.deepEqual(checked, [audio.id, second.id]);
  assert.equal(found.find((item) => item.id === audio.id), undefined);
  assert.equal(found.find((item) => item.id === second.id)?.watchVerified, true);
});
