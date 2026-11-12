import { NextResponse } from "next/server";
import { z } from "zod";
import { MusicError } from "@mint/core/music";
import { getUser } from "@/lib/auth";
import { boundedJson, originAllowed, publicUrl, RequestInputError } from "@/lib/request";
import { validConsumerMutation } from "@/lib/native-context";
import { rateLimit } from "@/lib/rate-limit";
import { enqueueSearchRequestEnrichment } from "@/lib/queues";
import {
  cancelSearchRequest,
  createSearchRequest,
  failQueuedSearchRequest,
  getSearchRequest,
  listSearchRequests,
  retrySearchRequest,
} from "@/lib/music-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const mutationAllowed = (request: Request) =>
  validConsumerMutation(request, publicUrl()) || originAllowed(request.headers.get("origin"));

async function enqueue(userId: string, id: string) {
  try {
    await enqueueSearchRequestEnrichment(id);
  } catch {
    await failQueuedSearchRequest(userId, id);
    console.error("Search request enrichment could not be queued");
  }
}

export async function GET() {
  const user = await getUser();
  if (!user) return json({ error: "Approved membership required." }, 401);
  try {
    return json({ requests: await listSearchRequests(user.id) });
  } catch (error) {
    console.error("Search requests could not be loaded", error);
    return json({ error: "Search requests could not be loaded. Try again." }, 503);
  }
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return json({ error: "Approved membership required." }, 401);
  if (!mutationAllowed(request)) return json({ error: "Request origin not allowed." }, 403);
  if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "Send a JSON request." }, 400);
  if (!(await rateLimit(`search-request:${user.id}`, 30, 600))) return json({ error: "Too many search requests. Try again in ten minutes." }, 429);

  try {
    const input = z.union([
      z.object({ query: z.string().trim().min(2).max(100) }),
      z.object({ id: z.uuid(), action: z.enum(["retry", "cancel"]) }),
    ]).parse(await boundedJson(request, 15000));

    if ("query" in input) {
      const { request: saved } = await createSearchRequest(user.id, input.query);
      if (saved.enrichmentStatus === "queued") await enqueue(user.id, saved.id);
      return json({ request: (await getSearchRequest(user.id, saved.id)) ?? saved });
    }

    if (input.action === "cancel") {
      return json({ request: await cancelSearchRequest(user.id, input.id) });
    }

    const saved = await retrySearchRequest(user.id, input.id);
    await enqueue(user.id, saved.id);
    return json({ request: (await getSearchRequest(user.id, saved.id)) ?? saved });
  } catch (error) {
    if (error instanceof MusicError) return json({ error: error.message }, error.status);
    if (error instanceof RequestInputError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Invalid search request." }, 400);
    console.error("Search request could not be saved", error);
    return json({ error: "Search request could not be saved. Try again." }, 503);
  }
}
