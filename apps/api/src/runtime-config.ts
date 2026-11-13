import { isAbsolute } from "node:path";
import { browserSignInInputSchema, gatewayTokenSchema } from "@mint/contracts";
import type { ApiRuntimeOptions } from "./runtime";

type RuntimeConfiguration = Pick<ApiRuntimeOptions, "database" | "migrations" | "listen" | "gatewayToken" | "adminBootstrap" | "publicAuthProxy">;

export function validateAdminBootstrapConfiguration(input: unknown): asserts input is NonNullable<ApiRuntimeOptions["adminBootstrap"]> {
  if (typeof input !== "object" || input === null
    || !("email" in input) || !("password" in input) || !("name" in input)
    || !browserSignInInputSchema.safeParse(input).success
    || typeof input.name !== "string" || !input.name.trim() || input.name.length > 80
    || typeof input.email !== "string" || input.email.includes("\0")
    || typeof input.password !== "string" || input.password.includes("\0")
    || input.name.includes("\0")) {
    throw new Error("Invalid API admin bootstrap configuration.");
  }
}

export function readRuntimeConfiguration(env: NodeJS.ProcessEnv): RuntimeConfiguration {
  function required(name: string, empty = false): string {
    const value = env[name];
    if (value === undefined || (!empty && !value) || value.includes("\0") || value.length > 4096) {
      throw new Error(`Invalid configuration: ${name}`);
    }
    return value;
  }
  function integer(name: string, min: number, max: number): number {
    const text = required(name);
    if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(`Invalid configuration: ${name}`);
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`Invalid configuration: ${name}`);
    }
    return value;
  }
  const host = required("MINT_API_DB_HOST");
  const port = integer("MINT_API_DB_PORT", 1, 65535);
  const database = required("MINT_API_DB_NAME");
  const user = required("MINT_API_DB_USER");
  const password = required("MINT_API_DB_PASSWORD", true);
  const tls = required("MINT_API_DB_TLS");
  if (tls !== "disabled" && tls !== "verify") throw new Error("Invalid configuration: MINT_API_DB_TLS");
  const max = integer("MINT_API_DB_POOL_MAX", 1, 100);
  const connectionTimeoutMillis = integer("MINT_API_DB_CONNECT_TIMEOUT_MS", 1, 2_147_483_647);
  const packagesRoot = required("MINT_API_MIGRATIONS_PACKAGES_ROOT");
  if (!isAbsolute(packagesRoot)) throw new Error("Invalid configuration: MINT_API_MIGRATIONS_PACKAGES_ROOT");
  const lockTimeoutMs = integer("MINT_API_MIGRATIONS_LOCK_TIMEOUT_MS", 1, 2_147_483_647);
  const listenHost = required("MINT_API_LISTEN_HOST");
  const listenPort = integer("MINT_API_LISTEN_PORT", 0, 65535);
  const gatewayToken = required("MINT_API_GATEWAY_TOKEN");
  if (!gatewayTokenSchema.safeParse(gatewayToken).success) throw new Error("Invalid configuration: MINT_API_GATEWAY_TOKEN");
  if (required("MINT_API_NOTIFICATION_SINK") !== "stdout") throw new Error("Invalid configuration: MINT_API_NOTIFICATION_SINK");
  let adminBootstrap: ApiRuntimeOptions["adminBootstrap"];
  const publicAuthProxy = env.MINT_API_PUBLIC_AUTH_PROXY;
  if (publicAuthProxy !== undefined && publicAuthProxy !== "gateway") {
    throw new Error("Invalid configuration: MINT_API_PUBLIC_AUTH_PROXY");
  }
  if (["MINT_API_BOOTSTRAP_ADMIN_EMAIL", "MINT_API_BOOTSTRAP_ADMIN_NAME", "MINT_API_BOOTSTRAP_ADMIN_PASSWORD"]
    .some((name) => env[name] !== undefined)) {
    adminBootstrap = {
      email: required("MINT_API_BOOTSTRAP_ADMIN_EMAIL"),
      name: required("MINT_API_BOOTSTRAP_ADMIN_NAME"),
      password: required("MINT_API_BOOTSTRAP_ADMIN_PASSWORD"),
    };
    validateAdminBootstrapConfiguration(adminBootstrap);
  }
  return {
    database: { host, port, database, user, password, ssl: tls === "verify" ? { rejectUnauthorized: true } : false, max, connectionTimeoutMillis },
    migrations: { packagesRoot, lockTimeoutMs },
    listen: { host: listenHost, port: listenPort },
    gatewayToken,
    ...(publicAuthProxy ? { publicAuthProxy } : {}),
    ...(adminBootstrap ? { adminBootstrap } : {}),
  };
}
