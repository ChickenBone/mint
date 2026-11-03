import { applyTrackUpdate } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { getRedis } from "@mint/core/redis";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { agentError, authenticateAgent, limitWorker, parseBody, publishWorker } from "@/lib/agent";

const MAX_REMOTE_FAILURES = 3;
const Body = z.object({
  leaseId: z.string().min(8).max(64),
  error: z.string().max(500),
  release: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const { trackId } = await params;
  const auth = await authenticateAgent(req);
  if ("response" in auth) return auth.response;
  const limited = await limitWorker(auth.worker, "fail", 60);
  if (limited) return limited;
  const body = await parseBody(req, Body);
  if (body instanceof NextResponse) return body;

  const db = getDb();
  const t = schema.tracks;
  const released = { leaseId: null, leaseWorkerId: null, leaseExpiresAt: null, progress: 0 };
  const [row] = await db
    .update(t)
    .set(body.release ? released : { ...released, remoteFailures: sql`${t.remoteFailures} + 1` })
    .where(and(eq(t.id, trackId), eq(t.leaseId, body.leaseId), eq(t.leaseWorkerId, auth.worker.id)))
    .returning();
  if (!row) return agentError(409, "lease no longer held");

  const redis = getRedis();
  if (body.release) {
    await applyTrackUpdate(db, redis, trackId, { detail: "Waiting for a volunteer worker" });
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  }

  const [worker] = await db
    .update(schema.workers)
    .set({ failed: sql`${schema.workers.failed} + 1` })
    .where(eq(schema.workers.id, auth.worker.id))
    .returning();
  if (worker) await publishWorker(worker);

  const reason = body.error.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
  if (row.remoteFailures >= MAX_REMOTE_FAILURES) {
    await applyTrackUpdate(db, redis, trackId, { stage: "failed", remoteAt: null, error: reason, detail: "Volunteer workers could not download it" }, reason);
  } else {
    await applyTrackUpdate(db, redis, trackId, { detail: `Worker hit an error, back in the pool (${row.remoteFailures}/${MAX_REMOTE_FAILURES})` });
  }
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
