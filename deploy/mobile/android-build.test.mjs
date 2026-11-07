import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APK_ARTIFACT, androidToolchain, buildDecision, latestBaseline, prepareSigning, validateState, verifyNativeUpdates, versionCode } from "./android-build.mjs";

const runtime = "a".repeat(64);
const state = { schema: 1, runtime, signingCertificate: "b".repeat(64), versionCode: 1794000000, runId: 42, commit: "commit", apkArtifactId: 7 };
const run = { id: 42, head_sha: "commit" };
const artifacts = [{ id: 7, name: APK_ARTIFACT, expired: false }];

test("bootstrap, manual force, native change and compatible JS changes", () => {
  assert.equal(buildDecision({ runtime }, null).build, true);
  assert.equal(buildDecision({ runtime }, state, true).build, true);
  assert.equal(buildDecision({ runtime: "c".repeat(64) }, state).build, true);
  assert.equal(buildDecision({ runtime }, state).build, false);
  assert.throws(() => buildDecision({ runtime: "unknown" }, state), /Invalid/);
});

test("baseline binds successful uploaded APK to the exact build SHA/run", () => {
  assert.deepEqual(validateState(state, run, artifacts), state);
  assert.throws(() => validateState(state, { ...run, head_sha: "other" }, artifacts), /Invalid/);
  assert.throws(() => validateState(state, run, [{ ...artifacts[0], expired: true }]), /Invalid/);
  assert.throws(() => validateState({ ...state, versionCode: 0 }, run, artifacts), /Invalid/);
});

test("versionCode increases for retries and newer builds, surviving missing baseline", () => {
  const now = 1794000100000;
  assert.equal(versionCode(now), 58310500);
  assert.equal(versionCode(now, 1794000200), 1794000201);
  assert.throws(() => versionCode((2100000001 + 1735689600) * 1000), /exhausted/);
});

test("Android SDK/build-tools/NDK come from actual resolved RN catalog and prebuild overrides", () => {
  const catalog = 'compileSdk = "37"\nbuildTools = "37.0.0"\nndkVersion = "27.1.12297006"';
  assert.deepEqual(androidToolchain(catalog, ""), { compileSdk: "37", buildTools: "37.0.0", ndk: "27.1.12297006" });
  assert.equal(androidToolchain(catalog, "android.compileSdkVersion=38").compileSdk, "38");
  assert.throws(() => androidToolchain("", ""), /Missing Android/);
});

test("native verification rejects disabled, unsigned and wrong-runtime prebuild output", () => {
  const env = { MINT_OTA_URL: "https://mint.example.com/api/updates", MINT_NATIVE_RUNTIME: runtime };
  const fields = {
    ENABLED: "true", EXPO_UPDATE_URL: env.MINT_OTA_URL, CODE_SIGNING_CERTIFICATE: "fixture-certificate",
    CODE_SIGNING_METADATA: '{&quot;keyid&quot;:&quot;main&quot;,&quot;alg&quot;:&quot;rsa-v1_5-sha256&quot;}',
    UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY: '{&quot;expo-channel-name&quot;:&quot;production&quot;}',
  };
  const manifest = Object.entries(fields).map(([name, value]) =>
    `<meta-data android:name="expo.modules.updates.${name}" android:value="${value}"/>`).join("\n");
  const strings = `<string name="expo_runtime_version">${runtime}</string>`;
  verifyNativeUpdates(manifest, strings, env, "fixture-certificate");
  assert.throws(() => verifyNativeUpdates(manifest.replace('android:value="true"', 'android:value="false"'), strings, env, "fixture-certificate"), /unsafe signed/);
  assert.throws(() => verifyNativeUpdates(manifest, strings, env, "other-certificate"), /unsafe signed/);
  assert.throws(() => verifyNativeUpdates(manifest, strings, { ...env, MINT_NATIVE_RUNTIME: "c".repeat(64) }, "fixture-certificate"), /runtime/);
});

test("missing signing secrets and malformed base64 fail before writing a key", async () => {
  await assert.rejects(prepareSigning({}, "/unused", null), /Missing ANDROID_KEYSTORE_BASE64/);
  await assert.rejects(prepareSigning({
    ANDROID_KEYSTORE_BASE64: "!", ANDROID_KEYSTORE_PASSWORD: "fixture", ANDROID_KEY_ALIAS: "fixture",
    ANDROID_KEY_PASSWORD: "fixture", ANDROID_SIGNING_CERT_SHA256: "b".repeat(64),
  }, "/unused", null), /not valid base64/);
});

test("successful skip runs and expired APK runs are not native baselines", async () => {
  const requested = [];
  const request = async (url) => {
    requested.push(url);
    const payload = url.includes("/workflows/") ? { workflow_runs: [
      { id: 44, event: "push" }, { id: 43, event: "workflow_dispatch" },
    ] } : { artifacts: url.includes("/44/") ? [] : [
      { name: "mint-android-native-state", id: 1, expired: false },
      { name: APK_ARTIFACT, id: 2, expired: true },
    ] };
    return { ok: true, json: async () => payload };
  };
  assert.equal(await latestBaseline({ api: "https://api.example", repository: "owner/repo", branch: "main", token: "fixture", request }), null);
  assert.match(requested[0], /status=completed/);
  assert.equal(requested.length, 3);
});

test("API failures are errors, not OTA-only success", async () => {
  await assert.rejects(latestBaseline({
    api: "https://api.example", repository: "owner/repo", branch: "main", token: "fixture",
    request: async () => ({ ok: false, status: 403 }),
  }), /API failed \(403\)/);
});

test("failed/cancelled APK jobs never replace the last successful APK, even when later OTA failed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mint-apk-baseline-"));
  const cwd = process.cwd();
  t.after(async () => { process.chdir(cwd); await rm(directory, { recursive: true, force: true }); });
  const baseline = { ...state, runId: 99 };
  await writeFile(join(directory, "native-state.json"), JSON.stringify(baseline));
  execFileSync("python3", ["-c",
    "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as archive: archive.write(sys.argv[2], 'native-state.json')",
    join(directory, "state.zip"), join(directory, "native-state.json")]);
  const zip = await readFile(join(directory, "state.zip"));
  process.chdir(directory);
  const request = async url => {
    let payload;
    if (url.includes("/workflows/")) payload = { workflow_runs: [
      { id: 103, event: "push", conclusion: "cancelled" }, { id: 102, event: "push", conclusion: "failure" },
      { id: 101, event: "push", conclusion: "success" },
      { ...run, id: 99, event: "push", conclusion: "failure" },
    ] };
    else if (url.includes("/artifacts/1/zip")) return {
      ok: true, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
    };
    else if (url.includes("/jobs?")) payload = { jobs: [{
      name: "APK", conclusion: url.includes("/99/") ? "success" : url.includes("/103/") ? "cancelled" : "failure",
    }] };
    else payload = { artifacts: url.includes("/101/") ? [] : [
      { id: 1, name: "mint-android-native-state", expired: false }, ...artifacts,
    ] };
    return { ok: true, json: async () => payload };
  };
  const result = await latestBaseline({ api: "https://api.example", repository: "owner/repo", branch: "main", token: "fixture", request });
  assert.equal(result.runId, 99);
  assert.equal(result.runtime, state.runtime);
});
