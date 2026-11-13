import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { MigrationConfig } from "drizzle-orm/migrator";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export interface MigrationJournal {
  readonly version: "7";
  readonly dialect: "postgresql";
  readonly entries: readonly {
    readonly idx: number;
    readonly version: "7";
    readonly when: number;
    readonly tag: string;
    readonly breakpoints: boolean;
  }[];
}

export interface MigrationOptions {
  /** One central journal, not one journal per domain. Validated before any DB access. */
  readonly journal: unknown;
  /** All domain SQL paths are relative to this explicit composition-owned root. */
  readonly migrationsRoot: string;
  readonly files: readonly { readonly tag: string; readonly path: string }[];
  /** Explicit to avoid choosing persistent history ownership on the caller's behalf. */
  readonly history: { readonly schema: string; readonly table: string };
}

const maxEntries = 10_000;
const maxFileBytes = 16 * 1024 * 1024;
const maxTotalBytes = 256 * 1024 * 1024;
const safeTag = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateJournal(value: unknown): MigrationJournal {
  if (!isRecord(value) || value.version !== "7" || value.dialect !== "postgresql"
    || !Array.isArray(value.entries) || value.entries.length > maxEntries) {
    throw new Error("Expected a PostgreSQL Drizzle version 7 journal with at most 10000 entries");
  }
  const tags = new Set<string>();
  let previousWhen = -1;
  const entries = value.entries.map((entry: unknown, idx: number) => {
    if (!isRecord(entry) || entry.idx !== idx || entry.version !== "7"
      || typeof entry.when !== "number" || !Number.isSafeInteger(entry.when)
      || entry.when <= previousWhen || typeof entry.tag !== "string"
      || !safeTag.test(entry.tag) || entry.tag.length > 200
      || tags.has(entry.tag) || typeof entry.breakpoints !== "boolean") {
      throw new Error(`Invalid, duplicate or out-of-order migration journal entry ${idx}`);
    }
    previousWhen = entry.when;
    tags.add(entry.tag);
    return {
      idx,
      version: "7" as const,
      when: entry.when,
      tag: entry.tag,
      breakpoints: entry.breakpoints,
    };
  });
  return { version: "7", dialect: "postgresql", entries };
}

function validateIdentifier(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0
    || value.includes("\0") || Buffer.byteLength(value) > 63) {
    throw new Error("Migration history schema and table must be explicit PostgreSQL identifiers (1-63 bytes)");
  }
}

function validateFiles(files: MigrationOptions["files"], journal: MigrationJournal): Map<string, string> {
  if (!Array.isArray(files) || files.length !== journal.entries.length) {
    throw new Error("Migration files must match the central journal exactly");
  }
  const expected = new Set(journal.entries.map((entry) => entry.tag));
  const byTag = new Map<string, string>();
  for (const file of files) {
    if (!isRecord(file) || typeof file.tag !== "string" || !expected.has(file.tag) || byTag.has(file.tag)
      || typeof file.path !== "string" || file.path.length === 0 || file.path.includes("\0")
      || file.path.includes("\\") || path.isAbsolute(file.path)
      || file.path.split("/").some((part) => part === ".." || part === "." || part === "")
      || !file.path.endsWith(".sql")) {
      throw new Error("Invalid, duplicate or escaping migration file mapping");
    }
    byTag.set(file.tag, file.path);
  }
  return byTag;
}

async function readSql(root: string, relativePath: string): Promise<{ source: string; bytes: Buffer }> {
  let source = root;
  for (const part of relativePath.split("/")) {
    source = path.join(source, part);
    if ((await lstat(source)).isSymbolicLink()) {
      throw new Error(`Migration SQL must not use symbolic links: ${relativePath}`);
    }
  }
  source = await realpath(source);
  const relative = path.relative(root, source);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Migration SQL escapes migrationsRoot: ${relativePath}`);
  }
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > maxFileBytes) {
      throw new Error(`Migration SQL must be a nonempty regular file of at most 16 MiB: ${relativePath}`);
    }
    const bytes = await file.readFile();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.length > maxFileBytes || text.trim().length === 0 || text.includes("\0")) {
      throw new Error(`Invalid migration SQL file: ${relativePath}`);
    }
    return { source, bytes };
  } finally {
    await file.close();
  }
}

/**
 * Applies domain SQL in central journal order using Drizzle's transaction/history
 * implementation. Does not create a connection, inspect environment variables,
 * modify source migrations, or serialize concurrent startup callers.
 */
export async function runMigrations<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  options: MigrationOptions,
  migrateWith: typeof migrate = migrate,
): Promise<void> {
  const journal = validateJournal(options.journal);
  validateIdentifier(options.history.schema);
  validateIdentifier(options.history.table);
  const files = validateFiles(options.files, journal);
  const root = await realpath(options.migrationsRoot);
  if (!(await lstat(root)).isDirectory()) {
    throw new Error("migrationsRoot must be a directory");
  }
  const folder = await mkdtemp(path.join(tmpdir(), "mint-migrations-"));
  try {
    await mkdir(path.join(folder, "meta"));
    const sources = new Set<string>();
    let totalBytes = 0;
    for (const entry of journal.entries) {
      const relativePath = files.get(entry.tag);
      if (relativePath === undefined) {
        throw new Error(`Missing migration file mapping: ${entry.tag}`);
      }
      const { source, bytes } = await readSql(root, relativePath);
      if (sources.has(source)) {
        throw new Error(`Duplicate migration SQL source: ${relativePath}`);
      }
      sources.add(source);
      totalBytes += bytes.length;
      if (totalBytes > maxTotalBytes) {
        throw new Error("Migration SQL exceeds the 256 MiB assembly limit");
      }
      await writeFile(path.join(folder, `${entry.tag}.sql`), bytes, { flag: "wx", mode: 0o600 });
    }
    await writeFile(path.join(folder, "meta", "_journal.json"), JSON.stringify(journal), {
      flag: "wx", mode: 0o600,
    });
    const config: MigrationConfig = {
      migrationsFolder: folder,
      migrationsSchema: options.history.schema,
      migrationsTable: options.history.table,
    };
    await migrateWith(db, config);
  } catch (error) {
    try {
      await rm(folder, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Migration failed and assembly cleanup failed");
    }
    throw error;
  }
  await rm(folder, { recursive: true, force: true });
}
