import type { ConnectionOptions } from "node:tls";
import { createAccountsRepository, sessions, users } from "@mint/domain-accounts";
import { recordings } from "@mint/domain-catalog";
import { createLibraryRepository, mediaFiles, roots } from "@mint/domain-library";
import { runStartupMigrations, type StartupMigrationOptions } from "@mint/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createApiServer, type ApiErrorLogger } from "./server";

export interface ApiRuntimeOptions {
  database: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: false | ConnectionOptions;
    max: number;
    connectionTimeoutMillis: number;
  };
  migrations: StartupMigrationOptions;
  listen: { host: string; port: number };
  gatewayToken: string;
  notifyAccessRequests(notification: { pending: number }): Promise<void>;
  errors: ApiErrorLogger;
}

export interface ApiRuntime {
  /** Listener address returned by Fastify; it contains no credentials. */
  address: string;
  stop(): Promise<void>;
}

function validPort(port: number, allowZero = false): boolean {
  return Number.isInteger(port) && port >= (allowZero ? 0 : 1) && port <= 65535;
}

export async function startApiRuntime(options: ApiRuntimeOptions): Promise<ApiRuntime> {
  const db = options?.database;
  if (!db || typeof db.host !== "string" || !db.host || !validPort(db.port)
    || typeof db.database !== "string" || !db.database
    || typeof db.user !== "string" || !db.user || typeof db.password !== "string"
    || (db.ssl !== false && (typeof db.ssl !== "object" || db.ssl === null))
    || !Number.isInteger(db.max) || db.max <= 0
    || !Number.isInteger(db.connectionTimeoutMillis) || db.connectionTimeoutMillis <= 0
    || typeof options.listen?.host !== "string" || !options.listen.host
    || !validPort(options.listen.port, true)
    || typeof options.errors?.error !== "function"
    || typeof options.notifyAccessRequests !== "function") {
    throw new Error("Invalid API runtime configuration.");
  }
  const pool = new pg.Pool({ ...db, application_name: "mint-api-runtime" });
  pool.on("error", () => options.errors.error({ name: "PostgresPoolError" }));
  let app: ReturnType<typeof createApiServer> | undefined;
  let phase = "configuration";
  try {
    const repository = createAccountsRepository(drizzle(pool, { schema: { users, sessions } }));
    app = createApiServer({
      gatewayToken: options.gatewayToken,
      sessions: repository,
      decisions: repository,
      memberStatuses: repository,
      adminAccounts: repository,
      library: createLibraryRepository(drizzle(pool, { schema: { roots, mediaFiles, recordings } })),
      notifyAccessRequests: options.notifyAccessRequests,
      errors: options.errors,
    });
    phase = "migrations";
    await runStartupMigrations(pool, options.migrations);
    phase = "listen";
    const address = await app.listen(options.listen);
    let stopping: Promise<void> | undefined;
    return {
      address,
      stop() {
        stopping ??= (async () => {
          const errors: string[] = [];
          try { await app!.close(); } catch { errors.push("listener"); }
          try { await pool.end(); } catch { errors.push("pool"); }
          if (errors.length) throw new Error(`API shutdown failed: ${errors.join(", ")}.`);
        })();
        return stopping;
      },
    };
  } catch {
    let cleanupFailed = false;
    try { await app?.close(); } catch { cleanupFailed = true; }
    try { await pool.end(); } catch { cleanupFailed = true; }
    options.errors.error({ name: cleanupFailed ? "ApiStartupCleanupError" : "ApiStartupError" });
    throw new Error(`API startup failed during ${phase}${cleanupFailed ? "; cleanup failed" : ""}.`);
  }
}
