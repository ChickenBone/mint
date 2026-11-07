import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/auth";
import { boundedJson, originAllowed, publicUrl, RequestInputError } from "@/lib/request";
import { MusicError } from "@mint/core/music";
import { searchRecordings, requestRecording, type RecordingSearchResponse } from "@/lib/music-requests";
import { NeedsVideoError, resolveAndRequest } from "@/lib/resolve-request";
import { rateLimit } from "@/lib/rate-limit";
import { enqueueRequested } from "@/lib/queues";
import { validConsumerMutation } from "@/lib/native-context";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const mutationAllowed = (request: Request) => validConsumerMutation(request, publicUrl()) || originAllowed(request.headers.get("origin"));
async function handle(request: Request) {
  const user = await getUser();
  if (!user) return json({ error: "Approved membership required." }, 401);
  try {
    if (request.method === "GET") {
      const q = z.string().trim().min(2).max(100).parse(new URL(request.url).searchParams.get("q"));
      if (!(await rateLimit(`recordings:${user.id}`, 20, 60)) || !(await rateLimit("recording-catalog", 1, 1))) return json({ error: "Wait a second before searching the recording catalog again." }, 429);
      return json({ items: await searchRecordings(user.id, q, fetch, undefined, { signal: request.signal }) } satisfies RecordingSearchResponse);
    }
    if (!mutationAllowed(request)) return json({ error: "Request origin not allowed." }, 403);
    if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "Send a JSON request." }, 400);
    if (!(await rateLimit(`music-request:${user.id}`, 30, 600))) return json({ error: "Too many song requests. Try again in ten minutes." }, 429);
    const input = z.union([
      z.object({ token: z.string().min(1).max(10_000), youtubeUrl: z.string().max(2048).optional() }),
      z.object({ query: z.string().trim().min(2).max(100), youtubeUrl: z.string().max(2048).optional() }),
    ]).parse(await boundedJson(request, 15000));
    if ("query" in input && (!(await rateLimit(`recordings:${user.id}`, 20, 60)) || !(await rateLimit("recording-catalog", 1, 1)))) return json({ error: "Wait a second before searching the recording catalog again." }, 429);
    const result = "query" in input
      ? await resolveAndRequest(user.id, input.query, input.youtubeUrl)
      : await requestRecording(user.id, input.token, input.youtubeUrl);
    if (result.needsQueue) await enqueueRequested(result.trackId, user.id);
    return json(result);
  } catch (error) {
    if (request.method === "GET" && request.signal.aborted) return json({ error: "Search cancelled." }, 499);
    if (error instanceof NeedsVideoError) return json({ error: error.message, needsVideo: true }, error.status);
    if (error instanceof MusicError) return json({ error: error.message }, error.status);
    if (error instanceof RequestInputError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Invalid request or recording catalog response." }, 400);
    console.error("Music request failed", error); return json({ error: "The music request could not finish. Check Jobs and retry; completed files remain untouched." }, 503);
  }
}
export { handle as GET, handle as POST };
