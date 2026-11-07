import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  GEN_END,
  GEN_START,
  applyToSafe,
  compileManifest,
  contextPathAllowed,
  exportedNames,
  importSpecifiers,
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
  for (const file of [".env", "apps/web/.env.local", "data/library.json", "private/a.ts", ".copilot/session.json", ".ssh/id_rsa", "keys/release.pem", "keys/release.KEY", "mint.keystore", "credentials.json", "operator-credentials.json", "run.log", "library.sqlite", "package-lock.json", "../README.md", "/etc/passwd", "apps\\secret", "a\nb"]) {
    assert.equal(contextPathAllowed(file), false, file);
  }
  for (const file of ["README.md", ".env.example", "apps/web/.env.production.example", "apps/mobile/app/browse/[facet].tsx", "future/feature.ts"]) {
    assert.equal(contextPathAllowed(file), true, file);
  }
});

test("context CLI emits bounded metadata and excludes supplied private paths", () => {
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [cli, "context", ...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const raw = run("context tooling", "scripts/agents/lib.mjs", ".env", "../private-secret", "/etc/passwd");
  const packet = JSON.parse(raw);
  assert.ok(packet.alwaysRead.includes("agents/engineering.md"));
  assert.ok(packet.domains.some((d) => d.id === "handbook"));
  assert.ok(packet.domains.every((d) => d.contracts.length <= 12 && Array.isArray(d.validation.cmds)));
  assert.equal(typeof packet.git.changedFiles, "number");
  for (const secret of [".env", "private-secret", "/etc/passwd", "export function routingPlan"]) assert.ok(!raw.includes(secret));
  const unmatched = JSON.parse(run("unrelated qzxvbn"));
  assert.equal(unmatched.domains.length, 0);
  assert.ok(unmatched.notes.some((note) => note.includes("No confident match")));
  assert.throws(() => run(), /usage/);
  const markdown = execFileSync(process.execPath, [cli, "context", "context tooling", "scripts/agents/lib.mjs"], { encoding: "utf8" });
  assert.ok(markdown.startsWith("# Focused repository context"));
  assert.ok(markdown.includes("## handbook"));
  assert.ok(markdown.includes("npm run test:agents"));
});

test("applyToSafe neutralizes minimatch character classes", () => {
  assert.equal(applyToSafe("api/[...path]/route.ts"), "api/?...path?/route.ts");
});

test("replaceBlock swaps only the generated section", () => {
  const doc = `hand\n${GEN_START}\nold\n${GEN_END}\ntail`;
  assert.equal(replaceBlock(doc, `${GEN_START}\nnew\n${GEN_END}`), `hand\n${GEN_START}\nnew\n${GEN_END}\ntail`);
  assert.throws(() => replaceBlock("no markers", "x"), /markers/);
});
