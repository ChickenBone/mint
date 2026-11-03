import "server-only";
import { CHANNEL, publish, toWorkerView } from "@mint/core";
import type { Worker } from "@mint/core/schema";
import { WORKER_TOKEN_PREFIX, sha256 } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { rateLimit } from "./rate-limit";

export const MAX_WORKERS_PER_USER = 5;
export const MAX_WORKER_CONCURRENCY = 4;

export function hubUrl() {
  // Self-hosted: Caddy routes /ingest on the main domain to the hub.
  const url = process.env.HUB_URL || process.env.PUBLIC_URL;
  if (!url) throw new Error("HUB_URL is not set");
  return url.replace(/\/$/, "");
}

export const agentError = (status: number, error: string, headers?: Record<string, string>) =>
  NextResponse.json({ error }, { status, headers: { "cache-control": "no-store", ...headers } });

function requestIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

/** Resolves the bearer worker token. Returns the worker row, or a ready-to-send error response. */
export async function authenticateAgent(req: Request): Promise<{ worker: Worker; ip: string } | { response: NextResponse }> {
  const ip = requestIp(req);
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token?.startsWith(WORKER_TOKEN_PREFIX)) {
    return { response: agentError(401, "missing or malformed worker token") };
  }
  const [row] = await getDb()
    .select({ worker: schema.workers, ownerStatus: schema.users.status })
    .from(schema.workers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workers.userId))
    .where(eq(schema.workers.tokenHash, sha256(token)))
    .limit(1);
  if (!row) {
    // Only failed lookups count against the IP so busy hosts running several workers aren't throttled.
    if (!(await rateLimit(`agent-bad:${ip}`, 20, 60))) return { response: agentError(429, "too many bad tokens", { "retry-after": "60" }) };
    return { response: agentError(401, "unknown or revoked worker token") };
  }
  if (row.ownerStatus !== "active") return { response: agentError(403, "worker owner account is not active") };
  if (row.worker.status === "disabled") return { response: agentError(403, "worker disabled by an admin") };
  return { worker: row.worker, ip };
}

export async function limitWorker(worker: Worker, action: string, limit: number) {
  return (await rateLimit(`agent:${action}:${worker.id}`, limit, 60)) ? null : agentError(429, "slow down", { "retry-after": "30" });
}

export async function parseBody<T>(req: Request, schemaDef: z.ZodType<T>): Promise<T | NextResponse> {
  const body = await req.json().catch(() => undefined);
  const parsed = schemaDef.safeParse(body);
  return parsed.success ? parsed.data : agentError(400, parsed.error.issues[0]?.message ?? "invalid body");
}

export async function publishWorker(worker: Worker) {
  const view = toWorkerView(worker);
  const redis = getRedis();
  await Promise.all([
    publish(redis, CHANNEL.user(worker.userId), { type: "worker", data: view }),
    publish(redis, CHANNEL.admin, { type: "worker", data: view }),
  ]).catch(() => undefined);
}
