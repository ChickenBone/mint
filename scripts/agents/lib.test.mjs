import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  GEN_END,
  GEN_START,
  applyToSafe,
  compileManifest,
  contextPathAllowed,
  exportedNames,
  importSpecifiers,
  memoryScope,
  replaceBlock,
  resolveImport,
  resolveOwnership,
  routeQuery,
  routingPlan,
  specificity,
  globToRegExp,
} from "./lib.mjs";

const manifest = (domains, ignore = []) => compileManifest({ ignore, domains });

test("globToRegExp handles globstars, stars, braces and literal route folders", () => {
  assert.ok(globToRegExp("apps/web/**").test("apps/web/src/a.ts"));
  assert.ok(globToRegExp("**/x.ts").test("x.ts"));
  assert.ok(globToRegExp("**/x.ts").test("a/b/x.ts"));
  assert.ok(globToRegExp("lib/chart*.ts").test("lib/chart-cache.ts"));
  assert.ok(!globToRegExp("lib/*.ts").test("lib/a/b.ts"));
  assert.ok(globToRegExp("a.{ts,tsx}").test("a.tsx"));
  assert.ok(globToRegExp("app/(public)/browse/**").test("app/(public)/browse/page.tsx"));
  assert.ok(globToRegExp("api/[id]/route.ts").test("api/[id]/route.ts"));
  assert.ok(!globToRegExp("api/[id]/route.ts").test("api/i/route.ts"));
});

test("specificity prefers exact paths, then longer literals", () => {
  assert.ok(specificity("apps/web/src/lib/x.ts") > specificity("apps/web/src/lib/*.ts"));
  assert.ok(specificity("apps/web/src/lib/*.ts") > specificity("apps/web/**"));
});

test("resolveOwnership picks the most specific domain and reports gaps", () => {
  const m = manifest(
    [
      { id: "shell", paths: ["apps/web/**"] },
      { id: "play", paths: ["apps/web/src/lib/player*.ts", "apps/web/src/lib/shared.ts"] },
      { id: "other", paths: ["apps/web/src/lib/shared.ts"] },
    ],
    ["**/*.tsbuildinfo"],
  );
  const res = resolveOwnership(m, ["apps/web/src/lib/player.ts", "apps/web/src/app/page.tsx", "apps/web/src/lib/shared.ts", "README.md", "apps/web/tsconfig.tsbuildinfo"]);
  assert.equal(res.owners.get("apps/web/src/lib/player.ts"), "play");
  assert.equal(res.owners.get("apps/web/src/app/page.tsx"), "shell");
  assert.deepEqual(res.unowned, ["README.md"]);
  assert.deepEqual(res.ambiguous, [{ file: "apps/web/src/lib/shared.ts", domains: ["play", "other"] }]);
  assert.ok(!res.owners.has("apps/web/tsconfig.tsbuildinfo"));
});

test("compileManifest rejects duplicate or invalid ids", () => {
  assert.throws(() => manifest([{ id: "a", paths: [] }, { id: "a", paths: [] }]), /Duplicate/);
  assert.throws(() => manifest([{ id: "Bad Id", paths: [] }]), /Invalid/);
  assert.throws(() => manifest([{ id: "a", paths: [], surface: "unknown" }]), /Invalid surface/);
  assert.throws(() => manifest([{ id: "a", paths: [], surface: "server", consumer: true }]), /Invalid consumer/);
});

test("surface-aware routing defaults matching consumer features, not foundation or backend", () => {
  const m = manifest([
    { id: "mobile", surface: "mobile", keywords: ["mobile auth", "expo config"], paths: ["apps/mobile/**"] },
    { id: "mobile-home", surface: "mobile", consumer: true, keywords: ["home", "cards"], paths: ["apps/mobile/src/features/home/**"] },
    { id: "mobile-search", surface: "mobile", consumer: true, keywords: ["search"], paths: ["apps/mobile/src/features/search/**"] },
    { id: "mobile-playback", surface: "mobile", keywords: ["native playback", "playback engine"], paths: ["apps/mobile/src/playback/**"] },
    { id: "library", surface: "server", keywords: ["search", "catalog"], paths: ["apps/web/catalog/**"] },
    { id: "playback", surface: "server", keywords: ["playback", "player"], paths: ["apps/web/playback/**"] },
  ]);
  const plan = (...args) => routingPlan(m, new Map(), args).domains.map((d) => d.id);
  assert.deepEqual(plan("make Home cards smaller"), ["mobile-home"]);
  assert.deepEqual(plan("improve search"), ["mobile-search"]);
  for (const surface of ["Android", "iOS", "Expo", "mobile", "native"]) assert.deepEqual(plan(`improve ${surface} search`), ["mobile-search"]);
  for (const surface of ["browser", "web", "Next.js", "server", "backend", "API"]) assert.deepEqual(plan(`improve ${surface} search`), ["library"]);
  assert.deepEqual(plan("fix native playback engine"), ["mobile-playback"]);
  assert.deepEqual(plan("fix browser playback engine"), ["playback"]);
  assert.deepEqual(plan("fix mobile auth"), ["mobile"]);
  assert.deepEqual(new Set(plan("improve search", "apps/web/catalog/new.ts")), new Set(["mobile-search", "library"]));
  assert.deepEqual(new Set(plan("improve web search", "apps/mobile/src/features/search/new.ts")), new Set(["mobile-search", "library"]));
});

test("importSpecifiers finds static, type, re-export, side-effect and dynamic imports", () => {
  // Built from parts so the repository's own import scanner does not see a real cross-domain edge here.
  const im = "import";
  const src = `${im} a from "./a";\n${im} type { B } from '@/lib/b';\nexport * from "./c";\n${im} "./d.css";\nconst e = await ${im}("@mint/core/db");\n${im} {\n  f,\n} from "./f";`;
  assert.deepEqual(importSpecifiers(src).sort(), ["./a", "./c", "./d.css", "./f", "@/lib/b", "@mint/core/db"].sort());
});

test("resolveImport resolves relative, alias and workspace subpath exports", () => {
  const files = new Set(["apps/web/src/lib/b.ts", "apps/web/src/components/x/index.tsx", "packages/core/src/db/index.ts", "packages/core/src/index.ts", "apps/worker/src/a.ts"]);
  const ws = [
    { dir: "apps/web", name: "@mint/web", exports: {} },
    { dir: "apps/worker", name: "@mint/worker", exports: {} },
    { dir: "packages/core", name: "@mint/core", exports: { ".": "./src/index.ts", "./db": "./src/db/index.ts" } },
  ];
  assert.equal(resolveImport("@/lib/b", "apps/web/src/app/page.tsx", files, ws), "apps/web/src/lib/b.ts");
  assert.equal(resolveImport("../components/x", "apps/web/src/lib/b.ts", files, ws), "apps/web/src/components/x/index.tsx");
  assert.equal(resolveImport("@mint/core/db", "apps/web/src/lib/b.ts", files, ws), "packages/core/src/db/index.ts");
  assert.equal(resolveImport("@mint/core", "apps/web/src/lib/b.ts", files, ws), "packages/core/src/index.ts");
  assert.equal(resolveImport("./a.js", "apps/worker/src/index.ts", files, ws), "apps/worker/src/a.ts");
  assert.equal(resolveImport("react", "apps/web/src/lib/b.ts", files, ws), null);
});

test("exportedNames lists declarations and anonymous defaults", () => {
  const src = "export async function a() {}\nexport const b = 1;\nexport type C = 1;\nexport default { d: 1 };";
  assert.deepEqual(exportedNames(src), ["a", "b", "C", "default"]);
  assert.deepEqual(exportedNames("export default function Page() {}"), ["Page"]);
});

test("routeQuery ranks by paths, keywords and file names", () => {
  const m = manifest([
    { id: "playback", keywords: ["queue", "shuffle"], paths: ["web/player*.ts"] },
    { id: "charts", keywords: ["chart", "provider"], paths: ["web/chart*.ts"] },
  ]);
  const owners = new Map([
    ["web/player.ts", "playback"],
    ["web/chart-service.ts", "charts"],
  ]);
  assert.equal(routeQuery(m, owners, ["shuffle the queue"])[0].id, "playback");
  assert.equal(routeQuery(m, owners, ["add a chart provider"])[0].id, "charts");
  assert.equal(routeQuery(m, owners, ["web/chart-service.ts"])[0].id, "charts");
  assert.equal(routeQuery(m, owners, ["web/chart-new.ts"])[0].id, "charts");
  assert.deepEqual(routeQuery(m, owners, ["unrelated words"]), []);
});

test("routingPlan preserves explicit paths, deduplicates guidance and adapts to new domains", () => {
  const m = compileManifest({
    alwaysRead: ["agents/engineering.md"],
    domains: [
      { id: "music", paths: ["music/**"], keywords: ["music", "queue", "shuffle", "audio"], guides: ["agents/engineering.md", "docs/music.md"] },
      { id: "future", paths: ["future/**"], keywords: [], guides: ["docs/future.md"] },
    ],
  });
  const plan = routingPlan(m, new Map([["music/player.ts", "music"], ["future/a.ts", "future"]]), ["music queue shuffle audio", "future/a.ts"]);
  assert.deepEqual(new Set(plan.domains.map((d) => d.id)), new Set(["music", "future"]));
  assert.equal(plan.read.filter((p) => p === "agents/engineering.md").length, 1);
  assert.ok(plan.read.includes("docs/future.md"));
  assert.equal(plan.multiDomain, true);
  assert.deepEqual(routingPlan(m, new Map(), ["unrelated"]).read, ["agents/engineering.md"]);
});

test("routingPlan never drops a low-scoring explicit owner", () => {
  const domains = Array.from({ length: 6 }, (_, i) => ({ id: `area-${i}`, paths: [`area-${i}/**`], keywords: [`topic-${i}`] }));
  const m = compileManifest({ domains });
  const plan = routingPlan(m, new Map(), ["topic-0 topic-1 topic-2 topic-3 topic-4", "area-5/new.ts"]);
  assert.ok(plan.domains.some((d) => d.id === "area-5"));
  assert.ok(plan.domains.length <= 5);
});

test("contextPathAllowed excludes secrets, local artifacts and escaping paths", () => {
  for (const file of [".agent-memory", ".agent-memory/library/task/NOTES.md", "apps/.AGENT-MEMORY/notes.ts", ".env", "apps/web/.env.local", "data/library.json", "private/a.ts", ".copilot/session.json", ".ssh/id_rsa", "keys/release.pem", "keys/release.KEY", "mint.keystore", "credentials.json", "operator-credentials.json", "run.log", "library.sqlite", "package-lock.json", "../README.md", "/etc/passwd", "apps\\secret", "a\nb"]) {
    assert.equal(contextPathAllowed(file), false, file);
  }
  for (const file of ["README.md", ".env.example", "apps/web/.env.production.example", "apps/mobile/app/browse/[facet].tsx", "future/feature.ts"]) {
    assert.equal(contextPathAllowed(file), true, file);
  }
});

test("memoryScope accepts known domains and bounded safe task labels only", () => {
  const m = manifest([{ id: "library", paths: [] }]);
  assert.equal(memoryScope(m, "library", "search-a1"), ".agent-memory/library/search-a1");
  assert.equal(memoryScope(m, "library", "x"), ".agent-memory/library/x");
  assert.equal(memoryScope(m, "library", "a".repeat(64)), `.agent-memory/library/${"a".repeat(64)}`);
  assert.throws(() => memoryScope(m, "../library", "task"), /unknown domain/);
  for (const task of ["", "..", "../outside", "/outside", "a/b", "a\\b", "a\nb", "a\0b", "-a", "a-", "Upper", "a".repeat(65), "$(touch unsafe)", undefined]) {
    assert.throws(() => memoryScope(m, "library", task), /task-id/);
  }
});

function fixtureCheckout(t) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = path.join(root, ".agent-memory", `.test-${randomUUID()}`);
  mkdirSync(path.join(directory, "scripts/agents"), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ["cli.mjs", "lib.mjs"]) copyFileSync(path.join(root, "scripts/agents", name), path.join(directory, "scripts/agents", name));
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), content);
  };
  write(".gitignore", "/.agent-memory/\n");
  write("package.json", '{"workspaces": []}\n');
  write("AGENTS.md", `${GEN_START}\n${GEN_END}\n`);
  write("agents/engineering.md", "# Engineering\n");
  write("agents/working-at-scale.md", "# Working at scale\n");
  for (const id of ["handbook", "library"]) write(`agents/domains/${id}.md`, `# ${id}\n\n${GEN_START}\n${GEN_END}\n`);
  write("agents/domains.json", JSON.stringify({
    alwaysRead: ["agents/engineering.md"],
    domains: [
      { id: "handbook", title: "Handbook", summary: "Agent tooling", paths: ["scripts/**", "agents/**", ".github/**", "AGENTS.md", ".gitignore", "package.json"], keywords: ["tooling"] },
      { id: "library", title: "Library", summary: "Catalog", paths: ["web/**"], keywords: ["catalog"] },
    ],
  }));
  write("web/catalog.ts", "export const catalog = 1;\n");
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const run = (...args) => execFileSync(process.execPath, [path.join(directory, "scripts/agents/cli.mjs"), ...args], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  run("sync");
  git("add", ".");
  git("-c", "user.name=Agent fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture");
  return { directory, write, git, run };
}

test("memory CLI creates isolated ignored templates without overwriting or publishing notes", (t) => {
  const { directory, git, run } = fixtureCheckout(t);
  const command = (...args) => JSON.parse(run("memory", ...args, "--json"));
  assert.throws(() => command("path", "library", "task-a1"), /scope does not exist/);
  const first = command("init", "library", "task-a1");
  assert.deepEqual(first, { domain: "library", task: "task-a1", path: ".agent-memory/library/task-a1", files: ["README.md", "NOTES.md", "HANDOFF.md"], created: ["README.md", "NOTES.md", "HANDOFF.md"], ignored: true });
  const notes = path.join(directory, first.path, "NOTES.md");
  writeFileSync(notes, "Private sentinel: do not publish\n");
  assert.deepEqual(command("init", "library", "task-a1").created, []);
  assert.equal(readFileSync(notes, "utf8"), "Private sentinel: do not publish\n");
  assert.equal(command("path", "library", "task-a1").path, first.path);
  assert.equal(command("init", "library", "task-b2").created.length, 3);
  assert.match(readFileSync(path.join(directory, first.path, "HANDOFF.md"), "utf8"), /Validation: not run/);
  assert.equal(git("status", "--porcelain"), "");
  for (const args of [["init", "unknown", "task"], ["init", "../library", "task"], ["init", "library", "../outside"], ["init", "library", directory], ["init", "library", "a\\b"], ["init", "library", "task", "extra"]]) {
    assert.throws(() => command(...args), /memory|usage/);
  }
  const packet = run("context", "tooling", `${first.path}/NOTES.md`, "--json");
  assert.ok(!packet.includes("Private sentinel"));
  assert.ok(!packet.includes("task-a1"));
  assert.ok(JSON.parse(packet).notes.some((note) => note.includes("memory init")));
  run("check");
});

test("memory CLI rejects symlink directories, dangling links, linked notes and disabled ignores", (t) => {
  const { directory, run, write } = fixtureCheckout(t);
  const root = path.join(directory, ".agent-memory");
  mkdirSync(path.join(directory, "outside"));
  symlinkSync(path.join(directory, "outside"), root);
  assert.throws(() => run("memory", "init", "library", "task"), /unsafe entry/);
  assert.deepEqual(readFileSync(path.join(directory, ".gitignore"), "utf8"), "/.agent-memory/\n");
  rmSync(root);
  mkdirSync(root);
  symlinkSync(path.join(directory, "missing"), path.join(root, "library"));
  assert.throws(() => run("memory", "init", "library", "task"), /unsafe entry/);
  rmSync(path.join(root, "library"));
  mkdirSync(path.join(root, "library"));
  symlinkSync(path.join(directory, "outside"), path.join(root, "library", "task"));
  assert.throws(() => run("memory", "init", "library", "task"), /unsafe entry/);
  assert.throws(() => run("memory", "path", "library", "task"), /unsafe entry/);
  rmSync(path.join(root, "library", "task"));
  mkdirSync(path.join(root, "library", "task"));
  symlinkSync(path.join(directory, "missing"), path.join(root, "library", "task", "NOTES.md"));
  assert.throws(() => run("memory", "init", "library", "task"), /unsafe entry/);
  assert.ok(!existsSync(path.join(root, "library", "task", "README.md")));
  rmSync(root, { recursive: true });
  write(".gitignore", "");
  assert.throws(() => run("memory", "init", "library", "task"), /Git-ignored/);
  assert.ok(!existsSync(root));
});

test("simultaneous initialization uses exclusive creation and preserves a shared task's existing notes", async (t) => {
  const { directory, run } = fixtureCheckout(t);
  const execute = promisify(execFile);
  const results = await Promise.all(Array.from({ length: 2 }, () => execute(process.execPath, [
    path.join(directory, "scripts/agents/cli.mjs"), "memory", "init", "library", "shared-task", "--json",
  ], { cwd: directory, encoding: "utf8" })));
  assert.deepEqual(results.flatMap(({ stdout }) => JSON.parse(stdout).created).sort(), ["HANDOFF.md", "NOTES.md", "README.md"]);
  assert.deepEqual(JSON.parse(run("memory", "init", "library", "shared-task", "--json")).created, []);
});

test("affected combines consumer file lint selectors but keeps foundation lint broad", (t) => {
  const { directory, run, write, git } = fixtureCheckout(t);
  const data = JSON.parse(readFileSync(path.join(directory, "agents/domains.json"), "utf8"));
  data.domains.push(
    { id: "mobile", title: "Foundation", summary: "Shared mobile shell", surface: "mobile", paths: ["apps/mobile/**"] },
    { id: "mobile-home", title: "Home", summary: "Home presentation", surface: "mobile", consumer: true, keywords: ["home"], paths: ["apps/mobile/src/features/home/**", "apps/mobile/app/home/**", "apps/mobile/tests/home-model.test.ts"] },
  );
  write("agents/domains.json", JSON.stringify(data));
  write("package.json", '{"workspaces": ["apps/*"]}\n');
  write("apps/mobile/package.json", JSON.stringify({ name: "@mint/mobile", scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "tsx --test tests/*.test.ts" } }));
  write("apps/mobile/src/shell.ts", "export const shell = 1;\n");
  write("apps/mobile/src/features/home/HomeScreen.tsx", "export const home = 1;\n");
  write("apps/mobile/app/home/[id].tsx", "export const route = 1;\n");
  write("apps/mobile/tests/home-model.test.ts", "// Fixture\n");
  for (const id of ["mobile", "mobile-home"]) write(`agents/domains/${id}.md`, `# ${id}\n\n${GEN_START}\n${GEN_END}\n`);
  run("sync");
  git("add", ".");
  git("-c", "user.name=Agent fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Mobile fixture");
  write("apps/mobile/src/features/home/HomeScreen.tsx", "export const home = 2;\n");
  write("apps/mobile/app/home/[id].tsx", "export const route = 2;\n");
  const affected = JSON.parse(run("affected", "--json"));
  assert.deepEqual(affected.domains, ["mobile-home"]);
  assert.ok(affected.commands.includes("npm run typecheck -w @mint/mobile"));
  assert.ok(affected.commands.includes("npm exec -w @mint/mobile -- eslint 'app/home/[id].tsx' src/features/home/HomeScreen.tsx tests/home-model.test.ts"));
  assert.ok(affected.commands.includes("npm exec -w @mint/mobile -- tsx --test tests/home-model.test.ts"));
  assert.ok(!affected.commands.includes("npm run lint -w @mint/mobile"));
  write("apps/mobile/src/shell.ts", "export const shell = 2;\n");
  const foundation = JSON.parse(run("affected", "--json"));
  assert.ok(foundation.commands.includes("npm run lint -w @mint/mobile"));
  assert.ok(!foundation.commands.some((command) => command.startsWith("npm exec -w @mint/mobile -- eslint ")));
});

test("force-tracked memory stays out of public context, maps, graph and checks", (t) => {
  const { directory, run, git, write } = fixtureCheckout(t);
  run("memory", "init", "library", "task");
  write(".agent-memory/library/task/private.ts", 'export const PRIVATE_SENTINEL = 1;\n');
  write("web/catalog.ts", 'export { PRIVATE_SENTINEL } from "../.agent-memory/library/task/private.js";\n');
  git("add", "-f", ".agent-memory/library/task/private.ts");
  for (const operation of ["init", "path"]) assert.throws(() => run("memory", operation, "library", "task"), /tracked local memory/);
  const context = run("context", "catalog", ".agent-memory/library/task/private.ts", "--json");
  assert.ok(!context.includes("PRIVATE_SENTINEL"));
  assert.ok(!context.includes("private.ts"));
  assert.deepEqual(JSON.parse(context).domains[0].contracts, []);
  assert.equal(JSON.parse(context).git.changedFiles, 1);
  const map = run("map", "library");
  assert.ok(!map.includes("PRIVATE_SENTINEL"));
  assert.ok(!map.includes("private.ts"));
  assert.ok(!run("map", "handbook").includes("private.ts"));
  const check = run("check");
  assert.ok(check.includes("agents:check ok"));
  assert.ok(!check.includes("private.ts"));
  const affected = run("affected", "--json");
  assert.ok(!affected.includes("private.ts"));
  assert.equal(JSON.parse(affected).changed, 1);
  // A public-looking symlink must not expose memory through source/export scans.
  symlinkSync(path.join(directory, ".agent-memory/library/task/private.ts"), path.join(directory, "web", "linked.ts"));
  assert.ok(!run("map", "library").includes("PRIVATE_SENTINEL"));
  assert.ok(!run("context", "catalog", "web/linked.ts", "--json").includes("linked.ts"));
});

test("context CLI emits bounded metadata and excludes supplied private paths", () => {
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [cli, "context", ...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const raw = run("context tooling", "scripts/agents/lib.mjs", ".env", "../private-secret", "/etc/passwd");
  const packet = JSON.parse(raw);
  const currentManifest = compileManifest(JSON.parse(readFileSync(new URL("../../agents/domains.json", import.meta.url), "utf8")));
  const toolingOwner = resolveOwnership(currentManifest, ["scripts/agents/lib.mjs"]).owners.get("scripts/agents/lib.mjs");
  assert.ok(packet.alwaysRead.includes("agents/engineering.md"));
  assert.ok(packet.domains.some((d) => d.id === toolingOwner));
  assert.ok(packet.domains.every((d) => d.contracts.length <= 12 && Array.isArray(d.validation.cmds)));
  assert.equal(typeof packet.git.changedFiles, "number");
  for (const secret of [".env", "private-secret", "/etc/passwd", "export function routingPlan"]) assert.ok(!raw.includes(secret));
  const unmatched = JSON.parse(run("unrelated qzxvbn"));
  assert.equal(unmatched.domains.length, 0);
  assert.ok(unmatched.notes.some((note) => note.includes("No confident match")));
  assert.throws(() => run(), /usage/);
  const markdown = execFileSync(process.execPath, [cli, "context", "context tooling", "scripts/agents/lib.mjs"], { encoding: "utf8" });
  assert.ok(markdown.startsWith("# Focused repository context"));
  assert.ok(markdown.includes(`## ${toolingOwner}`));
  assert.ok(markdown.includes("npm run test:agents"));
});

test("live feature routing and ownership keep consumer context separate from setup and server work", () => {
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const features = [
    ["mobile-home", "home", "HomeScreen", "apps/mobile/app/index.tsx", "home-model.test.ts", "make Home cards smaller"],
    ["mobile-artists", "artists", "ArtistScreen", "apps/mobile/app/artist/[id].tsx", "artists-detail.test.ts", "improve mobile artists"],
    ["mobile-albums", "albums", "AlbumScreen", "apps/mobile/app/album/[id].tsx", "albums-detail.test.ts", "improve albums"],
    ["mobile-playlists", "playlists", "PlaylistScreen", "apps/mobile/app/collection/[id].tsx", "playlists-detail.test.ts", "edit playlists"],
    ["mobile-search", "search", "SearchScreen", "apps/mobile/app/search.tsx", "search-model.test.ts", "improve search"],
    ["mobile-your-music", "your-music", "LibraryScreen", "apps/mobile/app/library.tsx", "your-music-model.test.ts", "improve Your Library"],
    ["mobile-settings", "settings", "SettingsScreen", "apps/mobile/app/settings.tsx", "settings-screen.test.ts", "improve settings"],
    ["mobile-player", "player", "PlayerScreen", "apps/mobile/app/player.tsx", "player-presentation.test.ts", "improve player sheet"],
  ];
  const owned = features.flatMap(([id, folder, screen, route, testFile]) => [
    [`apps/mobile/src/features/${folder}/${screen}.tsx`, id],
    [route, id],
    [`apps/mobile/tests/${testFile}`, id],
  ]);
  owned.push(
    ["apps/mobile/src/playback/diagnostics.ts", "mobile-playback"],
    ["apps/mobile/src/playback/diagnostics-preference.ts", "mobile-playback"],
    ["apps/mobile/src/playback/analysis-request.ts", "mobile-playback"],
    ["apps/mobile/tests/playback-diagnostics.test.ts", "mobile-playback"],
    ["apps/mobile/src/features/player/StatsForNerds.tsx", "mobile-player"],
    ["apps/mobile/src/features/player/useSeekPreview.ts", "mobile-player"],
    ["apps/mobile/tests/player-gesture.test.ts", "mobile-player"],
    ["apps/mobile/src/hooks/song-likes.ts", "mobile"],
    ["apps/mobile/src/hooks/useSongLike.ts", "mobile"],
    ["apps/mobile/tests/song-likes.test.ts", "mobile"],
    ["apps/mobile/tests/settings-diagnostics.test.ts", "mobile-settings"],
    ["packages/client/src/analysis.ts", "mobile-contracts"],
    ["packages/client/tests/analysis.test.ts", "mobile-contracts"],
    ["packages/core/src/public-cache.ts", "platform"],
    ["packages/core/src/public-cache-fixture.ts", "platform"],
    ["packages/core/src/public-cache.test.ts", "platform"],
    ["apps/worker/src/services/public-metadata.ts", "library"],
    ["apps/worker/src/services/public-metadata.test.ts", "library"],
  );
  const owners = run("owner", ...owned.map(([file]) => file));
  for (const [file, id] of owned) assert.equal(owners[file], id, file);
  assert.deepEqual(run("context", "shared cache plumbing", "packages/core/src/public-cache.ts").domains.map((d) => d.id), ["platform"]);
  for (const [id, , , , , query] of features) {
    const packet = run("context", query);
    assert.deepEqual(packet.domains.map((d) => d.id), [id], query);
    assert.ok(!packet.read.includes("docs/mobile.md"), query);
    assert.ok(!packet.read.includes("docs/mobile-playback.md"), query);
    assert.ok(!packet.read.includes("agents/playback-and-library.md"), query);
    assert.ok(!packet.read.includes("agents/architecture.md"), query);
    assert.ok(!packet.read.some((file) => file.startsWith(".github/skills/")), query);
    assert.ok(!packet.read.includes("agents/domains/mobile-design.md"), query);
    assert.ok(packet.domains[0].validation.cmds.some((command) => command.startsWith("npm exec -w @mint/mobile -- eslint ")), query);
    assert.ok(!packet.domains[0].validation.cmds.includes("npm run lint -w @mint/mobile"), query);
  }
  for (const [query, expected] of [
    ["improve mobile library", "mobile-your-music"],
    ["fix mobile auth", "mobile"],
    ["fix native API", "mobile-contracts"],
    ["fix native playback engine", "mobile-playback"],
    ["fix mobile playback", "mobile-playback"],
    ["fix mobile offline", "mobile-playback"],
    ["developer options", "mobile-settings"],
    ["stats for nerds", "mobile-player"],
    ["native playback diagnostics", "mobile-playback"],
  ]) assert.deepEqual(run("route", query).domains.map((d) => d.id), [expected], query);
  for (const query of ["improve browser search", "improve backend artist metadata", "improve web settings", "fix browser playback engine"]) {
    const result = run("route", query);
    assert.ok(result.domains.length, query);
    assert.ok(result.domains.every((d) => !d.id.startsWith("mobile")), query);
  }
  for (const future of ["Jams", "Events", "Profiles"]) {
    assert.deepEqual(run("route", `native ${future} extension seam`).domains.map((d) => d.id), ["agent-tooling"]);
  }
  assert.ok(run("context", "fix mobile auth").domains[0].validation.cmds.includes("npm run lint -w @mint/mobile"));
});

test("portable mobile skill ownership and design packets stay precise and reference-only", () => {
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const skills = [
    ".github/skills/mint-mobile-ux/SKILL.md",
    ".github/skills/mint-mobile-ux/references/flow-checklist.md",
    ".github/skills/mint-mobile-ux/references/gestures-motion.md",
    ".github/skills/mint-mobile-ux/references/device-acceptance.md",
    ".github/skills/expo-native-ui/SKILL.md",
    ".github/skills/expo-native-ui/LICENSE",
    ".github/skills/expo-native-ui/references/controls.md",
    ".github/skills/expo-animation/SKILL.md",
    ".github/skills/expo-animation/RECIPES.md",
    ".github/skills/expo-animation/LICENSE",
  ];
  const owners = run("owner", ...skills);
  for (const file of skills) {
    assert.ok(existsSync(new URL(`../../${file}`, import.meta.url)), file);
    assert.equal(owners[file], "mobile-design", file);
  }
  for (const query of ["improve native UX tap response", "review mobile design", "improve native animation swipe gestures", "mobile performance high fps"]) {
    const packet = run("context", query);
    assert.deepEqual(packet.domains.map((d) => d.id), ["mobile-design"], query);
    assert.deepEqual(packet.read, [
      "agents/product-decisions.md",
      "agents/engineering.md",
      "agents/domains/mobile-design.md",
    ], query);
    assert.ok(!packet.read.some((file) => file.startsWith(".github/skills/")), query);
    assert.ok(!packet.domains[0].validation.cmds.some((command) => command.includes("@mint/mobile")), query);
  }
  for (const file of [skills[0], skills[4], skills[8]]) {
    const packet = run("context", "inspect this guidance", file);
    assert.deepEqual(packet.domains.map((d) => d.id), ["mobile-design"], file);
    assert.ok(!packet.read.some((entry) => entry.startsWith(".github/skills/")), file);
    assert.deepEqual(packet.domains[0].contracts, [], file);
  }
  const crossDomain = run("context", "improve mobile artists", skills[0]);
  assert.deepEqual(new Set(crossDomain.domains.map((d) => d.id)), new Set(["mobile-artists", "mobile-design"]));
  assert.ok(!crossDomain.read.some((file) => file.startsWith(".github/skills/")));
  const guide = readFileSync(new URL("../../agents/mobile-features.md", import.meta.url), "utf8");
  assert.ok(guide.includes(".github/skills/mint-mobile-ux/SKILL.md"));
  assert.ok(!guide.includes(".github/skills/expo-native-ui/references/"));
  assert.ok(!guide.includes(".github/skills/expo-animation/RECIPES.md"));
  const tracker = ".github/skills/mint-task-tracking/SKILL.md";
  assert.equal(run("owner", tracker)[tracker], "agent-tooling");
  const trackerPacket = run("context", "inspect this guidance", tracker);
  assert.deepEqual(trackerPacket.domains.map((d) => d.id), ["agent-tooling"]);
  assert.ok(!trackerPacket.read.some((file) => file.startsWith(".github/skills/")));
});

test("applyToSafe neutralizes minimatch character classes", () => {
  assert.equal(applyToSafe("api/[...path]/route.ts"), "api/?...path?/route.ts");
});

test("replaceBlock swaps only the generated section", () => {
  const doc = `hand\n${GEN_START}\nold\n${GEN_END}\ntail`;
  assert.equal(replaceBlock(doc, `${GEN_START}\nnew\n${GEN_END}`), `hand\n${GEN_START}\nnew\n${GEN_END}\ntail`);
  assert.throws(() => replaceBlock("no markers", "x"), /markers/);
});
