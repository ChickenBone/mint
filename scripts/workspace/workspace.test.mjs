import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const workspace = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
const clientRoot = path.join(root, "packages/client");
const clientSource = path.join(clientRoot, "src");
const clientPackage = JSON.parse(readFileSync(path.join(clientRoot, "package.json"), "utf8"));
const contractsRoot = path.join(root, "packages/contracts");
const contractsSource = path.join(contractsRoot, "src");
const contractsPackage = JSON.parse(readFileSync(path.join(contractsRoot, "package.json"), "utf8"));
const sdkRoot = path.join(root, "packages/sdk");
const sdkSource = path.join(sdkRoot, "src");
const sdkPackage = JSON.parse(readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
const accountsRoot = path.join(root, "packages/domain-accounts");
const accountsSource = path.join(accountsRoot, "src");
const accountsPackage = JSON.parse(readFileSync(path.join(accountsRoot, "package.json"), "utf8"));
const catalogRoot = path.join(root, "packages/domain-catalog");
const catalogSource = path.join(catalogRoot, "src");
const catalogPackage = JSON.parse(readFileSync(path.join(catalogRoot, "package.json"), "utf8"));
const libraryRoot = path.join(root, "packages/domain-library");
const librarySource = path.join(libraryRoot, "src");
const libraryPackage = JSON.parse(readFileSync(path.join(libraryRoot, "package.json"), "utf8"));
const playbackRoot = path.join(root, "packages/domain-playback");
const playbackSource = path.join(playbackRoot, "src");
const playbackPackage = JSON.parse(readFileSync(path.join(playbackRoot, "package.json"), "utf8"));
const platformRoot = path.join(root, "packages/platform");
const platformSource = path.join(platformRoot, "src");
const platformPackage = JSON.parse(readFileSync(path.join(platformRoot, "package.json"), "utf8"));
const apiRoot = path.join(root, "apps/api");
const apiSource = path.join(apiRoot, "src");
const apiPackage = JSON.parse(readFileSync(path.join(apiRoot, "package.json"), "utf8"));
const clientRequire = createRequire(path.join(clientRoot, "package.json"));
const ts = clientRequire("typescript");
const expectedProjectNames = [
  "@mint/agent",
  "@mint/api",
  "@mint/client",
  "@mint/contracts",
  "@mint/core",
  "@mint/domain-accounts",
  "@mint/domain-catalog",
  "@mint/domain-library",
  "@mint/domain-playback",
  "@mint/platform",
  "@mint/realtime",
  "@mint/sdk",
  "@mint/web",
  "@mint/worker",
];
const expectedImporters = [
  ".",
  "apps/agent",
  "apps/api",
  "apps/realtime",
  "apps/web",
  "apps/worker",
  "packages/client",
  "packages/contracts",
  "packages/core",
  "packages/domain-accounts",
  "packages/domain-catalog",
  "packages/domain-library",
  "packages/domain-playback",
  "packages/platform",
  "packages/sdk",
];
const rootTargets = {
  "dev:web": ["@mint/web:dev"],
  "dev:worker": ["@mint/worker:dev"],
  "dev:realtime": ["@mint/realtime:dev"],
  "dev:hub": ["@mint/worker:dev:hub"],
  "dev:agent": ["@mint/agent:dev"],
  build: [
    "@mint/worker:build",
    "@mint/realtime:build",
    "@mint/agent:build",
    "@mint/web:build",
  ],
  typecheck: [
    "@mint/api:typecheck",
    "@mint/client:typecheck",
    "@mint/contracts:typecheck",
    "@mint/core:typecheck",
    "@mint/domain-accounts:typecheck",
    "@mint/domain-catalog:typecheck",
    "@mint/domain-library:typecheck",
    "@mint/domain-playback:typecheck",
    "@mint/platform:typecheck",
    "@mint/sdk:typecheck",
    "@mint/realtime:typecheck",
    "@mint/worker:typecheck",
    "@mint/agent:typecheck",
    "@mint/web:typecheck",
  ],
  lint: ["@mint/web:lint"],
  test: [
    "@mint/api:test",
    "@mint/worker:test",
    "@mint/client:test",
    "@mint/contracts:test",
    "@mint/core:test",
    "@mint/domain-accounts:test",
    "@mint/domain-catalog:test",
    "@mint/domain-library:test",
    "@mint/domain-playback:test",
    "@mint/platform:test",
    "@mint/sdk:test",
    "@mint/agent:test",
    "@mint/web:test",
  ],
  "db:generate": ["@mint/core:db:generate"],
  "db:migrate": ["@mint/core:db:migrate"],
};

function nxJson(args) {
  return JSON.parse(
    execFileSync(path.join(root, "node_modules/.bin/nx"), args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NX_DAEMON: "false" },
    }),
  );
}

// Only reviewed server-free runtime dependencies may extend the import allowlist.
function serverFreeDependencies(manifest, packageName) {
  const dependencies = Object.keys(manifest.dependencies ?? {});
  const allowed = packageName === "sdk" ? ["@mint/contracts", "@trpc/client"]
    : packageName === "client" ? ["zod", "@mint/contracts"] : ["zod"];
  const required = packageName === "sdk" ? allowed : ["zod"];
  for (const name of required) {
    assert.ok(dependencies.includes(name), `${packageName} must declare its ${name} dependency`);
  }
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(
      Object.keys(manifest[section] ?? {}).filter((name) => !allowed.includes(name)),
      [],
      `review new ${packageName} ${section} for the server-free boundary`,
    );
  }
  return new Set([...dependencies, ...(packageName === "client" ? ["@mint/contracts"] : [])]);
}

function publicPackageExports(name, packageRoot = clientRoot) {
  if (name === "@mint/contracts") {
    assert.equal(contractsPackage.name, name);
    return exportKeys(contractsPackage.exports);
  }
  if (name === "@mint/domain-catalog") {
    assert.equal(catalogPackage.name, name);
    return exportKeys(catalogPackage.exports);
  }
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "node_modules", name, "package.json"), "utf8"));
  return exportKeys(manifest.exports);
}

function exportKeys(exports) {
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) return ["."];
  const keys = Object.keys(exports);
  return keys.some((key) => key.startsWith(".")) ? keys : ["."];
}

function isPublicExport(specifier, name, exports) {
  if (specifier === name) return exports.includes(".");
  if (!specifier.startsWith(`${name}/`)) return false;
  const subpath = `.${specifier.slice(name.length)}`;
  return exports.some((entry) => {
    if (!entry.startsWith("./")) return false;
    const [prefix, suffix, ...extra] = entry.split("*");
    return extra.length === 0 && (suffix === undefined
      ? entry === subpath
      : subpath.startsWith(prefix) && subpath.endsWith(suffix)
        && subpath.length > prefix.length + suffix.length);
  });
}

function serverFreeSourceFiles(dir) {
  assert.ok(!lstatSync(dir).isSymbolicLink(), `package source must not contain symlinks: ${dir}`);
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    assert.ok(!entry.isSymbolicLink(), `package source must not contain symlinks: ${file}`);
    if (entry.isDirectory()) return serverFreeSourceFiles(file);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [file] : [];
  });
}

function checkServerFreeSource(
  file, source, sourceFiles, dependencies, exportsByPackage, sourceRoot,
  allowNodeBuiltins = false, typeDependencies = dependencies,
) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const errors = parsed.parseDiagnostics.map((diagnostic) =>
    `${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  const report = (node, message) => {
    const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    errors.push(`${file}:${position.line + 1}:${position.character + 1}: ${message}`);
  };
  const checkSpecifier = (node, allowedDependencies = dependencies) => {
    if (!node || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      report(node ?? parsed, "module specifier must be a static literal");
      return;
    }
    const specifier = node.text;
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const target = path.resolve(path.dirname(file), specifier);
      const relative = path.relative(sourceRoot, target);
      const candidates = [
        target, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map((ext) => target + ext),
        ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((name) => path.join(target, name)),
      ];
      // TS also resolves a .js specifier to a TypeScript source.
      if (/\.[cm]?js$/.test(target)) {
        const base = target.replace(/\.[cm]?js$/, "");
        const extensions = target.endsWith(".mjs") ? [".mts"] : target.endsWith(".cjs") ? [".cts"] : [".ts", ".tsx"];
        candidates.push(...extensions.map((ext) => base + ext));
      }
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".."
          || path.isAbsolute(relative) || !candidates.some((candidate) => sourceFiles.has(candidate))) {
        report(node, `relative import must resolve to own package source: ${specifier}`);
      }
      return;
    }
    if (allowNodeBuiltins && nodeBuiltins.has(specifier)) return;
    if (![...allowedDependencies].some((name) =>
      isPublicExport(specifier, name, exportsByPackage.get(name) ?? ["."]))) {
      report(node, `dependency is not a public ${allowNodeBuiltins ? "server package" : "server-free"} dependency: ${specifier}`);
    }
  };
  const memberName = (node) => {
    if (ts.isParenthesizedExpression(node)) return memberName(node.expression);
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) {
      const base = memberName(node.expression);
      return base ? `${base}.${node.name.text}` : null;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      const base = memberName(node.expression);
      return base ? `${base}.${node.argumentExpression.text}` : null;
    }
    return null;
  };
  const moduleLoaders = new Set(["require", "require.resolve", "module.require", "globalThis.require",
    "process.mainModule.require", "globalThis.process.mainModule.require"]);
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier) {
        checkSpecifier(node.moduleSpecifier, node.importClause?.isTypeOnly ? typeDependencies : dependencies);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        checkSpecifier(node.moduleSpecifier, node.isTypeOnly ? typeDependencies : dependencies);
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkSpecifier(node.moduleReference.expression, node.isTypeOnly ? typeDependencies : dependencies);
    } else if (ts.isImportTypeNode(node)) {
      checkSpecifier(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument, typeDependencies);
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = memberName(expression);
      if (expression.kind === ts.SyntaxKind.ImportKeyword
          || moduleLoaders.has(name)) {
        checkSpecifier(node.arguments[0]);
      } else if (!allowNodeBuiltins && ["process.getBuiltinModule", "globalThis.process.getBuiltinModule"].includes(name)) {
        report(node, "Node process.getBuiltinModule is server-only");
      }
    }
    if (!allowNodeBuiltins && moduleLoaders.has(memberName(node))
        && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const parent = node.parent;
      const isPropertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isLoaderBase = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
        && moduleLoaders.has(memberName(parent));
      let reference = node;
      while (ts.isParenthesizedExpression(reference.parent)) reference = reference.parent;
      const isDirectCall = ts.isCallExpression(reference.parent) && reference.parent.expression === reference;
      if (!isPropertyName && !isLoaderBase && !isDirectCall) {
        report(node, "module loader must be called directly with a static literal");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return errors;
}

const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

test("API manifest and source respect the public server composition boundary", () => {
  assert.equal(apiPackage.name, "@mint/api");
  assert.deepEqual(apiPackage.exports, { ".": "./src/index.ts" });
  assert.deepEqual(apiPackage.dependencies, {
    "@mint/contracts": "workspace:*",
    "@mint/domain-accounts": "workspace:*",
    "@mint/domain-catalog": "workspace:*",
    "@mint/domain-library": "workspace:*",
    "@mint/domain-playback": "workspace:*",
    "@mint/platform": "workspace:*",
    "@trpc/server": "11.28.0",
    "drizzle-orm": "^0.45.4",
    fastify: "5.12.8",
    pg: "^8.16.0",
  });
  assert.deepEqual(Object.keys(apiPackage.optionalDependencies ?? {}), []);
  assert.deepEqual(Object.keys(apiPackage.peerDependencies ?? {}), []);
  assert.deepEqual(apiPackage.scripts, {
    start: "node --import tsx src/main.ts",
    dev: "node --import tsx src/main.ts",
    typecheck: "tsc --noEmit",
    test: "tsx --test tests/*.test.ts",
  });
  const config = JSON.parse(readFileSync(path.join(apiRoot, "tsconfig.json"), "utf8"));
  assert.equal(config.extends, "../../tsconfig.base.json");
  assert.deepEqual(config.include, ["src/**/*.ts", "tests/**/*.ts"]);
  const entry = ts.createSourceFile("index.ts", readFileSync(path.join(sdkSource, "index.ts"), "utf8"),
    ts.ScriptTarget.Latest, true);
  assert.deepEqual(entry.statements.filter((statement) =>
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .map((statement) => statement.name?.text).sort(),
  ["MintSdk", "MintSdkError", "MintSdkErrorCode", "MintSdkOptions", "createMintSdk"].sort());
  assert.ok(entry.statements.every((statement) =>
    !ts.isExportDeclaration(statement) && !ts.isExportAssignment(statement)));

  const dependencies = new Set(Object.keys(apiPackage.dependencies));
  const exportsByPackage = new Map([...dependencies].map((name) =>
    [name, exportKeys(JSON.parse(readFileSync(path.join(apiRoot, "node_modules", name, "package.json"), "utf8")).exports)]));
  const files = serverFreeSourceFiles(apiSource);
  assert.ok(files.includes(path.join(apiSource, "index.ts")));
  const sourceFiles = new Set(files);
  const check = (file, source) =>
    checkServerFreeSource(file, source, sourceFiles, dependencies, exportsByPackage, apiSource, true);
  assert.deepEqual(files.flatMap((file) => check(file, readFileSync(file, "utf8"))), []);

  const fixture = path.join(apiSource, "index.ts");
  for (const source of [
    'import { lookupBrowserSession } from "@mint/domain-accounts";',
    'import { accountPrincipalSchema } from "@mint/contracts";',
    'import { initTRPC } from "@trpc/server";',
    'import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";',
    'import Fastify from "fastify";',
    'import pg from "pg";',
    'import { runStartupMigrations } from "@mint/platform";',
  ]) {
    assert.deepEqual(check(fixture, source), [], source);
  }
  for (const source of [
    'import "@mint/core";', 'import "@mint/client";', 'import "next";',
    'import "@mint/domain-accounts/src/session-lookup";',
    'import "@mint/contracts/src/accounts";', 'import "@trpc/server/src/private";',
    'import "fastify/lib/private";', 'import "@mint/platform/src/private";',
    'import "../../web/src/lib/auth";', 'import(name);',
  ]) {
    assert.notDeepEqual(check(fixture, source), [], source);
  }
});

test("platform manifest and source respect the infrastructure dependency boundary", () => {
  assert.equal(platformPackage.name, "@mint/platform");
  assert.deepEqual(platformPackage.exports, { ".": "./src/index.ts" });
  assert.deepEqual(platformPackage.dependencies, {
    "drizzle-orm": "^0.45.4", pg: "^8.16.0", "pg-boss": "12.38.2",
  });
  assert.deepEqual(Object.keys(platformPackage.optionalDependencies ?? {}), []);
  assert.deepEqual(Object.keys(platformPackage.peerDependencies ?? {}), []);

  const dependencies = new Set(Object.keys(platformPackage.dependencies));
  const exportsByPackage = new Map([...dependencies].map((name) =>
    [name, exportKeys(JSON.parse(readFileSync(path.join(platformRoot, "node_modules", name, "package.json"), "utf8")).exports)]));
  const files = serverFreeSourceFiles(platformSource);
  assert.ok(files.includes(path.join(platformSource, "index.ts")));
  const sourceFiles = new Set(files);
  const check = (file, source) =>
    checkServerFreeSource(file, source, sourceFiles, dependencies, exportsByPackage, platformSource, true);
  assert.deepEqual(files.flatMap((file) => check(file, readFileSync(file, "utf8"))), []);

  const fixture = path.join(platformSource, "index.ts");
  for (const source of [
    'import "node:fs/promises";', 'import path from "path";',
    'import type { NodePgDatabase } from "drizzle-orm/node-postgres";',
    'import { migrate } from "drizzle-orm/node-postgres/migrator";',
    'import pg from "pg";', 'const fs = process.getBuiltinModule("fs");',
  ]) {
    assert.deepEqual(check(fixture, source), [], source);
  }
  for (const source of [
    'import "@mint/core";', 'import "@mint/domain-accounts";',
    'import "@mint/domain-other/src/private";', 'import "@mint/client";',
    'import "../../core/src/index";', 'import "../../../apps/web/src/lib/auth";',
    'import "drizzle-orm/src/private";', 'import "next";', 'import(name);',
  ]) {
    assert.notDeepEqual(check(fixture, source), [], source);
  }
});

test("catalog manifest and source respect the server domain boundary", () => {
  assert.equal(catalogPackage.name, "@mint/domain-catalog");
  assert.equal(catalogPackage.private, true);
  assert.equal(catalogPackage.type, "module");
  assert.deepEqual(catalogPackage.exports, { ".": "./src/index.ts" });
  assert.deepEqual(catalogPackage.dependencies, { "drizzle-orm": "^0.45.4" });
  assert.deepEqual(catalogPackage.devDependencies, {
    "@mint/platform": "workspace:*", "@types/node": "^22.15.0", "@types/pg": "^8.15.0",
    pg: "^8.16.0", typescript: "^5.9.3", tsx: "^4.23.15",
  });
  assert.deepEqual(catalogPackage.scripts, {
    typecheck: "tsc --noEmit", test: "tsx --test tests/*.test.ts",
  });
  assert.deepEqual(Object.keys(catalogPackage.optionalDependencies ?? {}), []);
  assert.deepEqual(Object.keys(catalogPackage.peerDependencies ?? {}), []);
  const config = JSON.parse(readFileSync(path.join(catalogRoot, "tsconfig.json"), "utf8"));
  assert.equal(config.extends, "../../tsconfig.base.json");
  assert.deepEqual(config.include, ["src/**/*.ts", "tests/**/*.ts"]);

  const dependencies = new Set(Object.keys(catalogPackage.dependencies));
  const typeDependencies = new Set([...dependencies, ...Object.keys(catalogPackage.devDependencies)]);
  const exportsByPackage = new Map([...typeDependencies].map((name) =>
    [name, exportKeys(JSON.parse(readFileSync(path.join(catalogRoot, "node_modules", name, "package.json"), "utf8")).exports)]));
  const files = serverFreeSourceFiles(catalogSource);
  assert.ok(files.includes(path.join(catalogSource, "index.ts")));
  const sourceFiles = new Set(files);
  const check = (file, source) =>
    checkServerFreeSource(file, source, sourceFiles, dependencies, exportsByPackage, catalogSource, true, typeDependencies);
  assert.deepEqual(files.flatMap((file) => check(file, readFileSync(file, "utf8"))), []);
  const fixture = path.join(catalogSource, "index.ts");
  for (const source of [
    'import { sql } from "drizzle-orm";', 'import { pgSchema } from "drizzle-orm/pg-core";',
    'export { recordings } from "./schema";',
    'import type { LocalJobRuntime } from "@mint/platform";',
    'export type { LocalJobRuntime } from "@mint/platform";',
    'type Runtime = import("@mint/platform").LocalJobRuntime;',
    'import type { Pool } from "pg";',
  ]) assert.deepEqual(check(fixture, source), [], source);
  for (const source of [
    'import "@mint/core";', 'import "@mint/domain-accounts";', 'import "@mint/platform";',
    'import "pg";', 'import "next";', 'import "drizzle-orm/src/private";',
    'import type { LocalJobRuntime } from "@mint/platform/src/private";',
    'export { LocalJobRuntime } from "@mint/platform";', 'import("@mint/platform");',
    'import "../../core/src/index";', 'import "../../../apps/web/src/lib/auth";', 'import(name);',
  ]) assert.notDeepEqual(check(fixture, source), [], source);
});

test("library manifest and source respect the server domain boundary", () => {
  assert.equal(libraryPackage.name, "@mint/domain-library");
  assert.equal(libraryPackage.private, true);
  assert.equal(libraryPackage.type, "module");
  assert.deepEqual(libraryPackage.exports, { ".": "./src/index.ts" });
  assert.deepEqual(libraryPackage.dependencies, {
    "@mint/domain-catalog": "workspace:*",
    "drizzle-orm": "^0.45.4",
  });
  assert.deepEqual(libraryPackage.devDependencies, {
    "@mint/platform": "workspace:*", "@types/node": "^22.15.0", "@types/pg": "^8.15.0",
    pg: "^8.16.0", typescript: "^5.9.3", tsx: "^4.23.15",
  });
  assert.deepEqual(libraryPackage.scripts, {
    typecheck: "tsc --noEmit", test: "tsx --test tests/*.test.ts",
  });
  assert.deepEqual(Object.keys(libraryPackage.optionalDependencies ?? {}), []);
  assert.deepEqual(Object.keys(libraryPackage.peerDependencies ?? []), []);
  const config = JSON.parse(readFileSync(path.join(libraryRoot, "tsconfig.json"), "utf8"));
  assert.equal(config.extends, "../../tsconfig.base.json");
  assert.deepEqual(config.include, ["src/**/*.ts", "tests/**/*.ts"]);

  const dependencies = new Set(Object.keys(libraryPackage.dependencies));
  const drizzleManifest = JSON.parse(readFileSync(path.join(libraryRoot, "node_modules/drizzle-orm/package.json"), "utf8"));
  const exportsByPackage = new Map([
    ["@mint/domain-catalog", publicPackageExports("@mint/domain-catalog", libraryRoot)],
    ["drizzle-orm", exportKeys(drizzleManifest.exports)],
  ]);
  const files = serverFreeSourceFiles(librarySource);
  assert.ok(files.includes(path.join(librarySource, "index.ts")));
  const sourceFiles = new Set(files);
  const check = (file, source) =>
    checkServerFreeSource(file, source, sourceFiles, dependencies, exportsByPackage, librarySource, true);
  assert.deepEqual(files.flatMap((file) => check(file, readFileSync(file, "utf8"))), []);

  const fixture = path.join(librarySource, "index.ts");
  for (const source of [
    'import { recordings } from "@mint/domain-catalog";',
    'import { pgSchema } from "drizzle-orm/pg-core";',
    'export { mediaFiles } from "./schema";',
  ]) assert.deepEqual(check(fixture, source), [], source);
  for (const source of [
    'import "@mint/domain-catalog/src/schema";', 'import "@mint/platform";',
    'import "@mint/core";', 'import "pg";', 'import "next";',
    'import "drizzle-orm/src/private";', 'import "../../core/src/index";',
    'import "../../../apps/web/src/lib/auth";', 'import(name);',
  ]) assert.notDeepEqual(check(fixture, source), [], source);
  assert.notDeepEqual(checkServerFreeSource(
    fixture, 'import "node:fs";', sourceFiles, dependencies, exportsByPackage, librarySource,
  ), [], "the identity schema must not perform filesystem I/O");
});

test("accounts manifest and source respect the server domain boundary", () => {
  assert.equal(accountsPackage.name, "@mint/domain-accounts");
  assert.deepEqual(accountsPackage.exports, { ".": "./src/index.ts" });
  assert.deepEqual(accountsPackage.dependencies, {
    "@mint/contracts": "workspace:*", "@node-rs/argon2": "^2.2.2", "drizzle-orm": "^0.45.4",
  });
  assert.deepEqual(Object.keys(accountsPackage.optionalDependencies ?? {}), []);
  assert.deepEqual(Object.keys(accountsPackage.peerDependencies ?? {}), []);

  const dependencies = new Set(Object.keys(accountsPackage.dependencies));
  const drizzleManifest = JSON.parse(readFileSync(path.join(accountsRoot, "node_modules/drizzle-orm/package.json"), "utf8"));
  const exportsByPackage = new Map([
    ["@mint/contracts", publicPackageExports("@mint/contracts")],
    ["drizzle-orm", exportKeys(drizzleManifest.exports)],
  ]);
  const files = serverFreeSourceFiles(accountsSource);
  assert.ok(files.includes(path.join(accountsSource, "index.ts")));
  const sourceFiles = new Set(files);
  const check = (file, source) =>
    checkServerFreeSource(file, source, sourceFiles, dependencies, exportsByPackage, accountsSource, true);
  assert.deepEqual(files.flatMap((file) => check(file, readFileSync(file, "utf8"))), []);

  const fixture = path.join(accountsSource, "index.ts");
  for (const source of [
    'import "node:crypto";', 'import type { AccountPrincipal } from "@mint/contracts";',
    'import { sql } from "drizzle-orm";', 'import { pgSchema } from "drizzle-orm/pg-core";',
  ]) {
    assert.deepEqual(check(fixture, source), [], source);
  }
  for (const source of [
    'import "@mint/core";', 'import "@mint/contracts/src/accounts";',
    'import "../../core/src/index";', 'import "../../../apps/web/src/lib/auth";',
    'import "@mint/domain-other/src/private";', 'import "drizzle-orm/src/private";',
    'import "@mint/platform";', 'import "pg";', 'import "next";', 'import(name);',
  ]) {
    assert.notDeepEqual(check(fixture, source), [], source);
  }
});

test("playback manifest and source respect the server domain boundary", () => {
  assert.equal(playbackPackage.name, "@mint/domain-playback");
  assert.equal(playbackPackage.private, true);
  assert.equal(playbackPackage.type, "module");
  assert.deepEqual(playbackPackage.exports, { ".": "./src/index.ts" });
  assert.deepEqual(playbackPackage.dependencies, {
    "@mint/contracts": "workspace:*",
    "@mint/domain-accounts": "workspace:*",
    "@mint/domain-catalog": "workspace:*",
    "@mint/domain-library": "workspace:*",
    "drizzle-orm": "^0.45.4",
  });
  assert.deepEqual(playbackPackage.devDependencies, {
    "@types/node": "^22.15.0",
    "@types/pg": "^8.15.0",
    pg: "^8.16.0",
    typescript: "^5.9.3",
    tsx: "^4.23.15",
  });
  assert.deepEqual(playbackPackage.scripts, {
    typecheck: "tsc --noEmit", test: "tsx --test tests/*.test.ts",
  });
  assert.deepEqual(Object.keys(playbackPackage.optionalDependencies ?? []), []);
  assert.deepEqual(Object.keys(playbackPackage.peerDependencies ?? []), []);
  const config = JSON.parse(readFileSync(path.join(playbackRoot, "tsconfig.json"), "utf8"));
  assert.equal(config.extends, "../../tsconfig.base.json");
  assert.deepEqual(config.include, ["src/**/*.ts", "tests/**/*.ts"]);

  const dependencies = new Set(Object.keys(playbackPackage.dependencies));
  const exportsByPackage = new Map([...dependencies].map((name) =>
    [name, publicPackageExports(name, playbackRoot)]));
  const files = serverFreeSourceFiles(playbackSource);
  assert.ok(files.includes(path.join(playbackSource, "index.ts")));
  const sourceFiles = new Set(files);
  const check = (file, source) =>
    checkServerFreeSource(file, source, sourceFiles, dependencies, exportsByPackage, playbackSource, true);
  assert.deepEqual(files.flatMap((file) => check(file, readFileSync(file, "utf8"))), []);

  const fixture = path.join(playbackSource, "index.ts");
  for (const source of [
    'import { recordings } from "@mint/domain-catalog";',
    'import { mediaFiles } from "@mint/domain-library";',
    'import type { ListeningHistoryPage } from "@mint/contracts";',
    'import { pgSchema } from "drizzle-orm/pg-core";',
    'export { listeningHistory } from "./schema";',
  ]) assert.deepEqual(check(fixture, source), [], source);
  for (const source of [
    'import "@mint/domain-catalog/src/schema";', 'import "@mint/platform";',
    'import "@mint/core";', 'import "pg";', 'import "next";',
    'import "drizzle-orm/src/private";', 'import "../../core/src/index";',
    'import "../../../apps/web/src/lib/auth";', 'import(name);',
  ]) assert.notDeepEqual(check(fixture, source), [], source);
});

for (const [packageName, sourceRoot, manifest] of [
  ["client", clientSource, clientPackage],
  ["contracts", contractsSource, contractsPackage],
  ["sdk", sdkSource, sdkPackage],
]) {
  const dependencies = serverFreeDependencies(manifest, packageName);
  const exportsByPackage = new Map([...dependencies].map((name) =>
    [name, publicPackageExports(name, path.dirname(sourceRoot))]));

  test(`${packageName} dependency manifest cannot silently allow server runtime packages`, () => {
    const baseDependencies = packageName === "sdk"
      ? { "@mint/contracts": "workspace:*", "@trpc/client": "11.28.0" } : { zod: "*" };
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of ["pg", "@mint/core", "@mint/client", "@mint/api", "@trpc/server",
        ...(packageName === "contracts" ? ["@mint/contracts"] : [])]) {
        assert.throws(() => serverFreeDependencies({
          dependencies: baseDependencies, [section]: { ...baseDependencies, [name]: "*" },
        }, packageName), new RegExp(`review new ${packageName} ${section}`));
      }
    }
    assert.doesNotThrow(() => serverFreeDependencies({ dependencies: baseDependencies }, packageName));
    if (packageName === "client") {
      assert.doesNotThrow(() => serverFreeDependencies({ dependencies: { zod: "*", "@mint/contracts": "*" } }, packageName));
    } else {
      assert.deepEqual(manifest.exports, { ".": "./src/index.ts" });
    }
    if (packageName === "sdk") {
      assert.deepEqual(manifest.dependencies, baseDependencies);
      assert.deepEqual(Object.keys(manifest.optionalDependencies ?? {}), []);
      assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), []);
      assert.deepEqual(manifest.devDependencies, {
        "@mint/api": "workspace:*", "@types/node": "^22.15.0",
        typescript: "^5.9.3", tsx: "^4.23.15",
      });
      assert.deepEqual(manifest.scripts, {
        typecheck: "tsc --noEmit", test: "tsx --test tests/*.test.ts",
      });
      const config = JSON.parse(readFileSync(path.join(sdkRoot, "tsconfig.json"), "utf8"));
      assert.equal(config.extends, "../../tsconfig.base.json");
      assert.deepEqual(config.include, ["src/**/*.ts", "tests/**/*.ts"]);
    }
  });

  test(`${packageName} boundary parser handles permitted and forbidden module forms`, () => {
    const file = path.join(sourceRoot, "fixture.ts");
    const sibling = packageName === "client" ? "contracts" : "client";
    const siblingImport = `../../${sibling}/src/local`;
    const sources = new Set([
      file, path.join(sourceRoot, "local.ts"),
      path.resolve(sourceRoot, `${siblingImport}.ts`),
    ]);
    const check = (source) => checkServerFreeSource(file, source, sources, dependencies, exportsByPackage, sourceRoot);
    const allowed = [
      ...(packageName === "sdk" ? [
        'import { createTRPCUntypedClient, httpLink } from "@trpc/client";',
        'export type { AccountPrincipal } from "@mint/contracts";',
      ] : ['import { z } from "zod";']),
      'import type { Foo } from "./local";',
      ...(packageName === "client" ? ['export type { Foo } from "@mint/contracts";'] : []),
      'export * from "./local";',
      'type Foo = import("./local").Foo;',
      'import local = require("./local");',
      'const local = require("./local");',
      'const local = import("./local");',
      'const x = globalThis.fetch("/api");',
    ];
    for (const source of allowed) assert.deepEqual(check(source), [], source);
    const forbidden = [
      'import "node:fs";', 'import fs from "fs";', 'export * from "pg";',
      'import "bullmq";', 'import "@mint/core";', 'import type { X } from "@mint/core/db";',
      'import "@mint/client";', `import "${siblingImport}";`,
      'import "@mint/api";', 'import type { AppRouter } from "@mint/api";',
      'import "@trpc/server";', 'import "@trpc/server/observable";',
      'import "@trpc/client/src/private";',
      ...(packageName === "contracts" ? ['export type { Foo } from "@mint/contracts";'] : []),
      'import "../../../apps/web/src/lib/auth";', 'import "@mint/contracts/src/private";',
      'import "zod/src/index";', 'import "./missing";', 'import "/absolute/path";',
      'import x = require("node:fs");', 'require("pg");', 'module.require("fs");',
      'require.resolve("fs");', 'globalThis.require("fs");', 'import("node:fs");',
      '(require)("fs");', 'module["require"]("fs");', 'require["resolve"]("fs");',
      'process.mainModule.require("fs");',
      'type X = import("node:fs").Stats;', 'import(name);', 'require(name);',
      'import(`./${name}`);', 'module.require(name);', 'require.resolve(name);',
      'const load = require; load("pg");', 'const load = module.require; load("pg");',
      'require.call(null, "pg");', 'globalThis["require"].apply(null, ["pg"]);',
      'process.getBuiltinModule("fs");', 'globalThis["process"]["getBuiltinModule"]("fs");',
      'import {',
    ];
    for (const source of forbidden) assert.notDeepEqual(check(source), [], source);
  });

  test(`all ${packageName} source files obey the server-free dependency boundary`, () => {
    const files = serverFreeSourceFiles(sourceRoot);
    assert.ok(files.length > 0, "package source traversal must not be empty");
    assert.ok(files.includes(path.join(sourceRoot, "index.ts")), "package entry point must be scanned");
    const sourceFiles = new Set(files);
    const errors = files.flatMap((file) =>
      checkServerFreeSource(file, readFileSync(file, "utf8"), sourceFiles, dependencies, exportsByPackage, sourceRoot));
    assert.deepEqual(errors, []);
  });
}

test("pnpm workspace and lockfile contain only the frozen non-Expo members", () => {
  assert.equal(rootPackage.packageManager, "pnpm@12.18.0");
  assert.deepEqual(
    [...workspace.matchAll(/^  - (.+)$/gm)].map(([, pattern]) => pattern),
    ["apps/web", "apps/worker", "apps/realtime", "apps/agent", "apps/api", "packages/*"],
  );
  assert.doesNotMatch(workspace, /apps\/mobile/);

  const importerSection = [...lockfile.matchAll(/^importers:\n([\s\S]*?)^packages:\n/gm)]
    .at(-1)?.[1];
  assert.ok(importerSection, "pnpm lockfile must contain an importer section");
  const importers = [...importerSection.matchAll(/^  (\S[^:\n]*):$/gm)]
    .map(([, importer]) => importer)
    .sort();
  assert.deepEqual(importers, expectedImporters);
});

test("Nx project discovery excludes Expo and matches the frozen workspace", () => {
  const projects = nxJson(["show", "projects", "--json"]).sort();
  assert.deepEqual(projects, expectedProjectNames);
  assert.ok(projects.every((name) => !name.includes("mobile")));
});

for (const [scriptName, expectedTargets] of Object.entries(rootTargets)) {
  test(`root ${scriptName} selector resolves only its intended Nx targets`, () => {
    const command = rootPackage.scripts[scriptName];
    assert.ok(command, `root package.json must define ${scriptName}`);
    assert.match(command, /^nx /);
    assert.doesNotMatch(command, /mobile/i);

    const [, ...args] = command.trim().split(/\s+/);
    const graph = nxJson([...args, "--graph=stdout"]);
    assert.deepEqual(Object.keys(graph.tasks.tasks).sort(), [...expectedTargets].sort());
    assert.ok(Object.keys(graph.graph.nodes).every((name) => !name.includes("mobile")));
  });
}
