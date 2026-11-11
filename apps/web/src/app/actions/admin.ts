"use server";

import { CHANNEL, publish } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { setIssueReportStatus } from "@/lib/issue-reports";
import { enqueueRetry } from "@/lib/queues";
import { claimAdminFailedRetry, listAdminFailedJobs, removeAdminFailedJobs } from "@/lib/admin-failed-jobs";
import { withFailedPipelineCleanup } from "@/lib/failed-pipeline-jobs";

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
  const failed = await listAdminFailedJobs(db, 500);
  let retried = 0;
  for (const track of failed) {
    const trackId = await claimAdminFailedRetry(db, { trackId: track.id, failureVersion: track.failureVersion });
    if (!trackId) continue;
    await enqueueRetry(trackId);
    retried++;
  }
  revalidatePath("/app/manage");
  return { retried };
}

export async function removeFailedJob(trackId: string, failureVersion: string) {
  await requireAdmin();
  const result = await withFailedPipelineCleanup((cleanup) =>
    removeAdminFailedJobs(getDb(), cleanup, { trackId, failureVersion }));
  revalidatePath("/app/manage");
  return result;
}

export async function clearAllFailedJobs() {
  await requireAdmin();
  const result = await withFailedPipelineCleanup((cleanup) => removeAdminFailedJobs(getDb(), cleanup));
  revalidatePath("/app/manage");
  if (result.failed) {
    throw new Error(`Removed ${result.removed} failed attempts; ${result.failed} could not be removed and remain visible. ` +
      `Some matching worker records may already have been removed. Refresh and retry. ${result.failure}`);
  }
  return result;
}

export async function setIssueReportResolved(reportId: string, resolved: boolean) {
  const admin = await requireAdmin();
  id.parse(reportId);
  await setIssueReportStatus(getDb(), reportId, resolved ? "resolved" : "open", admin.id);
  revalidatePath("/app/manage");
}
