import assert from "node:assert/strict";
import test from "node:test";
import { MintApi, trackAnalysisResponseSchema } from "../src/index";

const id = "12345678-1234-4234-8234-123456789012";
const token = `mn1.${id}.${"a".repeat(43)}`;
const result = {
  version: 1, algorithm: "mint-dsp-v1", measuredAt: "2026-11-07T00:00:00.000Z", durationSec: 180,
  integratedLufs: -14, truePeakDbtp: -1, leadingSilenceSec: 0, trailingSilenceSec: 1,
  energy: { rms: .3, peak: .9, dynamicRangeDb: 8 }, waveform: [0, .2, .8, .1],
  tempo: { bpm: 120, confidence: .8 }, key: { name: "C major", confidence: .7 },
};
test("consumer analysis validates actual v1/v2 measurements and strips private worker data", () => {
  const response = trackAnalysisResponseSchema.parse({
    status: "complete", version: 1, upgrading: false,
    result: { ...result, fingerprint: { sha256: "private" }, provenance: { notes: ["private"] }, similarity: { vector: [123] } },
    error: "private worker error",
  });
  assert.deepEqual(response.result, result);
  assert.doesNotMatch(JSON.stringify(response), /fingerprint|provenance|similarity|private/);
  assert.equal(trackAnalysisResponseSchema.safeParse({ ...response, result: { ...result, version: 2, algorithm: "mint-dsp-v2" } }).success, true);
  for (const bad of [[NaN], [2], new Array(257).fill(0)]) {
    assert.equal(trackAnalysisResponseSchema.safeParse({ ...response, result: { ...result, waveform: bad } }).success, false);
  }
  assert.equal(trackAnalysisResponseSchema.safeParse({ ...response, result: { ...result, version: 3 } }).success, false);
});
test("trackAnalysis is authenticated native GET with explicit cancellation and missing state", async () => {
  const controller = new AbortController();
  let called = false;
  const api = new MintApi({
    serverUrl: "https://mint.example", token,
    fetch: async (url, init) => {
      called = true;
      assert.equal(url, `https://mint.example/api/native/player/analysis/${id}`);
      assert.equal(init?.signal, controller.signal);
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
      assert.ok(!init?.method || init.method === "GET");
      return Response.json({ status: "missing", version: null, upgrading: false, result: null });
    },
  });
  assert.equal((await api.trackAnalysis(id, controller.signal)).result, null);
  assert.equal(called, true);
  await assert.rejects(async () => api.trackAnalysis("../admin"), /Invalid/);
});
