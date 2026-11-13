#!/usr/bin/env -S node --import tsx
import { recordings } from "@mint/domain-catalog";
import { createLibraryRepository, mediaFiles, roots } from "@mint/domain-library";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { constants } from "node:fs";
import { access, lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

class ProvisionConfigurationError extends Error {
  constructor(readonly field: string) {
    super(`Invalid configuration: ${field}`);
  }
}

class ProvisionRootError extends Error {
  constructor(readonly code: "UNSAFE_ROOT" | "ROOT_CHANGED" | "AMBIGUOUS_ROOT") {
    super(code);
  }
}

function validateRootPath(value: string): void {
  if (process.platform !== "linux" || !path.posix.isAbsolute(value) || value === "/"
    || value.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(value)
    || value !== path.posix.normalize(value) || value.endsWith("/")) {
    throw new ProvisionRootError("UNSAFE_ROOT");
  }
}

export function readLibraryRootConfiguration(env: NodeJS.ProcessEnv) {
  function required(field: string, empty = false): string {
    const value = env[field];
    if (value === undefined || (!empty && !value.trim()) || value.length > 4096 || value.includes("\0")) {
      throw new ProvisionConfigurationError(field);
    }
    return value;
  }
  function integer(field: string, max: number): number {
    const value = required(field);
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
      throw new ProvisionConfigurationError(field);
    }
    return Number(value);
  }
  const rootPath = required("MINT_LIBRARY_ROOT_PATH");
  validateRootPath(rootPath);
  const host = required("MINT_API_DB_HOST");
  const port = integer("MINT_API_DB_PORT", 65535);
  const database = required("MINT_API_DB_NAME");
  const user = required("MINT_API_DB_USER");
  const password = required("MINT_API_DB_PASSWORD", true);
  const tls = required("MINT_API_DB_TLS");
  if (tls !== "disabled" && tls !== "verify") throw new ProvisionConfigurationError("MINT_API_DB_TLS");
  const connectionTimeoutMillis = integer("MINT_API_DB_CONNECT_TIMEOUT_MS", 2_147_483_647);
  return {
    rootPath,
    database: {
      host, port, database, user, password, connectionTimeoutMillis,
      ssl: tls === "verify" ? { rejectUnauthorized: true } : false,
      application_name: "mint-library-root-provision",
      statement_timeout: 10_000,
      lock_timeout: 5_000,
    },
  };
}

async function checkDirectory(handle: FileHandle, rootPath: string): Promise<void> {
  await access(rootPath, constants.R_OK | constants.X_OK);
  const opened = await handle.stat({ bigint: true });
  const current = await lstat(rootPath, { bigint: true });
  if (!opened.isDirectory() || !current.isDirectory()
    || opened.dev !== current.dev || opened.ino !== current.ino
    || await realpath(rootPath) !== rootPath
    || await realpath(`/proc/self/fd/${handle.fd}`) !== rootPath) {
    throw new ProvisionRootError("ROOT_CHANGED");
  }
}

/** Connected operator client only. Never called by the API runtime. */
export async function provisionLibraryRoot(
  client: pg.Client,
  rootPath: string,
): Promise<{ rootId: string; created: boolean }> {
  validateRootPath(rootPath);
  if (await realpath(rootPath) !== rootPath) throw new ProvisionRootError("UNSAFE_ROOT");
  const handle = await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let closed = false;
  let failed = false;
  let failure: unknown;
  try {
    await checkDirectory(handle, rootPath);
    const db = drizzle(client, { schema: { roots, mediaFiles, recordings } });
    return await db.transaction(async (tx) => {
      // roots.path has no unique constraint; serialize even ordinary repository inserts.
      await tx.execute(sql`LOCK TABLE ${roots} IN SHARE ROW EXCLUSIVE MODE`);
      const existing = await tx.select({ id: roots.id }).from(roots)
        .where(eq(roots.path, rootPath)).limit(2);
      if (existing.length > 1) throw new ProvisionRootError("AMBIGUOUS_ROOT");
      const identity = existing[0] ?? await createLibraryRepository(tx).createRoot({ path: rootPath });
      await checkDirectory(handle, rootPath);
      await handle.close();
      closed = true;
      return { rootId: identity.id, created: existing.length === 0 };
    });
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    if (!closed) {
      try {
        await handle.close();
      } catch (error) {
        if (failed) throw new AggregateError([failure, error], "Root provisioning and directory cleanup failed");
        throw error;
      }
    }
  }
}

function safeFailure(error: unknown): { code: string; field?: string } {
  if (error instanceof ProvisionConfigurationError) return { code: "INVALID_CONFIGURATION", field: error.field };
  if (error instanceof ProvisionRootError) return { code: error.code };
  // Never emit raw driver errors, queries, paths, stacks or nested credential-bearing causes.
  const codes = new Set([
    "ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP", "ENAMETOOLONG",
    "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT",
    "28P01", "28000", "3D000", "3F000", "42P01", "42501", "55P03", "57014", "08006",
  ]);
  if (error instanceof Error) {
    if ("code" in error && typeof error.code === "string" && codes.has(error.code)) return { code: error.code };
    if (error.cause instanceof pg.DatabaseError && codes.has(error.cause.code ?? "")) {
      return { code: error.cause.code! };
    }
  }
  return { code: "OPERATION_FAILED" };
}

async function main(): Promise<void> {
  let client: pg.Client | undefined;
  let result: Awaited<ReturnType<typeof provisionLibraryRoot>> | undefined;
  let phase = "configuration";
  try {
    if (process.argv.length !== 2) throw new ProvisionConfigurationError("arguments");
    const config = readLibraryRootConfiguration(process.env);
    phase = "database-connect";
    client = new pg.Client(config.database);
    client.on("error", (error: Error) => {
      console.error(JSON.stringify({ event: "library-root-provision-failed", phase: "database-client", ...safeFailure(error) }));
      process.exitCode = 1;
    });
    await client.connect();
    phase = "provision";
    result = await provisionLibraryRoot(client, config.rootPath);
  } catch (error) {
    console.error(JSON.stringify({ event: "library-root-provision-failed", phase, ...safeFailure(error) }));
    process.exitCode = 1;
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        console.error(JSON.stringify({ event: "library-root-provision-failed", phase: "database-close", code: "OPERATION_FAILED" }));
        process.exitCode = 1;
      }
    }
  }
  if (result && !process.exitCode) {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify({ event: "library-root-provisioned", ...result })}\n`,
        (error) => error ? reject(error) : resolve());
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error(JSON.stringify({ event: "library-root-provision-failed", phase: "output", code: "OPERATION_FAILED" }));
    process.exitCode = 1;
  });
}
