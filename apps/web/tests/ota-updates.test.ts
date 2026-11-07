import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, sign, verify, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createOtaHandler, otaRequest } from "../src/lib/ota-updates";

const origin = "https://mint.example.com";
const token = "fixture-publisher-token-never-use-in-production-0123456789";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest();
async function fixture(t: TestContext, maxStorageBytes?: number) {
  const directory = await mkdtemp(join(tmpdir(), "mint-ota-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
    "-days", "1", "-subj", "/CN=Mint disposable OTA fixture",
    "-addext", "keyUsage=digitalSignature", "-addext", "extendedKeyUsage=codeSigning"], { stdio: "ignore" });
  const key = await readFile(join(directory, "key.pem"));
  const cert = await readFile(join(directory, "cert.pem"), "utf8");
  const storageDir = join(directory, "storage");
  const handler = createOtaHandler({
    storageDir, publicUrl: origin, tokenHash: sha(token).toString("hex"),
    certificates: { main: cert }, maxStorageBytes,
  });
  const asset = (bytes: string, contentType = "application/javascript", key: string = randomUUID()) => ({
    bytes, descriptor: {
      hash: sha(bytes).toString("base64url"), key, contentType,
      url: `${origin}/api/updates/assets/${sha(bytes).toString("hex")}`,
      fileExtension: contentType === "image/png" ? ".png" : ".js",
    },
  });
  const launch = asset("console.log('fixture update');");
  const image = asset("fixture-png-bytes", "image/png", "image-key");
  const manifest = (changes: Record<string, unknown> = {}) => ({
    id: randomUUID(), createdAt: new Date().toISOString(), runtimeVersion: "runtime-one",
    launchAsset: launch.descriptor, assets: [image.descriptor],
    metadata: { channel: "production", platform: "android" }, extra: {},
    ...changes,
  });
  const envelope = (value = manifest()) => {
    const raw = JSON.stringify(value, null, 2);
    return {
      channel: "production", platform: "android", keyid: "main", manifest: raw,
      signature: sign("RSA-SHA256", Buffer.from(raw), key).toString("base64"),
    };
  };
  const upload = (value = launch, overrides: HeadersInit = {}) => handler(new Request(`${origin}/api/updates/publish/assets/${sha(value.bytes).toString("hex")}`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": value.descriptor.contentType, ...overrides },
    body: value.bytes,
  }), "upload", sha(value.bytes).toString("hex"));
  const publish = (value = envelope(), overrides: HeadersInit = {}) => handler(new Request(`${origin}/api/updates/publish`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...overrides },
    body: JSON.stringify(value),
  }), "publish");
  const update = (overrides: HeadersInit = {}, method = "GET") => handler(new Request(`${origin}/api/updates`, {
    method, headers: {
      "expo-protocol-version": "1", "expo-platform": "android",
      "expo-runtime-version": "runtime-one", "expo-channel-name": "production",
      "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
      accept: "application/expo+json, application/json, multipart/mixed", ...overrides,
    },
  }), "update");
  return { directory, storageDir, handler, cert, asset, launch, image, manifest, envelope, upload, publish, update };
}

test("signed publication preserves exact manifest bytes and serves immutable MIME assets and HEAD", async t => {
  const f = await fixture(t);
  assert.equal((await f.update()).status, 404);
  assert.equal((await f.upload()).status, 201);
  assert.equal((await f.upload(f.image)).status, 201);
  assert.equal((await f.upload()).status, 200);
  const publication = f.envelope();
  assert.equal((await f.publish(publication)).status, 201);
  assert.equal((await f.publish(publication)).status, 200);
  const response = await f.update();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), publication.manifest);
  assert.equal(response.headers.get("content-type"), "application/expo+json");
  assert.equal(response.headers.get("expo-protocol-version"), "1");
  assert.equal(response.headers.get("expo-sfv-version"), "0");
  assert.equal(response.headers.get("expo-manifest-filters"), 'channel="production", platform="android"');
  assert.equal(response.headers.get("expo-signature"),
    `sig="${publication.signature}", keyid="main", alg="rsa-v1_5-sha256"`);
  assert.ok(verify("RSA-SHA256", Buffer.from(publication.manifest),
    new X509Certificate(f.cert).publicKey, Buffer.from(publication.signature, "base64")));
  const head = await f.update({}, "HEAD");
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(publication.manifest)));
  const hash = sha(f.image.bytes).toString("hex");
  const asset = await f.handler(new Request(f.image.descriptor.url), "asset", hash);
  assert.equal(await asset.text(), f.image.bytes);
  assert.equal(asset.headers.get("content-type"), "image/png");
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const assetHead = await f.handler(new Request(f.image.descriptor.url, { method: "HEAD" }), "asset", hash);
  assert.equal(await assetHead.text(), "");
  assert.equal(assetHead.headers.get("content-length"), String(Buffer.byteLength(f.image.bytes)));
});

test("writes reject absent/wrong credentials, browser origins, unsigned and tampered manifests", async t => {
  const f = await fixture(t);
  assert.equal((await f.upload(f.launch, { authorization: "" })).status, 401);
  assert.equal((await f.upload(f.launch, { authorization: `Bearer ${"x".repeat(600)}` })).status, 401);
  assert.equal((await f.publish(f.envelope(), { authorization: "Bearer wrong-token" })).status, 401);
  assert.equal((await f.publish(f.envelope(), { origin })).status, 403);
  assert.equal((await f.publish({ ...f.envelope(), signature: "" })).status, 400);
  const publication = f.envelope();
  assert.equal((await f.publish({ ...publication, manifest: `${publication.manifest} ` })).status, 403);
  assert.equal((await f.publish({ ...publication, keyid: "unknown" })).status, 403);
  assert.equal((await f.update()).status, 404);
});

test("partial assets, hash mismatch, traversal, external URLs and MIME mismatches never publish", async t => {
  const f = await fixture(t);
  assert.equal((await f.publish()).status, 404);
  await f.upload();
  assert.equal((await f.publish()).status, 404);
  assert.equal((await f.update()).status, 404);
  const badBody = new Request(origin, { method: "PUT", headers: {
    authorization: `Bearer ${token}`, "content-type": "image/png",
  }, body: "different" });
  assert.equal((await f.handler(badBody, "upload", sha(f.image.bytes).toString("hex"))).status, 400);
  for (const hash of ["../key.pem", "..%2fkey.pem", "a".repeat(63), "A".repeat(64)]) {
    assert.equal((await f.handler(new Request(origin), "asset", hash)).status, 400);
    assert.equal((await f.handler(new Request(origin, { method: "PUT", headers: {
      authorization: `Bearer ${token}`,
    }, body: "bytes" }), "upload", hash)).status, 400);
  }
  for (const url of ["https://evil.example/asset", `${origin}/api/updates/assets/${"0".repeat(64)}`,
    `${f.launch.descriptor.url}?token=secret`, `${origin}/api/updates/assets/../key.pem`]) {
    assert.equal((await f.publish(f.envelope(f.manifest({
      launchAsset: { ...f.launch.descriptor, url },
    })))).status, 400);
  }
  await f.upload(f.image);
  assert.equal((await f.publish(f.envelope(f.manifest({
    assets: [{ ...f.image.descriptor, contentType: "image/jpeg" }],
  })))).status, 400);
  assert.equal((await f.publish(f.envelope(f.manifest({
    assets: [{ ...f.image.descriptor, fileExtension: undefined }],
  })))).status, 400);
  assert.equal((await f.upload({ ...f.image, descriptor: { ...f.image.descriptor, contentType: "image/jpeg" } })).status, 409);
  assert.equal((await f.upload(f.image, { "content-type": "image/png; charset=utf-8" })).status, 415);
  assert.equal((await f.update()).status, 404);
});

test("platform/runtime/channel/signature and Accept negotiation remain isolated", async t => {
  const f = await fixture(t);
  await f.upload(); await f.upload(f.image); await f.publish();
  const mismatchedScopes: Record<string, string>[] = [
    { "expo-runtime-version": "runtime-other" },
    { "expo-platform": "ios" },
    { "expo-channel-name": "preview" },
  ];
  for (const headers of mismatchedScopes) assert.equal((await f.update(headers)).status, 404);
  assert.equal((await f.update({ "expo-platform": "web" })).status, 400);
  assert.equal((await f.update({ "expo-channel-name": "../production" })).status, 400);
  assert.equal((await f.update({ "expo-runtime-version": "../runtime" })).status, 400);
  assert.equal((await f.update({ "expo-protocol-version": "0" })).status, 406);
  assert.equal((await f.update({ accept: "multipart/mixed" })).status, 406);
  assert.equal((await f.update({ accept: "application/expo+json;q=0,application/json;q=0,*/*;q=1" })).status, 406);
  assert.equal((await f.update({ accept: "application/json" })).headers.get("content-type"), "application/json");
  assert.equal((await f.update({ accept: "application/expo+json;q=0.1, application/json;q=0.9" })).headers.get("content-type"), "application/json");
  assert.equal((await f.update({ "expo-expect-signature": 'sig, keyid="old", alg="rsa-v1_5-sha256"' })).status, 406);
  assert.equal((await f.update({ "expo-expect-signature": 'sig, keyid="main", alg="bad"' })).status, 406);
  assert.equal((await f.publish(f.envelope(f.manifest({ metadata: { channel: "preview", platform: "android" } })))).status, 400);
});

test("rollback republishes known-good assets with a newer signed release without changing immutable history", async t => {
  const f = await fixture(t);
  await f.upload(); await f.upload(f.image);
  const first = f.envelope(f.manifest({ createdAt: new Date(Date.now() - 30_000).toISOString() }));
  assert.equal((await f.publish(first)).status, 201);
  const second = f.envelope(f.manifest({ createdAt: new Date(Date.now() - 20_000).toISOString() }));
  assert.equal((await f.publish(second)).status, 201);
  assert.equal((await f.publish(first)).status, 409);
  const rollback = f.envelope(f.manifest({
    createdAt: new Date(Date.now() - 10_000).toISOString(), extra: { rollbackOf: JSON.parse(second.manifest).id },
  }));
  assert.equal((await f.publish(rollback)).status, 201);
  assert.equal(await (await f.update()).text(), rollback.manifest);
  assert.equal((await readdir(join(f.storageDir, "releases"))).length, 3);
  assert.equal((await readdir(join(f.storageDir, "assets"))).length, 2);
  const changedUuid = f.envelope({ ...JSON.parse(rollback.manifest), extra: { changed: true } });
  assert.equal((await f.publish(changedUuid)).status, 409);
});

test("oversize streamed/declared uploads, publication asset count and disk quotas are bounded", async t => {
  const f = await fixture(t, 100);
  assert.equal((await f.upload()).status, 201);
  assert.equal((await f.upload(f.asset("x".repeat(1000)))).status, 507);
  const oversize = new Request(origin, { method: "PUT", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/javascript",
    "content-length": String(64 * 1024 * 1024 + 1),
  }, body: "small" });
  assert.equal((await f.handler(oversize, "upload", sha("small").toString("hex"))).status, 413);
  const streamed = new Request(origin, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json",
  }, body: " ".repeat(1024 * 1024 + 1) });
  assert.equal((await f.handler(streamed, "publish")).status, 413);
  assert.equal((await f.publish(f.envelope(f.manifest({
    assets: Array.from({ length: 513 }, (_, i) => ({ ...f.image.descriptor, key: `image-${i}` })),
  })))).status, 400);
  assert.equal((await f.update()).status, 404);
  assert.deepEqual((await readdir(f.storageDir)).sort(), ["assets", "releases", "scopes"]);
});

test("concurrent writes share a filesystem lock and failed transactions do not activate partial releases", async t => {
  const f = await fixture(t);
  const responses = await Promise.all([f.upload(), f.upload()]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  await f.upload(f.image);
  await mkdir(join(f.storageDir, ".publish-lock"));
  assert.equal((await f.publish()).status, 409);
  await rm(join(f.storageDir, ".publish-lock"), { recursive: true });
  assert.equal((await f.update()).status, 404);
  // A crash after durable release creation but before scope activation is retryable.
  const envelope = f.envelope();
  const id = JSON.parse(envelope.manifest).id;
  await writeFile(join(f.storageDir, "releases", `${id}.json`), JSON.stringify(envelope));
  assert.equal((await f.publish(envelope)).status, 201);
  assert.equal(await (await f.update()).text(), envelope.manifest);
});

test("storage configuration fails closed without private keys or insecure origins", async t => {
  const f = await fixture(t);
  const config = {
    storageDir: f.storageDir, publicUrl: origin, tokenHash: sha(token).toString("hex"), certificates: { main: f.cert },
  };
  assert.throws(() => createOtaHandler({ ...config, publicUrl: "http://mint.example.com" }));
  assert.throws(() => createOtaHandler({ ...config, publicUrl: `${origin}/path` }));
  assert.throws(() => createOtaHandler({ ...config, tokenHash: "raw-token" }));
  assert.throws(() => createOtaHandler({ ...config, storageDir: "relative" }));
  assert.throws(() => createOtaHandler({ ...config, certificates: {} }));
  assert.throws(() => createOtaHandler({ ...config, maxStorageBytes: Infinity }));
  for (const extensions of [
    [],
    ["-addext", "keyUsage=keyEncipherment", "-addext", "extendedKeyUsage=codeSigning"],
    ["-addext", "keyUsage=digitalSignature", "-addext", "extendedKeyUsage=serverAuth"],
  ]) {
    execFileSync("openssl", ["req", "-x509", "-key", join(f.directory, "key.pem"),
      "-out", join(f.directory, "not-code-signing.pem"), "-days", "1",
      "-subj", "/CN=Invalid fixture", ...extensions], { stdio: "ignore" });
    const wrongUsage = await readFile(join(f.directory, "not-code-signing.pem"), "utf8");
    assert.throws(() => createOtaHandler({ ...config, certificates: { main: wrongUsage } }), /Digital Signature and Code Signing/);
  }
  const previous = process.env.OTA_STORAGE_DIR;
  delete process.env.OTA_STORAGE_DIR;
  try { assert.equal((await otaRequest(new Request(origin), "update")).status, 503); }
  finally { if (previous !== undefined) process.env.OTA_STORAGE_DIR = previous; }
});
