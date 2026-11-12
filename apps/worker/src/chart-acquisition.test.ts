import assert from "node:assert/strict";
import test from "node:test";
import { matchRecording as cachedMatchRecording, musicBrainzJson as cachedMusicBrainzJson } from "./services/musicbrainz";
const matchRecording: typeof cachedMatchRecording = (query) => cachedMatchRecording(query, null);
const musicBrainzJson: typeof cachedMusicBrainzJson = (url, query, options) => cachedMusicBrainzJson(url, query, { ...options, cache: null });
import { importedFile } from "./services/lidarr";

test("an explicit MusicBrainz recording is looked up by identity and cannot be replaced by a fuzzy result", async (t) => {
  const id = "b00b6c22-98cd-4ce0-84bb-d8dd07146b45";
  let title = "Distant Window", duration = 180000;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    assert.equal(url.pathname, `/ws/2/recording/${id}`);
    assert.equal(url.searchParams.get("inc"), "artists+releases+release-groups+media");
    return Response.json({ id, title, length: duration, "artist-credit": [{ name: "The Paper Moons", artist: { id: "artist", name: "The Paper Moons" } }],
      releases: [{ id: "release", title: "Night Letters", status: "Official", "release-group": { id: "group", "primary-type": "Album" } }] });
  });
  const query = { mbRecordingId: id, title, artist: "The Paper Moons", album: "Night Letters", durationSec: 180 };
  const matched = await matchRecording(query);
  assert.equal(matched?.recordingId, id);
  assert.equal(matched?.durationSec, 180);
  title = "Distant Window (Live)";
  assert.equal(await matchRecording(query), null);
  title = query.title; duration = 184000;
  assert.equal(await matchRecording(query), null);
});
test("only one identified recording can supply a missing expected duration", async (t) => {
  const recording = { id: "fixture-recording", title: "First Light", score: 100, length: 181200,
    "artist-credit": [{ name: "Mint Fixture", artist: { id: "fixture-artist", name: "Mint Fixture" } }],
    releases: [{ id: "fixture-release", title: "Fixtures", "release-group": { id: "fixture-group", "primary-type": "Album" } }] };
  let duplicate = false;
  t.mock.method(globalThis, "fetch", async () => Response.json({
    recordings: duplicate ? [recording, { ...recording, id: "different-edition" }] : [recording],
  }));
  const wanted = { title: "First Light", artist: "Mint Fixture", durationSec: null };
  assert.equal((await matchRecording(wanted))?.durationSec, 181);
  assert.equal((await matchRecording(wanted))?.ambiguous, false);
  duplicate = true;
  assert.equal((await matchRecording(wanted))?.durationSec, null);
  assert.equal((await matchRecording(wanted))?.ambiguous, true, "equal lengths do not prove a unique recording ID");
});
test("official non-video durations include exact compilation recordings, not bootlegs, alternate versions or different identities", async (t) => {
  const base = { id: "fixture-single", title: "First Light", score: 100, length: 267000,
    "artist-credit": [{ name: "Mint Fixture", artist: { id: "fixture-artist", name: "Mint Fixture" } }],
    releases: [{ id: "fixture-release", title: "Fixtures", status: "Official",
      "release-group": { id: "fixture-group", "primary-type": "Album", "secondary-types": [] as string[] } }] };
  t.mock.method(globalThis, "fetch", async () => Response.json({ recordings: [
    base, { ...base, id: "fixture-album", length: 229040 }, { ...base, id: "same-length" },
    { ...base, id: "bootleg", length: 271000, releases: [{ ...base.releases[0], status: "Bootleg" }] },
    { ...base, id: "compilation", length: 274000, releases: [{ ...base.releases[0],
      "release-group": { ...base.releases[0]!["release-group"], "secondary-types": ["Compilation"] } }] },
    { ...base, id: "no-release", length: 268500, releases: [] },
    { ...base, id: "other-song", title: "Other Song", length: 300000 },
    { ...base, id: "live-version", title: "First Light (Live)", length: 301000 },
    { ...base, id: "other-artist", length: 302000, "artist-credit": [{ name: "Other Artist" }] },
    { ...base, id: "missing-length", length: null },
    { ...base, id: "official-video", video: true, length: 244000 },
    { ...base, id: "remix-release", length: 305000, releases: [{ ...base.releases[0],
      "release-group": { ...base.releases[0]!["release-group"], "secondary-types": ["Remix"] } }] },
    { ...base, id: "hidden-live", disambiguation: "live at the fixture hall", length: 306000 },
    { ...base, id: "hidden-cover", disambiguation: "cover", length: 307000 },
    { ...base, id: "hidden-remaster", disambiguation: "remastered", length: 308000 },
  ] }));
  const match = await matchRecording({ title: "First Light", artist: "Mint Fixture", durationSec: null });
  assert.equal(match?.durationSec, null, "multiple recording IDs still cannot supply a unique duration");
  assert.deepEqual(match?.officialDurationsSec, [267, 229, 274]);
});
test("catalog credits preserve whole band names and accept known credit aliases and featured artists", async (t) => {
  let title = "First Light", artist = "Mint Fixture", second: string | null = "Amber Example", video = false;
  t.mock.method(globalThis, "fetch", async () => Response.json({ recordings: [{
    id: "fixture", title: "First Light", score: 100, video, length: 181000,
    "artist-credit": [
      { name: artist, artist: { id: "artist", name: artist, aliases: [{ name: "Mint" }] } },
      ...(second ? [{ name: second, artist: { id: "guest", name: second } }] : []),
    ],
    releases: [{ id: "release", title: "Fixture", status: "Official", "release-group": { id: "group", "primary-type": "Album" } }],
  }] }));
  for (const credit of ["Mint Fixture and Amber Example", "Mint Fixture / Amber Example", "Mint Fixture featuring Amber Example"]) {
    assert.deepEqual((await matchRecording({ title, artist: credit }))?.officialDurationsSec, [181]);
  }
  title = "First Light feat. Amber Example";
  assert.deepEqual((await matchRecording({ title, artist: "Mint Fixture" }))?.officialDurationsSec, [181]);
  title = "First Light";
  assert.equal(await matchRecording({ title, artist: "Mint Fixture and Wrong Guest" }), null);
  second = null; artist = "Florence and the Machine";
  assert.deepEqual((await matchRecording({ title, artist }))?.officialDurationsSec, [181]);
  artist = "Earth, Wind & Fire";
  assert.deepEqual((await matchRecording({ title, artist }))?.officialDurationsSec, [181]);
  artist = "Mint Fixture";
  assert.deepEqual((await matchRecording({ title, artist: "Mint" }))?.officialDurationsSec, [181]);
  video = true;
  assert.equal(await matchRecording({ title, artist }), null, "an Official release never makes video:true clean-audio evidence");
});
test("Lidarr cannot fall back to another same-name recording when a recording identity was selected", async (t) => {
  const oldUrl = process.env.LIDARR_URL, oldKey = process.env.LIDARR_API_KEY;
  process.env.LIDARR_URL = "http://lidarr.fixture"; process.env.LIDARR_API_KEY = "fixture-only";
  let exact = false, duplicate = false, fileCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/track")) {
      const row = { title: "Distant Window", foreignRecordingId: exact ? "wanted" : "another", hasFile: true, trackFileId: 1 };
      return Response.json(duplicate ? [row, row] : [row]);
    }
    fileCalls++; return Response.json({ path: "/mint-fixture/download.flac", size: 128 });
  });
  try {
    assert.equal(await importedFile(1, { recordingId: "wanted", title: "Distant Window" }), null); assert.equal(fileCalls, 0);
    exact = true; assert.equal((await importedFile(1, { recordingId: "wanted", title: "Distant Window" }))?.size, 128);
    duplicate = true; await assert.rejects(importedFile(1, { recordingId: "wanted", title: "Distant Window" }), /multiple editions/);
  } finally {
    if (oldUrl === undefined) delete process.env.LIDARR_URL; else process.env.LIDARR_URL = oldUrl;
    if (oldKey === undefined) delete process.env.LIDARR_API_KEY; else process.env.LIDARR_API_KEY = oldKey;
  }
});

test("optional MusicBrainz mirror keeps public fallback and conservative matching", async (t) => {
  const original = process.env.MUSICBRAINZ_MIRROR_URL;
  const APIForTest = "https://musicbrainz.org/ws/2";
  const publicUrl = "https://musicbrainz.org/ws/2/recording";
  try {
    await t.test("disabled mirror retains the public request", async (t) => {
      delete process.env.MUSICBRAINZ_MIRROR_URL;
      t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
        assert.equal(new URL(input).hostname, "musicbrainz.org");
        assert.ok((init?.headers as Record<string, string>)["user-agent"]);
        return Response.json({ recordings: [] });
      });
      assert.deepEqual(await musicBrainzJson(publicUrl), { recordings: [] });
    });

    await t.test("mirror receives the same query and respects a shorter caller timeout", async (t) => {
      process.env.MUSICBRAINZ_MIRROR_URL = "http://musicbrainz.fixture:5000/catalog/ws/2/";
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      t.mock.method(AbortSignal, "timeout", (ms: number) => {
        assert.equal(ms, 750);
        return timeout(ms);
      });
      t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        assert.equal(url.origin, "http://musicbrainz.fixture:5000");
        assert.equal(url.pathname, "/catalog/ws/2/recording");
        assert.equal(url.searchParams.get("query"), 'recording:"Distant Window"');
        assert.equal(url.searchParams.get("fmt"), "json");
        assert.equal(url.searchParams.get("limit"), "15");
        assert.equal(init?.redirect, "error");
        assert.ok((init?.headers as Record<string, string>)["user-agent"]);
        return Response.json({ recordings: [] });
      });
      // A valid empty result is not an outage or permission to mix catalog editions.
      assert.deepEqual(await musicBrainzJson(publicUrl,
        { query: 'recording:"Distant Window"', fmt: "json", limit: 15 }, { timeoutMs: 750 }),
      { recordings: [] });
    });

    for (const failure of ["timeout", "404", "429", "503", "invalid-json", "invalid-shape"]) {
      await t.test(`${failure} falls back once without retrying the mirror`, async (t) => {
        process.env.MUSICBRAINZ_MIRROR_URL = "http://musicbrainz.fixture:5000/ws/2";
        const hosts: string[] = [];
        t.mock.method(globalThis, "fetch", async (input: string) => {
          const url = new URL(input);
          hosts.push(url.hostname);
          assert.equal(url.searchParams.get("fmt"), "json");
          if (url.hostname === "musicbrainz.org") return Response.json({ recordings: [{ id: "public" }] });
          if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError");
          if (failure === "invalid-json") return new Response("<html>not ready</html>");
          if (failure === "invalid-shape") return Response.json(null);
          return new Response("not ready", { status: Number(failure) });
        });
        assert.deepEqual(await musicBrainzJson(publicUrl, { fmt: "json" }, { retries: 0 }),
          { recordings: [{ id: "public" }] });
        assert.deepEqual(hosts, ["musicbrainz.fixture", "musicbrainz.org"]);
      });
    }

    await t.test("mirror ceiling preserves the total timeout and public failures are not retried in a tight loop", async (t) => {
      process.env.MUSICBRAINZ_MIRROR_URL = "http://musicbrainz.fixture:5000/ws/2";
      const timeouts: number[] = [], hosts: string[] = [];
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      t.mock.method(AbortSignal, "timeout", (ms: number) => {
        timeouts.push(ms);
        return timeout(ms);
      });
      t.mock.method(globalThis, "fetch", async (input: string) => {
        hosts.push(new URL(input).hostname);
        return new Response("unavailable", { status: 503, headers: { "retry-after": "120" } });
      });
      await assert.rejects(musicBrainzJson(publicUrl, undefined, { timeoutMs: 7000, retries: 1 }), /503/);
      assert.deepEqual(hosts, ["musicbrainz.fixture", "musicbrainz.org"]);
      assert.deepEqual(timeouts, [7000, 3000]);
    });

    await t.test("public errors remain visible after mirror failure", async (t) => {
      process.env.MUSICBRAINZ_MIRROR_URL = "http://musicbrainz.fixture:5000/ws/2";
      t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
      await assert.rejects(musicBrainzJson(publicUrl, undefined, { retries: 0 }), /503/);
    });

    await t.test("invalid configuration falls back without fetching an unsafe URL", async (t) => {
      process.env.MUSICBRAINZ_MIRROR_URL = "file:///ws/2";
      t.mock.method(globalThis, "fetch", async (input: string) => {
        assert.equal(new URL(input).hostname, "musicbrainz.org");
        return Response.json({ recordings: [] });
      });
      assert.deepEqual(await musicBrainzJson(publicUrl), { recordings: [] });
    });

    await t.test("public API configured as a mirror does not cause duplicate public attempts", async (t) => {
      process.env.MUSICBRAINZ_MIRROR_URL = "https://musicbrainz.org/ws/2";
      let calls = 0;
      t.mock.method(globalThis, "fetch", async () => {
        calls++;
        return new Response("unavailable", { status: 503 });
      });
      await assert.rejects(musicBrainzJson(publicUrl, undefined, { retries: 0 }), /503/);
      assert.equal(calls, 1);
    });

    await t.test("pinned mirror recording cannot silently select another edition", async (t) => {
      process.env.MUSICBRAINZ_MIRROR_URL = "http://musicbrainz.fixture:5000/ws/2";
      t.mock.method(globalThis, "fetch", async (input: string) => {
        const url = new URL(input);
        assert.equal(url.hostname, "musicbrainz.fixture");
        assert.equal(url.pathname, "/ws/2/recording/wanted");
        return Response.json({
          id: "another", title: "Distant Window", length: 180000,
          "artist-credit": [{ name: "The Paper Moons", artist: { id: "artist", name: "The Paper Moons" } }],
          releases: [{ id: "release", title: "Night Letters", "release-group": { id: "group" } }],
        });
      });
      assert.equal(await matchRecording({
        mbRecordingId: "wanted", title: "Distant Window", artist: "The Paper Moons", durationSec: 180,
      }), null);
    });

    for (const [endpoint, field] of [["recording", "recordings"], ["artist", "artists"], ["release-group", "release-groups"]]) {
      await t.test(`${endpoint} search validates its response envelope, including legitimate emptiness`, async (t) => {
        process.env.MUSICBRAINZ_MIRROR_URL = "http://musicbrainz.fixture:5000/ws/2";
        let mirrorBody: unknown = {};
        const hosts: string[] = [];
        t.mock.method(globalThis, "fetch", async (input: string) => {
          const host = new URL(input).hostname;
          hosts.push(host);
          return Response.json(host === "musicbrainz.org" ? { [field!]: [] } : mirrorBody);
        });
        for (const malformed of [{}, { [field!]: {} }, { [field!]: [null] },
          { [field!]: [{ id: "id", title: 4, name: 4 }] }]) {
          mirrorBody = malformed;
          hosts.length = 0;
          assert.deepEqual(await musicBrainzJson(`${APIForTest}/${endpoint}`, { fmt: "json" }, { retries: 0 }), { [field!]: [] });
          assert.deepEqual(hosts, ["musicbrainz.fixture", "musicbrainz.org"]);
        }
        mirrorBody = { [field!]: [] };
        hosts.length = 0;
        assert.deepEqual(await musicBrainzJson(`${APIForTest}/${endpoint}`, { fmt: "json" }), { [field!]: [] });
        assert.deepEqual(hosts, ["musicbrainz.fixture"]);
        mirrorBody = { [field!]: [{ id: "fixture", score: 100, [endpoint === "artist" ? "name" : "title"]: "Fixture" }] };
        hosts.length = 0;
        assert.deepEqual(await musicBrainzJson(`${APIForTest}/${endpoint}`, { fmt: "json" }), mirrorBody);
        assert.deepEqual(hosts, ["musicbrainz.fixture"]);
      });
      await t.test(`${endpoint} lookup rejects missing identity/name but accepts a valid entity`, async (t) => {
        process.env.MUSICBRAINZ_MIRROR_URL = "http://musicbrainz.fixture:5000/ws/2";
        const valid = { id: "wanted", [endpoint === "artist" ? "name" : "title"]: "Fixture" };
        let body: unknown = {};
        const hosts: string[] = [];
        t.mock.method(globalThis, "fetch", async (input: string) => {
          const host = new URL(input).hostname;
          hosts.push(host);
          return Response.json(host === "musicbrainz.org" ? valid : body);
        });
        assert.deepEqual(await musicBrainzJson(`${APIForTest}/${endpoint}/wanted`, undefined, { retries: 0 }), valid);
        assert.deepEqual(hosts, ["musicbrainz.fixture", "musicbrainz.org"]);
        body = valid;
        hosts.length = 0;
        assert.deepEqual(await musicBrainzJson(`${APIForTest}/${endpoint}/wanted`), valid);
        assert.deepEqual(hosts, ["musicbrainz.fixture"]);
      });
    }
  } finally {
    if (original === undefined) delete process.env.MUSICBRAINZ_MIRROR_URL;
    else process.env.MUSICBRAINZ_MIRROR_URL = original;
  }
});
