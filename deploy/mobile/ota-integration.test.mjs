import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOtaHandler } from "../../apps/web/src/lib/ota-updates.ts";
import { createPublication, publishUpdate } from "./ota-publish.mjs";

test("Expo Android export publishes through the actual signed self-hosted handler and supports a new-ID rollback", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mint-ota-producer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
    "-days", "1", "-subj", "/CN=Mint disposable producer fixture",
    "-addext", "keyUsage=digitalSignature", "-addext", "extendedKeyUsage=codeSigning"], { stdio: "ignore" });
  const exportDir = join(directory, "export");
  await mkdir(join(exportDir, "assets"), { recursive: true });
  await writeFile(join(exportDir, "bundle.hbc"), "fixture-hermes-bytecode");
  await writeFile(join(exportDir, "assets", "fixture-image-key"), "fixture-image");
  await writeFile(join(exportDir, "metadata.json"), JSON.stringify({
    version: 0, bundler: "metro", fileMetadata: { android: {
      bundle: "bundle.hbc", assets: [{ path: "assets/fixture-image-key", ext: "png" }],
    } },
  }));
  const certificatePem = await readFile(join(directory, "cert.pem"), "utf8");
  const privateKeyPem = await readFile(join(directory, "key.pem"), "utf8");
  const token = "disposable-fixture-token-never-use-in-production-0123456789";
  const updateUrl = "https://mint.example.com/api/updates";
  const handler = createOtaHandler({
    storageDir: join(directory, "storage"), publicUrl: "https://mint.example.com",
    tokenHash: createHash("sha256").update(token).digest("hex"),
    certificates: { main: certificatePem },
  });
  const request = async (url, options) => {
    const path = new URL(url).pathname;
    const action = path === "/api/updates" ? "update" :
      path === "/api/updates/publish" ? "publish" : "upload";
    return handler(new Request(url, options), action, path.split("/").at(-1));
  };
  const options = { directory: exportDir, updateUrl, runtime: "a".repeat(64),
    channel: "production", certificatePem, privateKeyPem };
  const publication = await createPublication(options);
  await publishUpdate({ publication, updateUrl, token, request });
  assert.equal(publication.manifest.assets[0].key, "fixture-image-key");
  assert.equal(publication.manifest.launchAsset.contentType, "application/javascript");
  assert.equal(publication.manifest.assets[0].hash.length, 43);
  const rollback = await createPublication({ ...options, now: new Date(Date.now() + 1000) });
  await publishUpdate({ publication: rollback, updateUrl, token, request });
  assert.notEqual(rollback.manifest.id, publication.manifest.id);
  assert.equal(rollback.manifest.runtimeVersion, publication.manifest.runtimeVersion);
  assert.equal(rollback.manifest.launchAsset.hash, publication.manifest.launchAsset.hash);
  assert.ok(rollback.manifest.createdAt > publication.manifest.createdAt);

  await writeFile(join(exportDir, "metadata.json"), JSON.stringify({
    version: 0, bundler: "metro", fileMetadata: { android: { bundle: "../key.pem", assets: [] } },
  }));
  await assert.rejects(createPublication(options), /escapes its export directory/);
});
