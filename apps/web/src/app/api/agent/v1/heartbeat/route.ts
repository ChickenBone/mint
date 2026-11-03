import { AGENT_PROTOCOL_VERSION, type HeartbeatResponse } from "@mint/core";
import { getDb, schema } from "@mint/core/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { MAX_WORKER_CONCURRENCY, agentError, authenticateAgent, limitWorker, parseBody, publishWorker } from "@/lib/agent";

const Body = z.object({
  version: z.string().max(40),
  protocol: z.number().int(),
  activeJobs: z.number().int().min(0).max(64),
  capabilities: z.object({ cobalt: z.boolean(), concurrency: z.number().int().min(1).max(16) }),
});

export async function POST(req: Request) {
  const auth = await authenticateAgent(req);
  if ("response" in auth) return auth.response;
  const limited = await limitWorker(auth.worker, "heartbeat", 12);
  if (limited) return limited;
  const body = await parseBody(req, Body);
  if (body instanceof NextResponse) return body;
  if (body.protocol !== AGENT_PROTOCOL_VERSION) {
    return agentError(426, `protocol ${body.protocol} is not supported; pull the latest mint-agent image`);
  }

  const [worker] = await getDb()
    .update(schema.workers)
    .set({
      lastSeenAt: new Date(),
      lastIp: auth.ip,
      version: body.version,
      activeJobs: body.activeJobs,
      capabilities: { ...body.capabilities, concurrency: Math.min(body.capabilities.concurrency, MAX_WORKER_CONCURRENCY) },
    })
    .where(eq(schema.workers.id, auth.worker.id))
    .returning();
  if (worker) await publishWorker(worker);

  const res: HeartbeatResponse = {
    worker: { id: auth.worker.id, name: auth.worker.name, status: auth.worker.status },
    pollMs: 15_000,
    heartbeatMs: 30_000,
  };
  return NextResponse.json(res, { headers: { "cache-control": "no-store" } });
}
