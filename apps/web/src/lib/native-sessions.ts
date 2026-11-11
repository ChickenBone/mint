import "server-only";
import { nativeBearer, nativeTokenSchema } from "@mint/client/auth";
import { randomToken, SESSION_TTL_MS, sha256 } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { connectedDevices } from "@mint/core/devices-db";
import { NATIVE_DEVICE_RETENTION_MS } from "@mint/core/devices";
import { and, eq, gt, gte, isNull, like, sql } from "drizzle-orm";

export async function createNativeSession(userId: string, deviceId: string, deviceName: string, ip: string) {
  const token = nativeTokenSchema.parse(`mn1.${deviceId}.${randomToken()}`);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${deviceId}`}, 918))`);
    await tx.delete(schema.sessions).where(and(eq(schema.sessions.userId, userId),
      like(schema.sessions.userAgent, `native:${deviceId}:%`)));
    await tx.insert(schema.sessions).values({
      id: sha256(token), userId, expiresAt, ip, userAgent: `native:${deviceId}:${deviceName}`,
    });
  });
  return { token, deviceId, expiresAt: expiresAt.toISOString() };
}

export async function resolveNativeSession(request: Request) {
  const token = nativeBearer(request.headers);
  if (!token) return null;
  const deviceId = token.split(".")[1]!;
  const sessionHash = sha256(token);
  const [row] = await getDb().select({
    id: schema.users.id, email: schema.users.email, name: schema.users.name,
    status: schema.users.status, expiresAt: schema.sessions.expiresAt, userAgent: schema.sessions.userAgent,
  }).from(schema.sessions).innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(and(eq(schema.sessions.id, sessionHash), gt(schema.sessions.expiresAt, new Date()),
      like(schema.sessions.userAgent, `native:${deviceId}:%`))).limit(1);
  if (!row || row.status !== "active") return null;
  await getDb().update(connectedDevices).set({ lastConnectedAt: new Date() })
    .where(and(eq(connectedDevices.userId, row.id), eq(connectedDevices.installationId, deviceId),
      isNull(connectedDevices.revokedAt), gte(connectedDevices.lastConnectedAt, new Date(Date.now() - NATIVE_DEVICE_RETENTION_MS))));
  return {
    user: { id: row.id, name: row.name, email: row.email, role: "user" as const, status: "active" as const },
    deviceId, deviceName: row.userAgent?.split(":").slice(2).join(":") || "Mint app",
    sessionHash, expiresAt: row.expiresAt.toISOString(),
  };
}

export async function revokeNativeSession(request: Request) {
  const token = nativeBearer(request.headers);
  if (token) await getDb().delete(schema.sessions).where(eq(schema.sessions.id, sha256(token)));
}
