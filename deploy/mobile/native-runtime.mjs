import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function nativeLockEntries(lock, sources, projectRoot, repositoryRoot) {
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    throw new Error("Android fingerprint requires npm lockfile v3 with resolved packages.");
  }
  const keys = new Set();
  for (const source of sources) {
    if (!source.filePath) continue;
    const path = relative(repositoryRoot, resolve(projectRoot, source.filePath)).replaceAll("\\", "/");
    const match = path.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/);
    if (match) keys.add(match[1]);
  }
  return [...keys].sort().map((key) => {
    const entry = lock.packages[key];
    if (!entry?.version || (!entry.integrity && !entry.link)) {
      throw new Error(`Unresolved native/plugin lockfile entry: ${key}`);
    }
    return { key, version: entry.version, resolved: entry.resolved, integrity: entry.integrity };
  });
}

export function validateFingerprint(fingerprint) {
  for (const id of ["expoConfig", "expoAutolinkingConfig:android", "rncoreAutolinkingConfig:android"]) {
    if (!fingerprint.sources.some((source) => source.id === id && source.hash)) {
      throw new Error(`Incomplete Android fingerprint: missing ${id}. Refusing to classify as OTA-only.`);
    }
  }
  if (!fingerprint.sources.some((source) => source.reasons.includes("package:react-native") && source.hash)) {
    throw new Error("Incomplete Android fingerprint: missing React Native.");
  }
  for (const source of fingerprint.sources) {
    if (source.hash === null && !(source.filePath === "android" && source.reasons.includes("bareNativeDir"))) {
      throw new Error(`Unhashed native input: ${source.filePath ?? source.id}. Refusing to skip a build.`);
    }
  }
}

export async function createNativeRuntime(repositoryRoot) {
  const projectRoot = resolve(repositoryRoot, "apps/mobile");
  const require = createRequire(resolve(projectRoot, "package.json"));
  const { createFingerprintAsync, SourceSkips } = require("@expo/fingerprint");
  const extraSources = [
    "@react-native/gradle-plugin", "@react-native/codegen", "hermes-compiler",
    "expo-modules-autolinking", "@expo/config-plugins", "@expo/prebuild-config",
  ].map((name) => ({
    type: "dir", filePath: relative(projectRoot, dirname(require.resolve(`${name}/package.json`))),
    reasons: ["mintNativeBuildTooling"],
  }));
  for (const path of ["patches", ".npmrc", "react-native.config.js"]) {
    try {
      await access(resolve(repositoryRoot, path));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    extraSources.push({
      type: path === "patches" ? "dir" : "file", filePath: relative(projectRoot, resolve(repositoryRoot, path)),
      reasons: ["mintNativeBuildTooling"],
    });
  }
  const fingerprint = await createFingerprintAsync(projectRoot, {
    platforms: ["android"],
    preset: "strict",
    sourceSkips: SourceSkips.ExpoConfigVersions | SourceSkips.ExpoConfigRuntimeVersionIfString |
      SourceSkips.AutolinkingConfigPaths | SourceSkips.PackageJsonScriptsAll |
      SourceSkips.EasJson | SourceSkips.Easignore,
    silent: true,
    extraSources,
  });
  validateFingerprint(fingerprint);
  const lock = JSON.parse(await readFile(resolve(repositoryRoot, "package-lock.json"), "utf8"));
  const nativePackages = nativeLockEntries(lock, fingerprint.sources, projectRoot, repositoryRoot);
  const rootPackage = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  const lifecycle = Object.fromEntries(
    ["preinstall", "install", "postinstall", "prepare"].map((name) => [name, rootPackage.scripts?.[name] ?? null]),
  );
  const tooling = {};
  for (const file of [
    ".github/workflows/android-apk.yml",
    "apps/mobile/app.config.js",
    "deploy/mobile/native-runtime.mjs",
    "deploy/mobile/android-build.mjs",
    "deploy/mobile/release-signing.gradle",
  ]) {
    tooling[file] = sha256(await readFile(resolve(repositoryRoot, file)));
  }
  if (process.env.MINT_OTA_CERTIFICATE_PATH) {
    tooling.otaCertificate = sha256(await readFile(resolve(projectRoot, process.env.MINT_OTA_CERTIFICATE_PATH)));
  }
  const policy = {
    schema: 1,
    expoFingerprint: fingerprint.hash,
    fingerprintVersion: require("@expo/fingerprint/package.json").version,
    nativePackages,
    lifecycle,
    overrides: rootPackage.overrides ?? null,
    tooling,
  };
  return { ...policy, runtime: sha256(JSON.stringify(policy)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output) throw new Error("Usage: node deploy/mobile/native-runtime.mjs <output.json>");
  const runtime = await createNativeRuntime(resolve(dirname(new URL(import.meta.url).pathname), "../.."));
  await writeFile(output, `${JSON.stringify(runtime, null, 2)}\n`);
  console.log(`Android native runtime: ${runtime.runtime}`);
}
