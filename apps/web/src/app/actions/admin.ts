"use server";

import { CHANNEL, publish } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { enqueueRetry } from "@/lib/queues";

const id = z.uuid();

export async function decideRequest(userId: string, approve: boolean) {
  const admin = await requireAdmin();
  id.parse(userId);
  const db = getDb();
  await db
    .update(schema.users)
    .set(approve ? { status: "active", approvedAt: new Date(), approvedBy: admin.id } : { status: "denied" })
    .where(and(eq(schema.users.id, userId), eq(schema.users.status, "pending")));
  const pending = await db.$count(schema.users, eq(schema.users.status, "pending"));
  await publish(getRedis(), CHANNEL.admin, { type: "access-request", data: { pending } });
  revalidatePath("/app/admin");
}

export async function setMemberStatus(userId: string, status: "active" | "disabled") {
  const admin = await requireAdmin();
  id.parse(userId);
  if (userId === admin.id) throw new Error("You can't disable your own account.");
  const db = getDb();
  await db.update(schema.users).set({ status }).where(and(eq(schema.users.id, userId), ne(schema.users.status, "pending")));
  if (status === "disabled") await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
  revalidatePath("/app/admin");
}

export async function setMemberRole(userId: string, role: "user" | "admin") {
  const admin = await requireAdmin();
  id.parse(userId);
  if (userId === admin.id) throw new Error("You can't change your own role.");
  await getDb().update(schema.users).set({ role }).where(eq(schema.users.id, userId));
  revalidatePath("/app/admin");
}

export async function retryAllFailed() {
  await requireAdmin();
  const db = getDb();
  const failed = await db.select({ id: schema.tracks.id }).from(schema.tracks).where(eq(schema.tracks.stage, "failed")).limit(500);
  for (const t of failed) {
    await db.update(schema.tracks).set({ stage: "queued", progress: 0, error: null, detail: "Retrying" }).where(eq(schema.tracks.id, t.id));
    await enqueueRetry(t.id);
  }
  revalidatePath("/app/admin");
  return { retried: failed.length };
}
