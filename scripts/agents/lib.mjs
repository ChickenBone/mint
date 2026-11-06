// Pure helpers for agent domain routing. No dependencies so it runs before `npm ci`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const GEN_START = "<!-- agents:generated:start — do not edit below; run `npm run agents:sync` -->";
export const GEN_END = "<!-- agents:generated:end -->";
export const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
export const TEST_FILE = /\.test\.(?:[cm]?[jt]sx?)$/;

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\/*?]/g, "\\$&");

/** Minimal glob: `**`, `*`, `?` and `{a,b}`. Brackets/parens are literal (Next.js route folders). */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) throw new Error(`Unclosed brace in glob: ${glob}`);
      re += `(?:${glob.slice(i + 1, end).split(",").map(escapeRe).join("|")})`;
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

export const isWildcard = (glob) => /[*?{]/.test(glob);

/** Exact paths always win; otherwise more literal characters means more specific. */
export function specificity(glob) {
  if (!isWildcard(glob)) return 1e6;
  return glob.replace(/\*\*\/?|\*|\?|\{[^}]*\}/g, "").length;
}

export function compileManifest(manifest) {
  const ids = new Set();
  for (const d of manifest.domains) {
    if (!/^[a-z][a-z0-9-]*$/.test(d.id)) throw new Error(`Invalid domain id: ${d.id}`);
    if (ids.has(d.id)) throw new Error(`Duplicate domain id: ${d.id}`);
    ids.add(d.id);
  }
  return {
    ...manifest,
    ignoreRes: (manifest.ignore ?? []).map(globToRegExp),
    domains: manifest.domains.map((d) => ({
      ...d,
      guides: d.guides ?? [],
      keywords: d.keywords ?? [],
      validate: d.validate ?? [],
      patterns: d.paths.map((glob) => ({ glob, re: globToRegExp(glob), score: specificity(glob) })),
    })),
  };
}

/**
 * Resolves each file to exactly one owning domain (most specific pattern wins).
 * Returns { owners: Map<file, domainId>, unowned, ambiguous: [{file, domains}], patternHits: Map<"id\0glob", n> }.
 */
export function resolveOwnership(compiled, files) {
  const owners = new Map();
  const unowned = [];
  const ambiguous = [];
  const patternHits = new Map();
  for (const file of files) {
    if (compiled.ignoreRes.some((re) => re.test(file))) continue;
    let best = -1;
    let winners = [];
    for (const d of compiled.domains) {
      let domainBest = -1;
      for (const p of d.patterns) {
        if (!p.re.test(file)) continue;
        const key = `${d.id}\0${p.glob}`;
        patternHits.set(key, (patternHits.get(key) ?? 0) + 1);
        domainBest = Math.max(domainBest, p.score);
      }
      if (domainBest < 0) continue;
      if (domainBest > best) {
        best = domainBest;
        winners = [d.id];
      } else if (domainBest === best) winners.push(d.id);
    }
    if (winners.length === 0) unowned.push(file);
    else if (winners.length > 1) ambiguous.push({ file, domains: winners });
    else owners.set(file, winners[0]);
  }
  return { owners, unowned, ambiguous, patternHits };
}

// ---------- workspaces & imports ----------

export function loadWorkspaces(root) {
  const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const out = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    const base = pattern.replace(/\/\*$/, "");
    const abs = path.join(root, base);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).sort()) {
      const pkgPath = path.join(abs, name, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      out.push({ dir: `${base}/${name}`, name: pkg.name, scripts: pkg.scripts ?? {}, exports: pkg.exports ?? {} });
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

export const workspaceFor = (workspaces, file) => workspaces.find((w) => file.startsWith(`${w.dir}/`));

const IMPORT_RE = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

export function importSpecifiers(source) {
  const out = new Set();
  for (const m of source.matchAll(IMPORT_RE)) out.add(m[1] ?? m[2]);
  return [...out];
}

/** Resolves a specifier to a repo-relative file present in `fileSet`, or null for external packages. */
export function resolveImport(spec, fromFile, fileSet, workspaces) {
  let base = null;
  if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  else if (spec.startsWith("@/")) {
    const ws = workspaceFor(workspaces, fromFile);
    if (ws) base = `${ws.dir}/src/${spec.slice(2)}`;
  } else {
    const ws = workspaces.find((w) => spec === w.name || spec.startsWith(`${w.name}/`));
    if (ws) {
      const sub = spec === ws.name ? "." : `./${spec.slice(ws.name.length + 1)}`;
      const target = typeof ws.exports === "string" ? (sub === "." ? ws.exports : null) : ws.exports[sub];
      const t = typeof target === "object" && target ? (target.import ?? target.default) : target;
      base = t ? path.posix.join(ws.dir, t) : path.posix.join(ws.dir, "src", sub);
    }
  }
  if (!base) return null;
  const stripped = base.replace(/\.(?:[cm]?js)$/, "");
  const candidates = [base, ...[".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"].map((e) => stripped + e)];
  return candidates.find((c) => fileSet.has(c)) ?? null;
}

export function exportedNames(source) {
  const names = [];
  const re = /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|abstract\s+class|type|interface|enum)\s+([A-Za-z0-9_$]+)/gm;
  for (const m of source.matchAll(re)) names.push(m[1]);
  if (/^export\s+default\s+(?!(?:async\s+)?function\s+\w|class\s+\w)/m.test(source)) names.push("default");
  return [...new Set(names)];
}

// ---------- routing ----------

const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "add", "fix", "make", "change", "update", "page", "when", "should", "have", "new", "use", "not"]);

export function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Ranks domains for free text and/or paths. `owners` maps known files to domains. */
export function routeQuery(compiled, owners, args) {
  const scores = new Map(compiled.domains.map((d) => [d.id, { score: 0, why: new Set() }]));
  const bump = (id, n, why) => {
    const s = scores.get(id);
    s.score += n;
    s.why.add(why);
  };
  const text = ` ${args.join(" ").toLowerCase()} `;
  const words = tokenize(text);

  for (const arg of args) {
    if (!arg.includes("/") && !/\.[a-z]{2,4}$/i.test(arg)) continue;
    const norm = arg.replace(/^\.\//, "").replace(/\/$/, "");
    let matched = false;
    for (const [file, id] of owners) {
      if (file === norm || file.startsWith(`${norm}/`)) {
        bump(id, file === norm ? 20 : 2, `path ${norm}`);
        matched = true;
      }
    }
    if (!matched) {
      for (const d of compiled.domains) if (d.patterns.some((p) => p.re.test(norm))) bump(d.id, 10, `pattern ${norm}`);
    }
  }

  for (const d of compiled.domains) {
    for (const kw of d.keywords) {
      const k = kw.toLowerCase();
      const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(k)}(?:s|es)?(?:[^a-z0-9]|$)`);
      if (re.test(text)) bump(d.id, k.includes(" ") ? 5 : 3, `keyword "${kw}"`);
    }
    if (words.includes(d.id)) bump(d.id, 4, `domain "${d.id}"`);
  }

  // File-name hits catch vocabulary the keyword lists miss; capped so they only break ties.
  const nameHits = new Map();
  for (const [file, id] of owners) {
    const base = path.posix.basename(file).toLowerCase();
    for (const w of words) {
      if (w.length >= 4 && base.includes(w)) nameHits.set(id, (nameHits.get(id) ?? 0) + 1);
    }
  }
  for (const [id, n] of nameHits) bump(id, Math.min(3, n), "file names");

  return [...scores]
    .filter(([, s]) => s.score > 0)
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .map(([id, s]) => ({ id, score: s.score, why: [...s.why] }));
}

// ---------- rendering helpers ----------

/** Glob safe for GitHub `applyTo` (minimatch), where brackets would become character classes. */
export const applyToSafe = (p) => p.replace(/[[\]]/g, "?");

export function splitCard(content) {
  const i = content.indexOf(GEN_START);
  if (i === -1) return { manual: content.trimEnd(), hasBlock: false };
  return { manual: content.slice(0, i).trimEnd(), hasBlock: true };
}

export function replaceBlock(content, block) {
  const start = content.indexOf(GEN_START);
  const end = content.indexOf(GEN_END);
  if (start === -1 || end === -1 || end < start) throw new Error("Generated markers missing or malformed");
  return content.slice(0, start) + block + content.slice(end + GEN_END.length);
}
