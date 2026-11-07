import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const configure = require("../app.config.js") as (input: { config: { android: { package: string; versionCode?: number }; plugins: unknown[] } }) => {
  android: { package: string; versionCode?: number }; plugins: unknown[];
};

test("CI version code is explicit, bounded and inert during default/fingerprint configuration", () => {
  const original = process.env.MINT_ANDROID_VERSION_CODE;
  const config = { android: { package: "org.mintmusic.mobile" }, plugins: ["expo-router"] };
  try {
    delete process.env.MINT_ANDROID_VERSION_CODE;
    assert.equal(configure({ config }), config);
    process.env.MINT_ANDROID_VERSION_CODE = "27";
    const result = configure({ config });
    assert.equal(result.android.versionCode, 27);
    assert.equal(result.android.package, config.android.package);
    assert.equal(result.plugins, config.plugins);
    for (const value of ["0", "-1", "1.5", "NaN", "2100000001"]) {
      process.env.MINT_ANDROID_VERSION_CODE = value;
      assert.throws(() => configure({ config }), /MINT_ANDROID_VERSION_CODE/);
    }
  } finally {
    if (original === undefined) delete process.env.MINT_ANDROID_VERSION_CODE;
    else process.env.MINT_ANDROID_VERSION_CODE = original;
  }
});

test("self-hosted OTA pins channel, certificate and native runtime while preserving offline launch", () => {
  const names = ["MINT_OTA_URL", "MINT_OTA_CERTIFICATE_PATH", "MINT_OTA_CHANNEL", "MINT_NATIVE_RUNTIME"];
  const originals = names.map((name) => process.env[name]);
  const configureOta = require("../app.config.js") as (input: { config: object }) => {
    runtimeVersion: string;
    updates: { url: string; enabled: boolean; codeSigningCertificate: string;
      requestHeaders: { "expo-channel-name": string }; useEmbeddedUpdate: boolean;
      disableAntiBrickingMeasures: boolean; fallbackToCacheTimeout: number };
  };
  try {
    process.env.MINT_OTA_URL = "https://mint.example.com/api/updates";
    process.env.MINT_OTA_CERTIFICATE_PATH = "./fixture-certificate.pem";
    process.env.MINT_OTA_CHANNEL = "production";
    process.env.MINT_NATIVE_RUNTIME = "a".repeat(64);
    const result = configureOta({ config: {} });
    assert.equal(result.runtimeVersion, "a".repeat(64));
    assert.equal(result.updates.requestHeaders["expo-channel-name"], "production");
    assert.equal(result.updates.codeSigningCertificate, "./fixture-certificate.pem");
    assert.equal(result.updates.useEmbeddedUpdate, true);
    assert.equal(result.updates.disableAntiBrickingMeasures, false);
    assert.equal(result.updates.fallbackToCacheTimeout, 0);
    delete process.env.MINT_OTA_CERTIFICATE_PATH;
    assert.throws(() => configureOta({ config: {} }), /unsigned OTA/);
    process.env.MINT_OTA_CERTIFICATE_PATH = "./fixture-certificate.pem";
    process.env.MINT_OTA_URL = "http://mint.example.com/api/updates";
    assert.throws(() => configureOta({ config: {} }), /HTTPS/);
  } finally {
    names.forEach((name, index) => {
      if (originals[index] === undefined) delete process.env[name];
      else process.env[name] = originals[index];
    });
  }
});
