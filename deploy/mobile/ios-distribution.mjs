import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compatibleBuild, resolvedAppConfig, runtimeFromResolution, selectBuild, validateLink, validateUpdateRuntime } from "./eas-distribution.mjs";

export const iosTarget = { platform: "IOS", profile: "ios-production" };
const bundleIdentifier = "org.mintmusic.mobile";

export function verifyIosMetadata({ info, updates, fingerprint, manifest, profile, entitlements, certificate }, runtime, team, now = Date.now()) {
  if (!/^[A-Z0-9]{10}$/.test(team ?? "")) throw new Error("Configure IOS_APPLE_TEAM_ID.");
  const identity = `${team}.${bundleIdentifier}`;
  if (info.CFBundleIdentifier !== bundleIdentifier || info.CFBundleSupportedPlatforms?.length !== 1 ||
      info.CFBundleSupportedPlatforms[0] !== "iPhoneOS" || !/^\d+(?:\.\d+)*$/.test(info.CFBundleVersion ?? "") ||
      entitlements["get-task-allow"] !== false ||
      entitlements["com.apple.developer.team-identifier"] !== team ||
      entitlements["application-identifier"] !== identity) {
    throw new Error("IPA must be a release device build with the expected bundle and Apple team.");
  }
  if (updates.EXUpdatesEnabled !== true ||
      updates.EXUpdatesURL !== "https://u.expo.dev/5a1e1df0-825c-4b34-8f29-21747fb78b97" ||
      updates.EXUpdatesRequestHeaders?.["expo-channel-name"] !== "production" ||
      updates.EXUpdatesRuntimeVersion !== "file:fingerprint" || fingerprint !== runtime ||
      ![undefined, true].includes(updates.EXUpdatesHasEmbeddedUpdate) ||
      ![undefined, false].includes(updates.EXUpdatesDisableAntiBrickingMeasures) ||
      ![undefined, "ALWAYS"].includes(updates.EXUpdatesCheckOnLaunch) ||
      ![undefined, 0].includes(updates.EXUpdatesLaunchWaitMs) ||
      !/^[a-f0-9-]{36}$/.test(manifest?.id ?? "") ||
      !Number.isFinite(manifest.commitTime) || !Array.isArray(manifest.assets)) {
    throw new Error("IPA runtime, channel or embedded Expo recovery does not match the production gate.");
  }
  if (profile.TeamIdentifier?.length !== 1 || profile.TeamIdentifier[0] !== team ||
      profile.Entitlements?.["application-identifier"] !== identity ||
      profile.Entitlements?.["com.apple.developer.team-identifier"] !== team ||
      profile.Entitlements?.["get-task-allow"] !== false ||
      profile.ProvisionsAllDevices === true ||
      !Array.isArray(profile.ProvisionedDevices) || profile.ProvisionedDevices.length === 0 ||
      !Number.isFinite(Date.parse(profile.ExpirationDate)) || Date.parse(profile.ExpirationDate) <= now ||
      !Array.isArray(profile.DeveloperCertificates) ||
      !profile.DeveloperCertificates.includes(certificate.der)) {
    throw new Error("IPA has expired or mismatched ad hoc provisioning; rebuild with refreshed credentials/devices.");
  }
  if (certificate.team !== team || !Number.isFinite(Date.parse(certificate.validFrom)) ||
      !Number.isFinite(Date.parse(certificate.validTo)) ||
      Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error("IPA signing certificate is expired or belongs to a different Apple team.");
  }
}

export function readApplePlist(file) {
  // plutil's JSON conversion cannot encode provisioning-profile dates or certificate data.
  const script = `import base64, datetime, json, plistlib, sys
def encode(value):
    if isinstance(value, bytes): return base64.b64encode(value).decode("ascii")
    if isinstance(value, datetime.datetime): return value.isoformat() + ("Z" if value.tzinfo is None else "")
    raise TypeError("Unsupported plist value")
with open(sys.argv[1], "rb") as source:
    print(json.dumps(plistlib.load(source), default=encode))`;
  return JSON.parse(execFileSync("python3", ["-c", script, file], { encoding: "utf8" }));
}

export function verifyIpa(ipa, runtime, team) {
  const directory = mkdtempSync(resolve(".ios-ci/verify-"));
  const run = (tool, args) => execFileSync(tool, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    run("ditto", ["-x", "-k", resolve(ipa), directory]);
    const payload = resolve(directory, "Payload");
    const apps = readdirSync(payload).filter(name => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("IPA must contain exactly one application.");
    const app = resolve(payload, apps[0]);
    run("codesign", ["--verify", "--deep", "--strict", app]);
    const prefix = resolve(directory, "signer-");
    run("codesign", ["-d", "--extract-certificates", prefix, app]);
    const der = readFileSync(`${prefix}0`);
    const cert = new X509Certificate(der);
    const entitlementsPath = resolve(directory, "entitlements.plist");
    writeFileSync(entitlementsPath, run("codesign", ["-d", "--entitlements", ":-", app]));
    const profilePath = resolve(directory, "profile.plist");
    writeFileSync(profilePath, run("security", ["cms", "-D", "-i", resolve(app, "embedded.mobileprovision")]));
    const manifest = JSON.parse(readFileSync(resolve(app, "EXUpdates.bundle/app.manifest"), "utf8"));
    if (!existsSync(resolve(app, "main.jsbundle"))) throw new Error("IPA is missing its embedded JavaScript bundle.");
    verifyIosMetadata({
      info: readApplePlist(resolve(app, "Info.plist")),
      updates: readApplePlist(resolve(app, "Expo.plist")),
      fingerprint: readFileSync(resolve(app, "EXUpdates.bundle/fingerprint"), "utf8"),
      manifest,
      profile: readApplePlist(profilePath),
      entitlements: readApplePlist(entitlementsPath),
      certificate: {
        der: der.toString("base64"), team: cert.subject.match(/(?:^|\n)OU=([A-Z0-9]{10})(?:\n|$)/)?.[1],
        validFrom: cert.validFrom, validTo: cert.validTo,
      },
    }, runtime, team);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function main(command) {
  const read = name => JSON.parse(readFileSync(`.ios-ci/${name}.json`, "utf8"));
  const runtime = () => runtimeFromResolution(read("runtime"));
  if (command === "prepare-link") {
    writeFileSync(".ios-ci/app-config-before-init.json", readFileSync("apps/mobile/app.json"));
    writeFileSync(".ios-ci/resolved-config-before-init.json", JSON.stringify(resolvedAppConfig("apps/mobile")));
  } else if (command === "validate-link") {
    validateLink(read("resolved-config-before-init"), resolvedAppConfig("apps/mobile"), read("link"));
  } else if (command === "gate") {
    const baseline = process.env.FORCE_REBUILD === "true" ? null : selectBuild(read("builds"), runtime(), iosTarget);
    writeFileSync(".ios-ci/baseline.json", JSON.stringify(baseline));
    console.log(baseline ? "Matching finished iOS candidate; signed IPA still must be verified." : "No matching finished IPA; build required.");
  } else if (command === "build-result") {
    const builds = read("build-result");
    const build = selectBuild(builds, runtime(), iosTarget);
    if (!build || builds.length !== 1 || build.gitCommitHash !== process.env.GITHUB_SHA) {
      throw new Error("Finished iOS build does not match this commit, production channel and fingerprint.");
    }
    writeFileSync(".ios-ci/baseline.json", JSON.stringify(build));
  } else if (command === "artifact-url") {
    const build = read("baseline");
    if (!compatibleBuild(build, runtime(), iosTarget)) throw new Error("No compatible finished IPA.");
    console.log(build.artifacts.buildUrl);
  } else if (command === "verify-ipa") {
    verifyIpa(".ios-ci/mint.ipa", runtime(), process.env.IOS_APPLE_TEAM_ID);
  } else if (command === "validate-update-runtime") {
    validateUpdateRuntime(read("runtime"), read("update-runtime"));
  } else throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv[2]);
