import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@mint/core/db";
import { MusicError } from "@mint/core/music";
import { getUser } from "@/lib/auth";
import { boundedJson, publicUrl, RequestInputError } from "@/lib/request";
import { openQueue, queuePage, editQueue } from "@/lib/playback-queue-store";
import { queueEditSchema, queueOpenSchema } from "@/lib/progressive-queue";
import { rateLimit } from "@/lib/rate-limit";
import { validConsumerMutation } from "@/lib/native-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
async function handle(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const user = await getUser();
  if (!user) return json({ error: "Approved membership required." }, 401);
  try {
    const path = (await context.params).path ?? [], id = path[0];
    if (request.method === "GET" && id && path.length === 1) {
      const queueId = z.uuid().parse(id), position = z.coerce.number().int().min(0).max(2_000_000_000).parse(new URL(request.url).searchParams.get("position") ?? 0);
      return json(await getDb().transaction((tx) => queuePage(tx, user.id, queueId, position), { isolationLevel: "repeatable read" }));
    }
    if (request.method !== "POST" || !validConsumerMutation(request, publicUrl())) return json({ error: "Request origin not allowed." }, 403);
    if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "Send a JSON request." }, 400);
    const body = await boundedJson(request, 300_000);
    if (!id) {
      if (!(await rateLimit(`listening-queue:${user.id}`, 30, 60))) return json({ error: "Too many new queues. Wait a minute before choosing another collection." }, 429);
      return json(await openQueue(user.id, queueOpenSchema.parse(body)));
    }
    if (path.length !== 1) return json({ error: "Queue route not found." }, 404);
    const input = z.object({ revision: z.number().int().positive(), currentId: z.uuid(), edit: queueEditSchema }).parse(body);
    return json(await editQueue(user.id, z.uuid().parse(id), input.revision, input.currentId, input.edit));
  } catch (error) {
    if (error instanceof MusicError) return json({ error: error.message }, error.status);
    if (error instanceof RequestInputError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Invalid listening queue request." }, 400);
    console.error("Listening queue failed", error);
    return json({ error: "The listening queue could not load. Check the server and try again." }, 503);
  }
}
export { handle as GET, handle as POST };
