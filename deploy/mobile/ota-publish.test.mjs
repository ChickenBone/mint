import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { publishUpdate, updateOrigin } from "./ota-publish.mjs";

test("OTA URL is exact public HTTPS protocol endpoint, not credential-bearing redirect", () => {
  assert.equal(updateOrigin("https://mint.example.com/api/updates"), "https://mint.example.com");
  for (const url of ["http://mint.example.com/api/updates", "https://user:pass@mint.example.com/api/updates",
    "https://mint.example.com/api/updates?token=x", "https://mint.example.com/other"]) {
    assert.throws(() => updateOrigin(url), /MINT_OTA_URL/);
  }
});

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const manifest = { id: "fixture", runtimeVersion: "a".repeat(64), metadata: { channel: "production" } };
  const text = JSON.stringify(manifest);
  const signature = sign("RSA-SHA256", Buffer.from(text), privateKey).toString("base64");
  return {
    publication: { manifest, body: JSON.stringify({ manifest: text, signature }), certificate: { publicKey },
      uploads: [{ hex: "b".repeat(64), bytes: Buffer.from("asset"), contentType: "image/png" }] },
    text, signature,
  };
}

test("immutable assets publish before manifest, then signed runtime/channel read-back", async () => {
  const { publication, text, signature } = fixture();
  const calls = [];
  const result = await publishUpdate({ publication, updateUrl: "https://mint.example.com/api/updates", token: "x".repeat(64),
    request: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, text: async () => text, headers: new Headers({ "expo-signature": `sig="${signature}", keyid="main"` }) };
    },
  });
  assert.equal(result.id, "fixture");
  assert.deepEqual(calls.map(({ options }) => options.method ?? "GET"), ["PUT", "POST", "GET"]);
  assert.equal(calls[0].options.headers["Content-Type"], "image/png");
  assert.equal(calls[2].options.headers["expo-runtime-version"], publication.manifest.runtimeVersion);
  assert.equal(calls[2].options.headers["expo-channel-name"], "production");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[2].options.headers.Authorization, undefined);
});

test("asset failure prevents atomic manifest publication", async () => {
  const { publication } = fixture();
  let calls = 0;
  await assert.rejects(publishUpdate({ publication, updateUrl: "https://mint.example.com/api/updates", token: "x".repeat(64),
    request: async () => { calls++; return { ok: false, status: 507 }; },
  }), /existing update remains active/);
  assert.equal(calls, 1);
});

test("unsigned or tampered read-back is never reported as successful OTA", async () => {
  const { publication } = fixture();
  await assert.rejects(publishUpdate({ publication, updateUrl: "https://mint.example.com/api/updates", token: "x".repeat(64),
    request: async () => ({ ok: true, text: async () => '{"id":"tampered"}', headers: new Headers() }),
  }), /read-back signature/);
});
