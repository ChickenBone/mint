import type { ConnectionOptions } from "node:tls";
import { argon2Passwords, bootstrapAdmin, createAccountsRepository, sessions, users } from "@mint/domain-accounts";
import { recordings } from "@mint/domain-catalog";
import { createLibraryRepository, mediaFiles, roots } from "@mint/domain-library";
import { createListeningHistoryRepository, historyPreferences, listeningHistory } from "@mint/domain-playback";
import { PostgresRateLimiter, runStartupMigrations, type StartupMigrationOptions } from "@mint/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createApiServer, type ApiErrorLogger } from "./server";
import { validateAdminBootstrapConfiguration } from "./runtime-config";

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
  publicAuthProxy?: "gateway";
  adminBootstrap?: { email: string; name: string; password: string };
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
  if (options.adminBootstrap !== undefined) validateAdminBootstrapConfiguration(options.adminBootstrap);
  if (options.publicAuthProxy !== undefined && options.publicAuthProxy !== "gateway") {
    throw new Error("Invalid API public authentication configuration.");
  }
  const pool = new pg.Pool({ ...db, application_name: "mint-api-runtime" });
  pool.on("error", () => options.errors.error({ name: "PostgresPoolError" }));
  let app: ReturnType<typeof createApiServer> | undefined;
  let phase = "configuration";
  try {
    const repository = createAccountsRepository(drizzle(pool, { schema: { users, sessions } }));
    app = createApiServer({
      gatewayToken: options.gatewayToken,
      ...(options.publicAuthProxy ? { publicAuth: {
        trustedProxy: options.publicAuthProxy,
        repository, passwords: argon2Passwords, admission: new PostgresRateLimiter(pool),
      } } : {}),
      sessions: repository,
      decisions: repository,
      memberStatuses: repository,
      adminAccounts: repository,
      library: createLibraryRepository(drizzle(pool, { schema: { roots, mediaFiles, recordings } })),
      playbackHistory: createListeningHistoryRepository(drizzle(pool, {
        schema: { historyPreferences, listeningHistory, mediaFiles, recordings, users },
      })),
      notifyAccessRequests: options.notifyAccessRequests,
      errors: options.errors,
    });
    phase = "migrations";
    await runStartupMigrations(pool, options.migrations);
    if (options.adminBootstrap !== undefined) {
      phase = "admin bootstrap";
      const result = await bootstrapAdmin(options.adminBootstrap, repository, {
        hash: argon2Passwords.hash,
        now: () => new Date(),
      });
      if (result.status === "missing-password") throw new Error("Missing admin bootstrap password.");
    }
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
