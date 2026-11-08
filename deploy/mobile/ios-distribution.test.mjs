import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { compatibleBuild, selectBuild } from "./eas-distribution.mjs";
import { iosTarget, readApplePlist, verifyIosMetadata, verifyIpa } from "./ios-distribution.mjs";

const hash = "a".repeat(40);
const team = "TESTTEAM01";
const identity = `${team}.org.mintmusic.mobile`;
const now = Date.parse("2026-01-01T00:00:00Z");
const build = {
  status: "FINISHED", platform: "IOS", distribution: "INTERNAL", buildProfile: "ios-production",
  updateChannel: { name: "production" }, appIdentifier: "org.mintmusic.mobile",
  runtime: { version: hash }, fingerprint: { hash }, artifacts: { buildUrl: "https://expo.dev/fixture.ipa" },
};
const metadata = {
  info: { CFBundleIdentifier: "org.mintmusic.mobile", CFBundleSupportedPlatforms: ["iPhoneOS"], CFBundleVersion: "1" },
  updates: {
    EXUpdatesEnabled: true, EXUpdatesURL: "https://u.expo.dev/5a1e1df0-825c-4b34-8f29-21747fb78b97",
    EXUpdatesRequestHeaders: { "expo-channel-name": "production" }, EXUpdatesRuntimeVersion: "file:fingerprint",
  },
  fingerprint: hash,
  manifest: { id: "00000000-0000-4000-8000-000000000000", commitTime: now, assets: [] },
  entitlements: {
    "application-identifier": identity, "com.apple.developer.team-identifier": team, "get-task-allow": false,
  },
  profile: {
    TeamIdentifier: [team], Entitlements: {
      "application-identifier": identity, "com.apple.developer.team-identifier": team, "get-task-allow": false,
    },
    ProvisionedDevices: ["fixture-device"], ExpirationDate: "2027-01-01T00:00:00Z",
    DeveloperCertificates: ["fixture-certificate"],
  },
  certificate: { der: "fixture-certificate", team, validFrom: "2025-01-01T00:00:00Z", validTo: "2027-01-01T00:00:00Z" },
};

test("iOS baseline requires a finished internal production build with both matching fingerprints", () => {
  assert.equal(selectBuild([build], hash, iosTarget), build);
  assert.equal(compatibleBuild(build, hash), false);
  assert.equal(selectBuild([], hash, iosTarget), null);
  assert.throws(() => selectBuild({}, hash, iosTarget), /Invalid EAS/);
  for (const change of [
    { status: "IN_PROGRESS" }, { status: "ERRORED" }, { status: "CANCELED" }, { platform: "ANDROID" },
    { distribution: "STORE" }, { buildProfile: "preview" }, { updateChannel: { name: "preview" } },
    { appIdentifier: "other.app" }, { runtime: { version: "b".repeat(40) } },
    { fingerprint: null }, { fingerprint: { hash: "b".repeat(40) } },
    { artifacts: {} }, { artifacts: { buildUrl: "http://expo.dev/fixture.ipa" } },
  ]) assert.equal(selectBuild([{ ...build, ...change }], hash, iosTarget), null);
});

test("iOS CLI gates conservatively and rejects failed, stale-commit and drifting update results", () => {
  const directory = mkdtempSync(resolve("deploy/mobile/.ios-gate-test-"));
  const script = fileURLToPath(new URL("./ios-distribution.mjs", import.meta.url));
  const run = (command, env = {}) => execFileSync(process.execPath, [script, command], {
    cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_REBUILD: "false", GITHUB_SHA: "fixture-commit", ...env },
  });
  const write = (name, value) => writeFileSync(resolve(directory, `.ios-ci/${name}.json`), JSON.stringify(value));
  const baseline = () => JSON.parse(readFileSync(resolve(directory, ".ios-ci/baseline.json"), "utf8"));
  try {
    mkdirSync(resolve(directory, ".ios-ci"));
    write("runtime", { runtimeVersion: hash, fingerprintSources: [{}] });
    write("builds", []);
    run("gate");
    assert.equal(baseline(), null);
    write("builds", [build]);
    run("gate");
    assert.equal(baseline().platform, "IOS");
    assert.equal(run("artifact-url").trim(), build.artifacts.buildUrl);
    run("gate", { FORCE_REBUILD: "true" });
    assert.equal(baseline(), null);
    assert.throws(() => run("artifact-url"));
    write("build-result", [{ ...build, gitCommitHash: "fixture-commit" }]);
    run("build-result");
    assert.equal(baseline().gitCommitHash, "fixture-commit");
    for (const result of [
      [], [{ ...build, gitCommitHash: "old-commit" }], [{ ...build, status: "ERRORED" }],
      [build, build],
    ]) {
      write("build-result", result);
      assert.throws(() => run("build-result"));
    }
    write("update-runtime", { runtimeVersion: hash, fingerprintSources: [{}] });
    run("validate-update-runtime");
    write("update-runtime", { runtimeVersion: "b".repeat(40), fingerprintSources: [{}] });
    assert.throws(() => run("validate-update-runtime"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("iOS binary metadata enforces exact runtime, channel and embedded recovery", () => {
  assert.doesNotThrow(() => verifyIosMetadata(metadata, hash, team, now));
  for (const [field, value] of [
    ["EXUpdatesEnabled", false], ["EXUpdatesURL", "https://other.example"],
    ["EXUpdatesRequestHeaders", { "expo-channel-name": "preview" }],
    ["EXUpdatesRuntimeVersion", hash], ["EXUpdatesHasEmbeddedUpdate", false],
    ["EXUpdatesDisableAntiBrickingMeasures", true], ["EXUpdatesCheckOnLaunch", "NEVER"],
    ["EXUpdatesLaunchWaitMs", 30000],
  ]) assert.throws(() => verifyIosMetadata({ ...metadata, updates: { ...metadata.updates, [field]: value } }, hash, team, now));
  assert.throws(() => verifyIosMetadata({ ...metadata, fingerprint: "b".repeat(40) }, hash, team, now));
  assert.throws(() => verifyIosMetadata({ ...metadata, manifest: {} }, hash, team, now));
  assert.throws(() => verifyIosMetadata({ ...metadata, info: { ...metadata.info, CFBundleSupportedPlatforms: ["iPhoneSimulator"] } }, hash, team, now));
  assert.throws(() => verifyIosMetadata({ ...metadata, info: { ...metadata.info, CFBundleIdentifier: "other.app" } }, hash, team, now));
  assert.throws(() => verifyIosMetadata({ ...metadata, entitlements: { ...metadata.entitlements, "get-task-allow": true } }, hash, team, now));
});

test("iOS signing gate rejects wrong teams, expired credentials and non-ad-hoc provisioning", () => {
  assert.throws(() => verifyIosMetadata(metadata, hash, "", now), /IOS_APPLE_TEAM_ID/);
  assert.throws(() => verifyIosMetadata(metadata, hash, "OTHERTEAM1", now), /Apple team/);
  for (const change of [
    { TeamIdentifier: ["OTHERTEAM1"] }, { ExpirationDate: "invalid" }, { ExpirationDate: "2025-01-01T00:00:00Z" },
    { ProvisionedDevices: [] }, { ProvisionedDevices: undefined }, { ProvisionsAllDevices: true },
    { DeveloperCertificates: ["other-certificate"] },
    { Entitlements: { ...metadata.profile.Entitlements, "application-identifier": `${team}.*` } },
  ]) assert.throws(() => verifyIosMetadata({ ...metadata, profile: { ...metadata.profile, ...change } }, hash, team, now), /provisioning/);
  for (const change of [
    { team: "OTHERTEAM1" }, { validFrom: "2027-01-01T00:00:00Z" }, { validTo: "2025-01-01T00:00:00Z" },
  ]) assert.throws(() => verifyIosMetadata({ ...metadata, certificate: { ...metadata.certificate, ...change } }, hash, team, now), /certificate/);
});

test("Apple plist parser preserves actual dates and binary certificate data", () => {
  const directory = mkdtempSync(resolve("deploy/mobile/.ios-plist-test-"));
  try {
    const file = resolve(directory, "profile.plist");
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>ExpirationDate</key><date>2027-01-01T00:00:00Z</date>
<key>DeveloperCertificates</key><array><data>ZmFrZQ==</data></array>
<key>get-task-allow</key><false/>
</dict></plist>`);
    assert.deepEqual(readApplePlist(file), {
      ExpirationDate: "2027-01-01T00:00:00Z", DeveloperCertificates: ["ZmFrZQ=="], "get-task-allow": false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("actual macOS IPA signature verification rejects unsigned app archives", { skip: process.platform !== "darwin" }, () => {
  mkdirSync(".ios-ci", { recursive: true });
  const directory = mkdtempSync(resolve(".ios-ci/unsigned-test-"));
  try {
    mkdirSync(resolve(directory, "Payload/Mint.app"), { recursive: true });
    writeFileSync(resolve(directory, "Payload/Mint.app/Info.plist"), "<plist><dict/></plist>");
    const ipa = resolve(directory, "unsigned.ipa");
    execFileSync("ditto", ["-c", "-k", "--keepParent", resolve(directory, "Payload"), ipa]);
    assert.throws(() => verifyIpa(ipa, hash, team));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("iOS CI waits for and verifies a build or publishes a platform-scoped guarded update", () => {
  const workflow = yaml.load(readFileSync(new URL("../../.github/workflows/ios-eas.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.permissions.contents, "read");
  const steps = workflow.jobs.distribute.steps;
  const nativeBuild = steps.find(step => step.name === "Build production IPA and refresh registered devices");
  assert.equal(nativeBuild.if, "steps.gate.outputs.build == 'true'");
  assert.match(nativeBuild.run, /--wait --refresh-ad-hoc-provisioning-profile/);
  assert.match(nativeBuild.run, /build-result/);
  assert.match(nativeBuild.run, /verify-ipa/);
  assert.doesNotMatch(nativeBuild.run, /eas update/);
  const update = steps.find(step => step.name === "Publish compatible production iOS update");
  assert.equal(update.if, "steps.gate.outputs.build == 'false'");
  assert.ok(update.run.indexOf("validate-update-runtime") < update.run.indexOf("eas update"));
  assert.match(update.run, /eas update --platform ios --channel production --environment production/);
  assert.match(steps.find(step => step.id === "gate").run, /verify-ipa/);
  assert.equal(steps.at(-1).if, "always()");
  assert.match(steps.at(-1).run, /rm -f .ios-ci\/AuthKey.p8/);
});
