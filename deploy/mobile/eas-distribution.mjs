import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getConfig } from "@expo/config";

export function resolvedAppConfig(projectDir) {
  const { _internal, ...expo } = getConfig(projectDir).exp;
  return JSON.parse(JSON.stringify({ expo }));
}

export function runtimeFromResolution(result) {
  if (!/^[a-f0-9]{40,64}$/.test(result?.runtimeVersion ?? "") ||
      !Array.isArray(result.fingerprintSources) || result.fingerprintSources.length === 0) {
    throw new Error("Missing fingerprint runtime or sources; refusing OTA-only classification.");
  }
  return result.runtimeVersion;
}

export function compatibleBuild(build, runtime) {
  return build?.status === "FINISHED" && build.platform === "ANDROID" &&
    build.distribution === "INTERNAL" && build.buildProfile === "production" &&
    build.updateChannel?.name === "production" &&
    build.appIdentifier === "org.mintmusic.mobile" &&
    build.runtime?.version === runtime && build.fingerprint?.hash === runtime &&
    typeof build.artifacts?.buildUrl === "string" &&
    /^https:\/\//.test(build.artifacts.buildUrl);
}

export function validateLink(original, initialized, result) {
  const projectId = "5a1e1df0-825c-4b34-8f29-21747fb78b97";
  if (original.expo?.extra?.eas?.projectId !== projectId ||
      initialized.expo?.extra?.eas?.projectId !== projectId || result?.projectId !== projectId ||
      typeof result.owner !== "string" || !result.owner ||
      typeof result.slug !== "string" || !result.slug ||
      initialized.expo.owner !== result.owner || initialized.expo.slug !== result.slug) {
    throw new Error("EAS initialized project identity does not match the authorized project.");
  }
  const withoutAccountMetadata = (value) => {
    const copy = structuredClone(value);
    delete copy.expo.owner;
    delete copy.expo.slug;
    return copy;
  };
  if (!isDeepStrictEqual(withoutAccountMetadata(original), withoutAccountMetadata(initialized))) {
    throw new Error("EAS initialization changed configuration beyond the linked owner/slug.");
  }
}

export function selectBuild(builds, runtime) {
  if (!Array.isArray(builds)) throw new Error("Invalid EAS build list.");
  return builds.find((build) => compatibleBuild(build, runtime)) ?? null;
}

export function verifyManifest(manifest) {
  const entries = new Map();
  for (const tag of manifest.match(/<meta-data\b[^>]*\/?>/g) ?? []) {
    const name = tag.match(/android:name="([^"]*)"/)?.[1];
    const value = tag.match(/android:value="([^"]*)"/)?.[1]
      ?.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
    if (name) entries.set(name, value);
  }
  const prefix = "expo.modules.updates.";
  if (entries.get(`${prefix}ENABLED`) !== "true" ||
      entries.get(`${prefix}EXPO_UPDATE_URL`) !== "https://u.expo.dev/5a1e1df0-825c-4b34-8f29-21747fb78b97" ||
      !entries.has(`${prefix}EXPO_RUNTIME_VERSION`) ||
      entries.get(`${prefix}HAS_EMBEDDED_UPDATE`) === "false" ||
      entries.get(`${prefix}DISABLE_ANTI_BRICKING_MEASURES`) === "true") {
    throw new Error("APK manifest has unsafe or missing Expo Updates configuration.");
  }
  let headers;
  try { headers = JSON.parse(entries.get(`${prefix}UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY`) ?? ""); }
  catch { throw new Error("APK manifest has missing or invalid update channel headers."); }
  if (headers["expo-channel-name"] !== "production") throw new Error("APK update channel is not production.");
}

function certificate(env) {
  const expected = (env.ANDROID_SIGNING_CERT_SHA256 ?? "").replaceAll(":", "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Missing or invalid ANDROID_SIGNING_CERT_SHA256.");
  return expected;
}

function prepareCredentials(env) {
  for (const name of ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) {
    if (!env[name]) throw new Error(`Missing ${name}.`);
  }
  const encoded = env.ANDROID_KEYSTORE_BASE64.replaceAll(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) throw new Error("Invalid keystore base64.");
  const keystore = resolve(".android-ci/release.keystore");
  writeFileSync(keystore, Buffer.from(encoded, "base64"), { mode: 0o600 });
  const der = execFileSync("keytool", ["-exportcert", "-keystore", keystore, "-alias", env.ANDROID_KEY_ALIAS,
    "-storepass:env", "ANDROID_KEYSTORE_PASSWORD"], { env, stdio: ["ignore", "pipe", "pipe"] });
  if (createHash("sha256").update(der).digest("hex") !== certificate(env)) {
    throw new Error("Keystore certificate does not match ANDROID_SIGNING_CERT_SHA256.");
  }
  writeFileSync("apps/mobile/credentials.json", JSON.stringify({ android: { keystore: {
    keystorePath: "../../.android-ci/release.keystore", keystorePassword: env.ANDROID_KEYSTORE_PASSWORD,
    keyAlias: env.ANDROID_KEY_ALIAS, keyPassword: env.ANDROID_KEY_PASSWORD,
  } } }), { mode: 0o600 });
}

export function verifyArm64Elf(elf) {
  if (elf.length < 64 || elf.subarray(0, 4).toString("hex") !== "7f454c46" ||
      elf[4] !== 2 || elf[5] !== 1 || elf.readUInt16LE(18) !== 183) {
    throw new Error("Unexpected arm64 ELF format.");
  }
  const offset = Number(elf.readBigUInt64LE(32));
  const size = elf.readUInt16LE(54);
  const count = elf.readUInt16LE(56);
  if (!Number.isSafeInteger(offset) || size < 56 || !count || offset < 64 ||
      offset + count * size > elf.length) {
    throw new Error("Invalid ELF program headers.");
  }
  let loads = 0;
  for (let index = 0; index < count; index++) {
    const header = offset + index * size;
    if (elf.readUInt32LE(header) === 1) {
      loads++;
      if (elf.readBigUInt64LE(header + 48) < 16384n) {
        throw new Error("Native library lacks 16-KiB ELF page alignment for Pixel devices.");
      }
    }
  }
  if (!loads) throw new Error("ELF contains no loadable segments.");
}

function verifyApk(env) {
  execFileSync(resolve(env.ANDROID_HOME, "build-tools/36.0.0/zipalign"),
    ["-c", "-P", "16", "4", ".android-ci/mint.apk"], { stdio: "pipe" });
  const output = execFileSync(resolve(env.ANDROID_HOME, "build-tools/36.0.0/apksigner"),
    ["verify", "--verbose", "--print-certs", ".android-ci/mint.apk"], { encoding: "utf8" });
  const digests = [...output.matchAll(/Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)/g)];
  if (digests.length !== 1 || digests[0][1].toLowerCase() !== certificate(env)) {
    throw new Error("APK signer differs from the configured stable release certificate.");
  }
  const query = (...args) => execFileSync("apkanalyzer", [...args, ".android-ci/mint.apk"], { encoding: "utf8" }).trim();
  const expectedRuntime = runtimeFromResolution(JSON.parse(readFileSync(".android-ci/runtime.json", "utf8")));
  if (query("manifest", "application-id") !== "org.mintmusic.mobile" ||
      query("manifest", "debuggable") !== "false" ||
      query("resources", "value", "--config", "default", "--type", "string", "--name", "expo_runtime_version") !== "file:fingerprint" ||
      query("files", "cat", "--file", "/assets/fingerprint") !== expectedRuntime) {
    throw new Error("APK package, debug state or actual embedded runtime does not match the gate.");
  }
  verifyManifest(query("manifest", "print"));
  const files = execFileSync("zipinfo", ["-1", ".android-ci/mint.apk"], { encoding: "utf8" }).split("\n");
  const libraries = files.filter(file => /^lib\/.*\.so$/.test(file));
  if (!libraries.length || libraries.some(file => !file.startsWith("lib/arm64-v8a/"))) {
    throw new Error("APK must include native libraries for arm64-v8a only.");
  }
  for (const library of libraries) {
    verifyArm64Elf(execFileSync("unzip", ["-p", ".android-ci/mint.apk", library], { maxBuffer: 256 * 1024 * 1024 }));
  }
}

function main(command) {
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  const runtime = () => runtimeFromResolution(read(".android-ci/runtime.json"));
  if (command === "patch-audio") {
    const require = createRequire(resolve("apps/mobile/package.json"));
    const { patchNativeSources } = require("./src/playback/with-audio-playlist.cjs");
    const root = resolve(require.resolve("expo-audio/package.json"), "..");
    const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
    const modulePath = resolve(root, "android/src/main/java/expo/modules/audio/AudioModule.kt");
    const playlistPath = resolve(root, "android/src/main/java/expo/modules/audio/AudioPlaylist.kt");
    const patched = patchNativeSources({ version, moduleSource: readFileSync(modulePath, "utf8"),
      playlistSource: readFileSync(playlistPath, "utf8") });
    writeFileSync(modulePath, patched.moduleSource);
    writeFileSync(playlistPath, patched.playlistSource);
  } else if (command === "prepare-link") {
    const app = read("apps/mobile/app.json");
    if (app.expo?.extra?.eas?.projectId !== "5a1e1df0-825c-4b34-8f29-21747fb78b97") {
      throw new Error("Refusing to overwrite a different EAS project ID.");
    }
    writeFileSync(".android-ci/app-config-before-init.json", readFileSync("apps/mobile/app.json"));
    writeFileSync(".android-ci/resolved-config-before-init.json", JSON.stringify(resolvedAppConfig("apps/mobile")));
  } else if (command === "validate-link") {
    validateLink(read(".android-ci/resolved-config-before-init.json"), resolvedAppConfig("apps/mobile"),
      read(".android-ci/link.json"));
  } else if (command === "credentials") prepareCredentials(process.env);
  else if (command === "verify-apk") verifyApk(process.env);
  else if (command === "gate") {
    const current = runtime();
    const baseline = process.env.FORCE_REBUILD === "true" ? null : selectBuild(read(".android-ci/builds.json"), current);
    writeFileSync(".android-ci/baseline.json", JSON.stringify(baseline));
    console.log(baseline ? "Verified EAS metadata candidate; APK signer still must be checked." : "No matching finished APK: building conservatively.");
  } else if (command === "build-result") {
    const builds = read(".android-ci/build-result.json");
    const build = selectBuild(builds, runtime());
    if (!build || builds.length !== 1 || build.gitCommitHash !== process.env.GITHUB_SHA) {
      throw new Error("Finished EAS build does not match this commit, production channel, runtime, fingerprint and APK artifact.");
    }
    writeFileSync(".android-ci/baseline.json", JSON.stringify(build));
  } else if (command === "artifact-url") {
    const build = read(".android-ci/baseline.json");
    if (!compatibleBuild(build, runtime())) throw new Error("No compatible EAS APK artifact.");
    console.log(build.artifacts.buildUrl);
  } else throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv[2]);
