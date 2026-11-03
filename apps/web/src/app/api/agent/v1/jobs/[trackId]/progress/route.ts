import { LEASE_MS, applyTrackUpdate } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { agentError, authenticateAgent, limitWorker, parseBody } from "@/lib/agent";

const Body = z.object({
  leaseId: z.string().min(8).max(64),
  phase: z.enum(["downloading", "uploading"]),
  progress: z.number().min(0).max(1).nullable(),
  bytes: z.number().int().min(0).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const { trackId } = await params;
  const auth = await authenticateAgent(req);
  if ("response" in auth) return auth.response;
  const limited = await limitWorker(auth.worker, "progress", 120);
  if (limited) return limited;
  const body = await parseBody(req, Body);
  if (body instanceof NextResponse) return body;

  const t = schema.tracks;
  const db = getDb();
  // Extending the lease doubles as the ownership check.
  const [held] = await db
    .update(t)
    .set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(t.id, trackId), eq(t.leaseId, body.leaseId), eq(t.leaseWorkerId, auth.worker.id)))
    .returning({ id: t.id });
  if (!held) return agentError(409, "lease no longer held");

  const label = body.phase === "uploading" ? "Uploading from a volunteer worker" : "Downloading on a volunteer worker";
  await applyTrackUpdate(db, getRedis(), trackId, { progress: body.progress ?? 0, detail: label });
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
