import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modifyConfigAsync } from "@expo/config";
import { compatibleBuild, resolvedAppConfig, runtimeFromResolution, selectBuild, validateLink, verifyArm64Elf, verifyManifest } from "./eas-distribution.mjs";

const hash = "a".repeat(40);
const build = {
  status: "FINISHED", platform: "ANDROID", distribution: "INTERNAL", buildProfile: "production",
  updateChannel: { name: "production" }, appIdentifier: "org.mintmusic.mobile",
  runtime: { version: hash }, fingerprint: { hash }, artifacts: { buildUrl: "https://expo.dev/apk" },
};

test("arm64 native libraries retain Pixel 16-KiB ELF page alignment", () => {
  const elf = Buffer.alloc(120);
  Buffer.from("7f454c46", "hex").copy(elf);
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(183, 18);
  elf.writeBigUInt64LE(64n, 32);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(1, 56);
  elf.writeUInt32LE(1, 64);
  elf.writeBigUInt64LE(16384n, 112);
  assert.doesNotThrow(() => verifyArm64Elf(elf));
  elf.writeBigUInt64LE(4096n, 112);
  assert.throws(() => verifyArm64Elf(elf), /16-KiB/);
  assert.throws(() => verifyArm64Elf(elf.subarray(0, 80)), /program headers/);
  elf.writeUInt16LE(62, 18);
  assert.throws(() => verifyArm64Elf(elf), /arm64/);
});

test("runtime resolver requires actual fingerprint sources", () => {
  assert.equal(runtimeFromResolution({ runtimeVersion: hash, fingerprintSources: [{}] }), hash);
  for (const bad of [{}, { runtimeVersion: hash }, { runtimeVersion: hash, fingerprintSources: [] }]) {
    assert.throws(() => runtimeFromResolution(bad));
  }
});

test("only finished production APK metadata for this exact fingerprint qualifies", () => {
  assert.equal(selectBuild([build], hash), build);
  for (const change of [
    { status: "ERRORED" }, { platform: "IOS" }, { distribution: "STORE" },
    { buildProfile: "preview" }, { updateChannel: { name: "preview" } },
    { appIdentifier: "org.other.mobile" }, { runtime: { version: "b".repeat(40) } },
    { fingerprint: null }, { fingerprint: { hash: "b".repeat(40) } },
    { artifacts: {} }, { artifacts: { buildUrl: "http://example.com" } },
  ]) assert.equal(compatibleBuild({ ...build, ...change }, hash), false);
  assert.equal(selectBuild([], hash), null);
});

test("initialization may align only owner and slug with the authorized project", () => {
  const projectId = "5a1e1df0-825c-4b34-8f29-21747fb78b97";
  const original = { expo: { slug: "mint-mobile", android: { package: "org.mintmusic.mobile" }, extra: { eas: { projectId } } } };
  const initialized = { expo: { ...original.expo, slug: "mint", owner: "fixture-owner" } };
  const result = { projectId, slug: "mint", owner: "fixture-owner" };
  assert.doesNotThrow(() => validateLink(original, initialized, result));
  assert.throws(() => validateLink(original, initialized, { ...result, projectId: "different" }));
  assert.throws(() => validateLink(original, { expo: { ...initialized.expo, android: { package: "org.other.mobile" } } }, result));
});

test("actual Expo config writer preserves resolved audio permissions during linking", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mint-eas-link-"));
  try {
    for (const name of ["app.json", "package.json"]) {
      copyFileSync(new URL(`../../apps/mobile/${name}`, import.meta.url), join(directory, name));
    }
    symlinkSync(new URL("../../node_modules", import.meta.url), join(directory, "node_modules"));
    symlinkSync(new URL("../../apps/mobile/src", import.meta.url), join(directory, "src"));
    const original = resolvedAppConfig(directory);
    await modifyConfigAsync(directory, { owner: "fixture-owner", slug: "mint" });
    const initialized = resolvedAppConfig(directory);
    const raw = JSON.parse(readFileSync(join(directory, "app.json"), "utf8"));
    assert.ok(raw.expo.android.permissions.includes("android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"));
    const result = { projectId: original.expo.extra.eas.projectId, owner: "fixture-owner", slug: "mint" };
    assert.doesNotThrow(() => validateLink(original, initialized, result));
    await modifyConfigAsync(directory, { android: { package: "org.other.mobile" } });
    assert.throws(() => validateLink(original, resolvedAppConfig(directory), result), /beyond/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("APK manifest must enable the intended endpoint, channel and recovery", () => {
  const manifest = `
    <meta-data android:name="expo.modules.updates.ENABLED" android:value="true"/>
    <meta-data android:name="expo.modules.updates.EXPO_UPDATE_URL" android:value="https://u.expo.dev/5a1e1df0-825c-4b34-8f29-21747fb78b97"/>
    <meta-data android:name="expo.modules.updates.EXPO_RUNTIME_VERSION" android:value="@string/expo_runtime_version"/>
    <meta-data android:name="expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY" android:value="{&quot;expo-channel-name&quot;:&quot;production&quot;}"/>
  `;
  assert.doesNotThrow(() => verifyManifest(manifest));
  assert.throws(() => verifyManifest(manifest.replace('android:value="true"', 'android:value="false"')));
  assert.throws(() => verifyManifest(manifest.replace("production", "preview")));
  assert.throws(() => verifyManifest(manifest + '<meta-data android:name="expo.modules.updates.HAS_EMBEDDED_UPDATE" android:value="false"/>'));
  assert.throws(() => verifyManifest(manifest + '<meta-data android:name="expo.modules.updates.DISABLE_ANTI_BRICKING_MEASURES" android:value="true"/>'));
});
