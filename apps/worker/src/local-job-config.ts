import { isAbsolute } from "node:path";
import type { ConnectionOptions } from "node:tls";
import {
  validateLocalLibraryScanConfiguration, type LocalLibraryScanConfiguration,
} from "./local-library-scan";

export type LocalWorkerConfiguration = { enabledSources: readonly [] } | {
  enabledSources: readonly ("listenbrainz" | "library")[];
  libraryScan?: LocalLibraryScanConfiguration;
  database: {
    host: string; port: number; database: string; user: string; password: string;
    ssl: false | ConnectionOptions; max: number; connectionTimeoutMillis: number;
  };
  migrations: { packagesRoot: string; lockTimeoutMs: number };
  pollingIntervalSeconds: number;
  superviseIntervalSeconds: number;
  maintenanceIntervalSeconds: number;
  shutdownTimeoutMs: number;
};

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function text(value: unknown, empty = false): value is string {
  return typeof value === "string" && (empty || value.length > 0) && value.length <= 4096 && !value.includes("\0");
}

export function validateLocalWorkerConfiguration(config: LocalWorkerConfiguration): void {
  if (!config || !Array.isArray(config.enabledSources) || config.enabledSources.length > 2
    || new Set(config.enabledSources).size !== config.enabledSources.length
    || config.enabledSources.some((source) => source !== "listenbrainz" && source !== "library")) {
    throw new Error("Invalid local worker enabled sources.");
  }
  if (!isEnabledLocalWorker(config)) return;
  if (config.enabledSources.includes("library")) {
    if (!config.libraryScan) throw new Error("Library scans require explicit configuration.");
    validateLocalLibraryScanConfiguration(config.libraryScan);
  } else if (config.libraryScan !== undefined) throw new Error("Library scans are not enabled.");
  const db = config.database;
  if (!db || !text(db.host) || !integer(db.port, 1, 65535) || !text(db.database)
    || !text(db.user) || !text(db.password, true)
    || (db.ssl !== false && (!db.ssl || db.ssl.rejectUnauthorized !== true))
    || !integer(db.max, 1, 16) || !integer(db.connectionTimeoutMillis, 1, 2000)
    || !text(config.migrations?.packagesRoot) || !isAbsolute(config.migrations.packagesRoot)
    || !integer(config.migrations.lockTimeoutMs, 1, 2_147_483_647)
    || !Number.isFinite(config.pollingIntervalSeconds) || config.pollingIntervalSeconds < 0.5
    || config.pollingIntervalSeconds > 60 || !integer(config.superviseIntervalSeconds, 1, 86_400)
    || !integer(config.maintenanceIntervalSeconds, 1, 86_400)
    || !integer(config.shutdownTimeoutMs, 1000, 60_000)) {
    throw new Error("Invalid local worker configuration.");
  }
}

export function isEnabledLocalWorker(config: LocalWorkerConfiguration):
  config is Extract<LocalWorkerConfiguration, { database: unknown }> {
  return config.enabledSources.length > 0;
}

export function readLocalWorkerConfiguration(env: Readonly<Record<string, string | undefined>>): LocalWorkerConfiguration {
  const prefix = "MINT_LOCAL_WORKER_";
  function required(name: string, empty = false): string {
    const value = env[`${prefix}${name}`];
    if (!text(value, empty)) throw new Error(`Invalid configuration: ${prefix}${name}`);
    return value;
  }
  function number(name: string): number {
    const raw = required(name);
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) {
      throw new Error(`Invalid configuration: ${prefix}${name}`);
    }
    return Number(raw);
  }
  const rawSources = required("ENABLED_SOURCES");
  let sources: unknown;
  try { sources = JSON.parse(rawSources); }
  catch { throw new Error("Invalid local worker enabled sources."); }
  if (!Array.isArray(sources) || sources.length > 2 || new Set(sources).size !== sources.length
    || sources.some((source) => source !== "listenbrainz" && source !== "library")) {
    throw new Error("Invalid local worker enabled sources.");
  }
  if (sources.length === 0) return { enabledSources: [] };
  const tls = required("DB_TLS");
  if (tls !== "disabled" && tls !== "verify") throw new Error("Invalid local worker database TLS configuration.");
  const config: LocalWorkerConfiguration = {
    enabledSources: sources,
    ...(sources.includes("library") ? { libraryScan: readLibraryScanConfiguration(required("LIBRARY_SCAN")) } : {}),
    database: {
      host: required("DB_HOST"), port: number("DB_PORT"), database: required("DB_NAME"),
      user: required("DB_USER"), password: required("DB_PASSWORD", true),
      ssl: tls === "verify" ? { rejectUnauthorized: true } : false,
      max: number("DB_POOL_MAX"), connectionTimeoutMillis: number("DB_CONNECT_TIMEOUT_MS"),
    },
    migrations: { packagesRoot: required("MIGRATIONS_PACKAGES_ROOT"), lockTimeoutMs: number("MIGRATIONS_LOCK_TIMEOUT_MS") },
    pollingIntervalSeconds: number("POLLING_INTERVAL_SECONDS"),
    superviseIntervalSeconds: number("SUPERVISE_INTERVAL_SECONDS"),
    maintenanceIntervalSeconds: number("MAINTENANCE_INTERVAL_SECONDS"),
    shutdownTimeoutMs: number("SHUTDOWN_TIMEOUT_MS"),
  };
  validateLocalWorkerConfiguration(config);
  return config;
}

function readLibraryScanConfiguration(raw: string): LocalLibraryScanConfiguration {
  let value: LocalLibraryScanConfiguration;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Invalid configuration: MINT_LOCAL_WORKER_LIBRARY_SCAN"); }
  validateLocalLibraryScanConfiguration(value);
  return value;
}
