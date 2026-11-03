"use server";

import { toWorkerView } from "@mint/core";
import { newWorkerToken } from "@mint/core/crypto";
import { getDb, schema } from "@mint/core/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MAX_WORKERS_PER_USER, publishWorker } from "@/lib/agent";
import { requireAdmin, requireUser } from "@/lib/auth";

export type CreateWorkerState = { error?: string; token?: string; name?: string; status?: "pending" | "active" } | undefined;

const Name = z
  .string()
  .trim()
  .min(2, "Give it a name of at least 2 characters.")
  .max(40, "Keep the name under 40 characters.")
  .regex(/^[\w .'-]+$/u, "Use letters, numbers, spaces, dots, dashes or underscores.");

const releaseLeases = (workerId: string) =>
  getDb()
    .update(schema.tracks)
    .set({ leaseId: null, leaseWorkerId: null, leaseExpiresAt: null, detail: "Waiting for a volunteer worker", progress: 0 })
    .where(eq(schema.tracks.leaseWorkerId, workerId));

export async function createWorker(_prev: CreateWorkerState, form: FormData): Promise<CreateWorkerState> {
  const user = await requireUser();
  const parsed = Name.safeParse(form.get("name"));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const db = getDb();
  if (user.role !== "admin") {
    const count = await db.$count(schema.workers, eq(schema.workers.userId, user.id));
    if (count >= MAX_WORKERS_PER_USER) return { error: `You can register up to ${MAX_WORKERS_PER_USER} workers. Revoke one first.` };
  }

  const autoApprove = user.role === "admin" || process.env.WORKER_AUTO_APPROVE === "true";
  const { token, hash, hint } = newWorkerToken();
  const [worker] = await db
    .insert(schema.workers)
    .values({
      userId: user.id,
      name: parsed.data,
      tokenHash: hash,
      tokenHint: hint,
      status: autoApprove ? "active" : "pending",
      approvedAt: autoApprove ? new Date() : null,
    })
    .returning();
  if (worker) await publishWorker(worker);
  revalidatePath("/app/workers");
  return { token, name: parsed.data, status: autoApprove ? "active" : "pending" };
}

export async function revokeWorker(workerId: string) {
  const user = await requireUser();
  z.uuid().parse(workerId);
  const db = getDb();
  const scope = user.role === "admin" ? eq(schema.workers.id, workerId) : and(eq(schema.workers.id, workerId), eq(schema.workers.userId, user.id));
  const [gone] = await db.delete(schema.workers).where(scope).returning();
  if (!gone) throw new Error("That worker no longer exists.");
  await releaseLeases(workerId);
  await publishWorker({ ...gone, status: "disabled", lastSeenAt: null });
  revalidatePath("/app/workers");
  revalidatePath("/app/admin");
}

export async function setWorkerStatus(workerId: string, status: "active" | "disabled") {
  await requireAdmin();
  z.uuid().parse(workerId);
  const [worker] = await getDb()
    .update(schema.workers)
    .set(status === "active" ? { status, approvedAt: new Date() } : { status })
    .where(eq(schema.workers.id, workerId))
    .returning();
  if (!worker) throw new Error("That worker no longer exists.");
  if (status === "disabled") await releaseLeases(workerId);
  await publishWorker(worker);
  revalidatePath("/app/admin");
  revalidatePath("/app/workers");
  return toWorkerView(worker);
}
