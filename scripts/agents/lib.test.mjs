import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GEN_END,
  GEN_START,
  applyToSafe,
  compileManifest,
  exportedNames,
  importSpecifiers,
  replaceBlock,
  resolveImport,
  resolveOwnership,
  routeQuery,
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

test("applyToSafe neutralizes minimatch character classes", () => {
  assert.equal(applyToSafe("api/[...path]/route.ts"), "api/?...path?/route.ts");
});

test("replaceBlock swaps only the generated section", () => {
  const doc = `hand\n${GEN_START}\nold\n${GEN_END}\ntail`;
  assert.equal(replaceBlock(doc, `${GEN_START}\nnew\n${GEN_END}`), `hand\n${GEN_START}\nnew\n${GEN_END}\ntail`);
  assert.throws(() => replaceBlock("no markers", "x"), /markers/);
});
