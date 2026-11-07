import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const STATE_ARTIFACT = "mint-android-native-state";
export const APK_ARTIFACT = "mint-android-apk";

export function validateState(state, run, artifacts) {
  if (state.schema !== 1 || !/^[a-f0-9]{64}$/.test(state.runtime) ||
      !/^[a-f0-9]{64}$/.test(state.signingCertificate) ||
      !Number.isInteger(state.versionCode) || state.versionCode < 1 || state.versionCode > 2100000000 ||
      state.commit !== run.head_sha || state.runId !== run.id ||
      !artifacts.some((artifact) => artifact.id === state.apkArtifactId &&
        artifact.name === APK_ARTIFACT && !artifact.expired)) {
    throw new Error(`Invalid distributed Android state in Actions run ${run.id}.`);
  }
  return state;
}

export function buildDecision(current, baseline, force = false) {
  if (!/^[a-f0-9]{64}$/.test(current.runtime)) throw new Error("Invalid current native runtime.");
  if (force) return { build: true, reason: "Manual rebuild requested." };
  if (!baseline) return { build: true, reason: "No retained successful APK baseline; bootstrap conservatively." };
  if (current.runtime !== baseline.runtime) return { build: true, reason: "Native runtime changed since the last successful APK." };
  return { build: false, reason: "Native runtime unchanged; APK build skipped." };
}

export function versionCode(now, previous = 0) {
  // Wall-clock seconds survive workflow recreation and artifact expiry; retries also exceed the known baseline.
  const code = Math.max(Math.floor(now / 1000) - 1735689600, previous + 1);
  if (!Number.isInteger(code) || code < 1 || code > 2100000000) {
    throw new Error("Android versionCode exhausted; choose a documented migration before another build.");
  }

  return code;
}

export function androidToolchain(catalog, properties) {
  const value = (name, override) => {
    const property = properties.match(new RegExp(`^${override}=([\\d.]+)$`, "m"))?.[1];
    const fallback = catalog.match(new RegExp(`^${name} = "([\\d.]+)"$`, "m"))?.[1];
    if (!(property ?? fallback)) throw new Error(`Missing Android toolchain setting ${name}; audit the new SDK.`);
    return property ?? fallback;
  };
  return {
    compileSdk: value("compileSdk", "android.compileSdkVersion"),
    buildTools: value("buildTools", "android.buildToolsVersion"),
    ndk: value("ndkVersion", "android.ndkVersion"),
  };
}

export function verifyNativeUpdates(manifest, strings, env, certificate) {
  const decode = (value) => value.replaceAll("&#xA;", "\n").replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  const metadata = new Map([...manifest.matchAll(/<meta-data android:name="([^"]+)" android:value="([^"]*)"\s*\/>/g)]
    .map((match) => [match[1], decode(match[2])]));
  const prefix = "expo.modules.updates.";
  if (metadata.get(`${prefix}ENABLED`) !== "true" ||
      metadata.get(`${prefix}EXPO_UPDATE_URL`) !== env.MINT_OTA_URL ||
      metadata.get(`${prefix}CODE_SIGNING_CERTIFICATE`)?.trim() !== certificate.trim() ||
      metadata.get(`${prefix}HAS_EMBEDDED_UPDATE`) === "false" ||
      metadata.get(`${prefix}DISABLE_ANTI_BRICKING_MEASURES`) === "true") {
    throw new Error("Generated Android project has missing/unsafe signed OTA configuration.");
  }
  const runtime = strings.match(/<string name="expo_runtime_version">([^<]+)<\/string>/)?.[1];
  if (runtime !== (env.MINT_NATIVE_RUNTIME || "fingerprint-pending")) {
    throw new Error("Generated Android runtime does not match the compatibility gate.");
  }
  const signing = JSON.parse(metadata.get(`${prefix}CODE_SIGNING_METADATA`) ?? "{}");
  const headers = JSON.parse(metadata.get(`${prefix}UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY`) ?? "{}");
  if (signing.keyid !== "main" || signing.alg !== "rsa-v1_5-sha256" ||
      headers["expo-channel-name"] !== (env.MINT_OTA_CHANNEL || "production")) {
    throw new Error("Generated Android OTA signing key/channel differs from publisher.");
  }
}

export async function latestBaseline({ api, repository, branch, token, request = fetch }) {
  async function get(path) {
    const response = await request(`${api}/repos/${repository}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`Actions baseline API failed (${response.status}) at ${path}.`);
    return response;
  }
  for (let page = 1; page <= 10; page++) {
    const { workflow_runs: runs } = await (await get(
      `/actions/workflows/android-apk.yml/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=100&page=${page}`,
    )).json();
    if (!Array.isArray(runs)) throw new Error("Invalid Actions workflow-runs response.");
    for (const run of runs) {
      if (!["push", "workflow_dispatch"].includes(run.event)) continue;
      const { artifacts } = await (await get(`/actions/runs/${run.id}/artifacts?per_page=100`)).json();
      if (!Array.isArray(artifacts)) throw new Error("Invalid Actions artifacts response.");
      const state = artifacts.find((artifact) => artifact.name === STATE_ARTIFACT && !artifact.expired);
      if (!state || !artifacts.some((artifact) => artifact.name === APK_ARTIFACT && !artifact.expired)) continue;
      const { jobs } = await (await get(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).json();
      if (!Array.isArray(jobs)) throw new Error("Invalid Actions jobs response.");
      if (!jobs.some((job) => job.name === "APK" && job.conclusion === "success")) continue;
      const archive = await get(`/actions/artifacts/${state.id}/zip`);
      await mkdir(".android-ci", { recursive: true });
      const zip = resolve(".android-ci/baseline.zip");
      await writeFile(zip, Buffer.from(await archive.arrayBuffer()));
      const content = execFileSync("python3", ["-c",
        "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive:\n info = archive.getinfo('native-state.json')\n if info.file_size > 65536: raise ValueError('Android baseline metadata exceeds budget')\n sys.stdout.buffer.write(archive.read(info))",
        zip,
      ], { encoding: "utf8", maxBuffer: 65536 });
      return validateState(JSON.parse(content), run, artifacts);
    }
    if (runs.length < 100) return null;
  }
  console.warn("No successful APK found within 1,000 completed runs; rebuilding rather than assuming compatibility.");
  return null;
}

export async function prepareSigning(env, directory, baseline) {
  for (const name of [
    "ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD", "ANDROID_SIGNING_CERT_SHA256",
  ]) {
    if (!env[name]) throw new Error(`Missing ${name}; configure stable signing per docs/android-builds.md.`);
  }
  const encoded = env.ANDROID_KEYSTORE_BASE64.replaceAll(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error("ANDROID_KEYSTORE_BASE64 is not valid base64.");
  }
  const certificate = env.ANDROID_SIGNING_CERT_SHA256.replaceAll(":", "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(certificate)) throw new Error("ANDROID_SIGNING_CERT_SHA256 must be the SHA-256 certificate fingerprint.");
  if (baseline && baseline.signingCertificate !== certificate) {
    throw new Error("Signing certificate changed since the distributed APK. Restore the original key to permit upgrades.");
  }
  const keystore = resolve(directory, "mint-release.keystore");
  await writeFile(keystore, Buffer.from(encoded, "base64"), { mode: 0o600 });
  const der = execFileSync("keytool", [
    "-exportcert", "-keystore", keystore, "-alias", env.ANDROID_KEY_ALIAS,
    "-storepass:env", "ANDROID_KEYSTORE_PASSWORD",
  ], { env, stdio: ["ignore", "pipe", "pipe"] });
  if (createHash("sha256").update(der).digest("hex") !== certificate) {
    throw new Error("Keystore certificate does not match ANDROID_SIGNING_CERT_SHA256.");
  }
  return { keystore, certificate };
}

async function main(command) {
  if (command === "gate") {
    const current = JSON.parse(await readFile(".android-ci/runtime.json", "utf8"));
    const baseline = await latestBaseline({
      api: process.env.GITHUB_API_URL, repository: process.env.GITHUB_REPOSITORY,
      branch: process.env.GITHUB_REF_NAME, token: process.env.GH_TOKEN,
    });
    const decision = buildDecision(current, baseline, process.env.FORCE_REBUILD === "true");
    const code = versionCode(Date.now(), baseline?.versionCode);
    await writeFile(".android-ci/baseline.json", JSON.stringify(baseline));
    await appendFile(process.env.GITHUB_OUTPUT, `build=${decision.build}\nruntime=${current.runtime}\nversion_code=${code}\n`);
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### Android compatibility\n${decision.reason}\n\nNative runtime: \`${current.runtime}\`.\n` +
      (baseline ? `Baseline: [successful APK run](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${baseline.runId}).\n` : "") +
      "\nSkipping the APK does not deliver an OTA update unless the publishing job is configured and succeeds.\n");
  } else if (command === "signing") {
    const baseline = JSON.parse(await readFile(".android-ci/baseline.json", "utf8"));
    const signing = await prepareSigning(process.env, process.env.RUNNER_TEMP, baseline);
    await appendFile(process.env.GITHUB_ENV, `MINT_RELEASE_KEYSTORE=${signing.keystore}\n`);
    const gradle = "apps/mobile/android/app/build.gradle";
    const source = await readFile(gradle, "utf8");
    if (!source.includes("signingConfig signingConfigs.debug") || !source.includes('apply plugin: "com.android.application"')) {
      throw new Error("Expo Android release template changed; audit signing integration before distributing.");
    }
    await appendFile(gradle, '\napply from: new File(rootDir, "../../../deploy/mobile/release-signing.gradle")\n');
  } else if (command === "state") {
    const state = {
      schema: 1, runtime: process.env.MINT_NATIVE_RUNTIME,
      versionCode: Number(process.env.MINT_ANDROID_VERSION_CODE),
      commit: process.env.GITHUB_SHA, runId: Number(process.env.GITHUB_RUN_ID),
      apkArtifactId: Number(process.env.APK_ARTIFACT_ID),
      signingCertificate: process.env.ANDROID_SIGNING_CERT_SHA256.replaceAll(":", "").toLowerCase(),
    };
    await writeFile(".android-ci/native-state.json", `${JSON.stringify(state, null, 2)}\n`);
  } else if (command === "toolchain") {
    const require = createRequire(resolve("apps/mobile/package.json"));
    const catalog = await readFile(resolve(require.resolve("react-native/package.json"), "../gradle/libs.versions.toml"), "utf8");
    const properties = await readFile("apps/mobile/android/gradle.properties", "utf8");
    const toolchain = androidToolchain(catalog, properties);
    await appendFile(process.env.GITHUB_OUTPUT, `compile_sdk=${toolchain.compileSdk}\nbuild_tools=${toolchain.buildTools}\nndk=${toolchain.ndk}\n`);
  } else if (command === "verify-native") {
    verifyNativeUpdates(
      await readFile("apps/mobile/android/app/src/main/AndroidManifest.xml", "utf8"),
      await readFile("apps/mobile/android/app/src/main/res/values/strings.xml", "utf8"),
      process.env,
      await readFile(resolve("apps/mobile", process.env.MINT_OTA_CERTIFICATE_PATH), "utf8"),
    );
    console.log("Verified generated Android signed OTA configuration, channel and native runtime.");
  } else if (command === "verify-apk") {
    const apk = "apps/mobile/android/app/build/outputs/apk/release/app-release.apk";
    const tools = resolve(process.env.ANDROID_HOME, "build-tools", process.env.ANDROID_BUILD_TOOLS);
    execFileSync(resolve(tools, "zipalign"), ["-c", "-P", "16", "4", apk], { stdio: "pipe" });
    const signature = execFileSync(resolve(tools, "apksigner"), ["verify", "--verbose", "--print-certs", apk], { encoding: "utf8" });
    const actualCertificate = signature.match(/Signer #1 certificate SHA-256 digest: ([a-f0-9]+)/)?.[1];
    const expectedCertificate = process.env.ANDROID_SIGNING_CERT_SHA256.replaceAll(":", "").toLowerCase();
    if (actualCertificate !== expectedCertificate || signature.includes("Signer #2 certificate")) {
      throw new Error("Built APK signer does not match the pinned stable release certificate.");
    }
    const badging = execFileSync(resolve(tools, "aapt"), ["dump", "badging", apk], { encoding: "utf8" });
    if (!badging.includes(`versionCode='${process.env.MINT_ANDROID_VERSION_CODE}'`) || badging.includes("application-debuggable")) {
      throw new Error("Built APK is debuggable or its versionCode does not match CI.");
    }
    const files = execFileSync("zipinfo", ["-1", apk], { encoding: "utf8" }).split("\n");
    const libraries = files.filter((file) => /^lib\/.*\.so$/.test(file));
    if (!libraries.length || libraries.some((file) => !file.startsWith("lib/arm64-v8a/"))) {
      throw new Error("APK must include native libraries for arm64-v8a only.");
    }
    for (const library of libraries) {
      const elf = execFileSync("unzip", ["-p", apk, library], { maxBuffer: 256 * 1024 * 1024 });
      if (elf.subarray(0, 4).toString("hex") !== "7f454c46" || elf[4] !== 2 || elf[5] !== 1) {
        throw new Error(`Unexpected arm64 ELF format: ${library}.`);
      }
      const offset = Number(elf.readBigUInt64LE(32));
      const size = elf.readUInt16LE(54);
      const count = elf.readUInt16LE(56);
      for (let index = 0; index < count; index++) {
        const header = offset + index * size;
        if (elf.readUInt32LE(header) === 1 && elf.readBigUInt64LE(header + 48) < 16384n) {
          throw new Error(`Native library lacks 16-KiB ELF page alignment for Pixel devices: ${library}.`);
        }
      }
    }
    const bytes = await readFile(apk);
    await writeFile(`${apk}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}  app-release.apk\n`);
    console.log("Verified stable APK signer, release versionCode, arm64-only libraries and 16-KiB ZIP/ELF alignment.");
  } else {
    throw new Error("Usage: node deploy/mobile/android-build.mjs <gate|signing|state|toolchain|verify-native|verify-apk>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv[2]);
