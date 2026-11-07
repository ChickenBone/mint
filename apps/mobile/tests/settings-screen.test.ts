import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("app info is the final Settings section and exposes update diagnostics", () => {
  const settings = readFileSync(resolve("src/features/settings/SettingsScreen.tsx"), "utf8");
  const sections = [...settings.matchAll(/<Section title="([^"]+)">/g)].map((match) => match[1]);
  assert.equal(sections[sections.length - 1], "App info");
  assert.match(settings, /Runtime: \{Updates\.runtimeVersion/);
  assert.match(settings, /Channel: \{Updates\.channel/);
  assert.match(settings, /Running update: \{Updates\.updateId/);
  assert.match(settings, /Recovery detail: \{Updates\.emergencyLaunchReason/);
  assert.doesNotMatch(settings, /Constants\.platform\?\.android\?\.versionCode/);
});
