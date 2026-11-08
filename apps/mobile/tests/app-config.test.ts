import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const app = JSON.parse(readFileSync(resolve("app.json"), "utf8")).expo;
const eas = JSON.parse(readFileSync(resolve("eas.json"), "utf8"));

test("production uses the EAS project, fingerprint runtime and embedded recovery", () => {
  const projectId = "5a1e1df0-825c-4b34-8f29-21747fb78b97";
  assert.equal(app.slug, "mint");
  assert.equal(app.extra.eas.projectId, projectId);
  assert.equal(app.updates.url, `https://u.expo.dev/${projectId}`);
  assert.equal(app.android.package, "org.mintmusic.mobile");
  assert.equal(app.ios.bundleIdentifier, "org.mintmusic.mobile");
  assert.deepEqual(app.runtimeVersion, { policy: "fingerprint" });
  assert.equal(app.updates.enabled, true);
  assert.equal(app.updates.checkAutomatically, "ON_LOAD");
  assert.equal(app.updates.fallbackToCacheTimeout, 0);
  assert.equal(app.updates.useEmbeddedUpdate, true);
  assert.notEqual(app.updates.disableAntiBrickingMeasures, true);
  assert.ok(app.plugins.includes("./src/playback/with-audio-playlist.cjs"));
});

test("iOS production is a standalone device build with EAS signing and production updates", () => {
  const profile = eas.build["ios-production"];
  assert.equal(profile.autoIncrement, true);
  assert.equal(profile.distribution, "internal");
  assert.equal(profile.channel, "production");
  assert.equal(profile.environment, "production");
  assert.equal(profile.credentialsSource, "remote");
  assert.equal(profile.ios.simulator, false);
  assert.equal(profile.ios.buildConfiguration, "Release");
  assert.notEqual(profile.developmentClient, true);
});

test("EAS produces internal APKs using the existing local signing key", () => {
  assert.equal(eas.cli.appVersionSource, "remote");
  assert.equal(eas.build.production.autoIncrement, true);
  assert.equal(eas.build.production.channel, "production");
  assert.equal(eas.build.production.environment, "production");
  assert.equal(eas.build.production.distribution, "internal");
  assert.equal(eas.build.production.credentialsSource, "local");
  assert.equal(eas.build.production.android.buildType, "apk");
  assert.equal(eas.build.production.android.gradleCommand, ":app:assembleRelease -PreactNativeArchitectures=arm64-v8a");
  assert.equal(eas.build.production.android.image, "ubuntu-26.04-jdk-17-ndk-r27b-sdk-58");
});
