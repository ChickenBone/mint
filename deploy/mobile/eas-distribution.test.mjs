import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { modifyConfigAsync } from "@expo/config";
import { compatibleBuild, parseManifestTree, resolvedAppConfig, runtimeFromResolution, selectBuild, validateLink, validateUpdateRuntime, verifyArm64Elf, verifyManifest } from "./eas-distribution.mjs";

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

test("update publication requires matching resolved runtimes with fingerprint sources", () => {
  const current = { runtimeVersion: hash, fingerprintSources: [{}] };
  assert.doesNotThrow(() => validateUpdateRuntime(current, structuredClone(current)));
  assert.throws(() => validateUpdateRuntime(current, { ...current, runtimeVersion: "b".repeat(40) }), /Runtime changed/);
  assert.throws(() => validateUpdateRuntime(current, { runtimeVersion: hash }), /fingerprint/);
  assert.throws(() => validateUpdateRuntime({ runtimeVersion: hash }, current), /fingerprint/);
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
  const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".eas-link-test-"));
  try {
    for (const name of ["app.json", "package.json"]) {
      copyFileSync(new URL(`../../apps/mobile/${name}`, import.meta.url), join(directory, name));
    }
    symlinkSync(new URL("../../node_modules", import.meta.url), join(directory, "node_modules"));
    symlinkSync(new URL("../../apps/mobile/src", import.meta.url), join(directory, "src"));
    const original = JSON.parse(JSON.stringify(resolvedAppConfig(directory)));
    assert.deepEqual(resolvedAppConfig(directory), original);
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

const android = "http://schemas.android.com/apk/res/android:";
const stringValue = value => `"${value}" (Raw: "${value}")`;
const metadata = (name, value) => `          E: meta-data (line=1)
            A: ${android}name(0x01010003)=${stringValue(`expo.modules.updates.${name}`)}
            A: ${android}value(0x01010024)=${value}
`;
const manifest = `N: android=http://schemas.android.com/apk/res/android (line=1)
  E: manifest (line=1)
    A: package=${stringValue("org.mintmusic.mobile")}
      E: application (line=1)
        A: ${android}debuggable(0x0101000f)=false
${metadata("ENABLED", "true")}${metadata("EXPO_UPDATE_URL", stringValue("https://u.expo.dev/5a1e1df0-825c-4b34-8f29-21747fb78b97"))}${metadata("EXPO_RUNTIME_VERSION", "@0x7f010000")}${metadata("UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY", stringValue('{"expo-channel-name":"production"}'))}`;
const resources = `Binary APK
Package name=org.mintmusic.mobile id=7f
  type string id=01 entryCount=2
    resource 0x7f010000 string/expo_runtime_version
      () "file:fingerprint"
    resource 0x7f010001 string/unrelated
      () "other"
`;

test("binary manifest JSON quotes remain literal and Android metadata stays typed", () => {
  const nodes = parseManifestTree(manifest);
  assert.equal(nodes[1].attributes.get("android:debuggable"), false);
  assert.equal(nodes.at(-1).attributes.get("android:value"), '{"expo-channel-name":"production"}');
  assert.doesNotThrow(() => verifyManifest(manifest, resources));
});

test("APK manifest must enable the intended package, endpoint, channel and recovery", () => {
  for (const bad of [
    manifest.replace("org.mintmusic.mobile", "org.other.mobile"),
    manifest.replace("debuggable(0x0101000f)=false", "debuggable(0x0101000f)=true"),
    manifest.replace(metadata("ENABLED", "true"), metadata("ENABLED", "false")),
    manifest.replace(metadata("ENABLED", "true"), metadata("ENABLED", stringValue("true"))),
    manifest.replace("u.expo.dev", "example.com"),
    manifest.replaceAll("production", "preview"),
    manifest.replaceAll('{"expo-channel-name":"production"}', "not JSON"),
    manifest.replaceAll('{"expo-channel-name":"production"}', "null"),
    manifest + metadata("HAS_EMBEDDED_UPDATE", "false"),
    manifest + metadata("DISABLE_ANTI_BRICKING_MEASURES", "true"),
    manifest + metadata("EXPO_UPDATES_CHECK_ON_LAUNCH", stringValue("NEVER")),
    manifest + metadata("EXPO_UPDATES_LAUNCH_WAIT_MS", "30000"),
    manifest + metadata("ENABLED", "true"),
    manifest.replace("E: application", "E: service"),
  ]) assert.throws(() => verifyManifest(bad, resources));
  assert.doesNotThrow(() => verifyManifest(manifest.replace(`        A: ${android}debuggable(0x0101000f)=false\n`, ""), resources));
  assert.doesNotThrow(() => verifyManifest(manifest + metadata("HAS_EMBEDDED_UPDATE", "true") +
    metadata("DISABLE_ANTI_BRICKING_MEASURES", "false") +
    metadata("EXPO_UPDATES_CHECK_ON_LAUNCH", stringValue("ALWAYS")) +
    metadata("EXPO_UPDATES_LAUNCH_WAIT_MS", "0"), resources));
});

test("manifest runtime reference must bind to the sole default fingerprint resource", () => {
  assert.doesNotThrow(() => verifyManifest(manifest, resources.replace("string/expo_runtime_version\n", "string/expo_runtime_version PUBLIC\n")));
  for (const badResources of [
    "", resources.replace("file:fingerprint", hash), resources.replace("() ", "(en) "),
    resources.replace('() "file:fingerprint"', '() "file:fingerprint"\n      (en) "different"'),
    resources + '    resource 0x7f010002 string/expo_runtime_version\n      () "file:fingerprint"\n',
  ]) assert.throws(() => verifyManifest(manifest, badResources), /runtime metadata/);
  assert.throws(() => verifyManifest(manifest.replace("@0x7f010000", "@0x7f010001"), resources), /runtime metadata/);
  assert.throws(() => verifyManifest(manifest.replace("@0x7f010000", stringValue("file:fingerprint")), resources), /runtime metadata/);
});

test("supported aapt2 parses compiled binary XML containing Expo JSON channel metadata", {
  skip: !process.env.AAPT2 || !process.env.ANDROID_JAR,
}, () => {
  const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".eas-binary-test-"));
  try {
    mkdirSync(join(directory, "res/values"), { recursive: true });
    writeFileSync(join(directory, "res/values/strings.xml"), '<resources><string name="expo_runtime_version">file:fingerprint</string></resources>');
    writeFileSync(join(directory, "AndroidManifest.xml"), `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="org.mintmusic.mobile"><application android:debuggable="false">
      <meta-data android:name="expo.modules.updates.ENABLED" android:value="true"/>
      <meta-data android:name="expo.modules.updates.EXPO_UPDATE_URL" android:value="https://u.expo.dev/5a1e1df0-825c-4b34-8f29-21747fb78b97"/>
      <meta-data android:name="expo.modules.updates.EXPO_RUNTIME_VERSION" android:value="@string/expo_runtime_version"/>
      <meta-data android:name="expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY" android:value="{&quot;expo-channel-name&quot;:&quot;production&quot;}"/>
    </application></manifest>`);
    execFileSync(process.env.AAPT2, ["compile", "--dir", join(directory, "res"), "-o", join(directory, "resources.zip")]);
    const apk = join(directory, "test.apk");
    execFileSync(process.env.AAPT2, ["link", "-I", process.env.ANDROID_JAR, "--manifest",
      join(directory, "AndroidManifest.xml"), "-o", apk, join(directory, "resources.zip")]);
    const tree = execFileSync(process.env.AAPT2, ["dump", "xmltree", "--file", "AndroidManifest.xml", apk], { encoding: "utf8" });
    const table = execFileSync(process.env.AAPT2, ["dump", "resources", apk], { encoding: "utf8" });
    assert.doesNotThrow(() => verifyManifest(tree, table));
    assert.equal(parseManifestTree(tree).at(-1).attributes.get("android:value"), '{"expo-channel-name":"production"}');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
