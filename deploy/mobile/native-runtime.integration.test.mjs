import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createNativeRuntime } from "./native-runtime.mjs";

test("actual Expo Android fingerprint distinguishes app JS, native config, icon bytes and resolved lock changes", async t => {
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  await mkdir(resolve(repository, ".android-ci"), { recursive: true });
  const directory = await mkdtemp(resolve(repository, ".android-ci/fingerprint-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of ["package.json", "package-lock.json", ".gitignore", ".github/workflows",
    "apps/mobile", "packages/client", "deploy/mobile"]) {
    await cp(resolve(repository, path), resolve(directory, path), {
      recursive: true,
      filter: (file) => !/(?:\/android|\/ios|\/\.expo|\/node_modules)(?:\/|$)/.test(file.slice(repository.length)),
    });
  }
  // Hard links avoid reinstalling hundreds of packages. This test never writes installed modules.
  execFileSync("cp", ["-al", resolve(repository, "node_modules"), resolve(directory, "node_modules")]);
  const names = ["MINT_OTA_URL", "MINT_OTA_CERTIFICATE_PATH", "MINT_NATIVE_RUNTIME", "MINT_ANDROID_VERSION_CODE"];
  const original = names.map((name) => process.env[name]);
  for (const name of names) delete process.env[name];
  t.after(() => names.forEach((name, index) => {
    if (original[index] === undefined) delete process.env[name];
    else process.env[name] = original[index];
  }));
  const baseline = await createNativeRuntime(directory);
  const jsFile = resolve(directory, "apps/mobile/app/index.tsx");
  await writeFile(jsFile, `${await readFile(jsFile, "utf8")}\n// Isolated OTA-only fixture change.\n`);
  const lockFile = resolve(directory, "package-lock.json");
  const lock = JSON.parse(await readFile(lockFile, "utf8"));
  lock.packages["node_modules/zod"].integrity = "sha512-js-only-fixture";
  await writeFile(lockFile, JSON.stringify(lock));
  process.env.MINT_ANDROID_VERSION_CODE = "99999";
  assert.equal((await createNativeRuntime(directory)).runtime, baseline.runtime);

  lock.packages["node_modules/expo-audio"].integrity = "sha512-native-fixture";
  await writeFile(lockFile, JSON.stringify(lock));
  assert.notEqual((await createNativeRuntime(directory)).runtime, baseline.runtime);

  const appFile = resolve(directory, "apps/mobile/app.json");
  const app = JSON.parse(await readFile(appFile, "utf8"));
  app.expo.android.permissions = ["android.permission.CAMERA"];
  await writeFile(appFile, JSON.stringify(app));
  const native = await createNativeRuntime(directory);
  assert.notEqual(native.runtime, baseline.runtime);
  app.expo.icon = "./fixture-icon.png";
  await writeFile(appFile, JSON.stringify(app));
  const icon = resolve(directory, "apps/mobile/fixture-icon.png");
  await writeFile(icon, "fixture-icon-bytes-one");
  const firstIcon = await createNativeRuntime(directory);
  await writeFile(icon, "fixture-icon-bytes-two");
  assert.notEqual((await createNativeRuntime(directory)).runtime, firstIcon.runtime);
});
