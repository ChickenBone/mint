import { signToken } from "@mint/core/crypto";
import { UUID, type PlaybackClaim } from "@mint/core/playback";
import { getSessionHash, getUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
const json = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "private, no-store" } });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return json("Approved membership required", 401);
  const { id } = await context.params;
  if (!UUID.test(id)) return json("Invalid track", 400);
  const sessionHash = await getSessionHash();
  if (!sessionHash) return json("Sign in required", 401);
  const requested = new URL(request.url).searchParams.get("format");
  if (requested && requested !== "mp3") return json("Unsupported compatibility format", 400);
  const token = signToken<PlaybackClaim>("playback", { userId: user.id, sessionHash, trackId: id,
    ...(requested === "mp3" ? { format: "mp3" as const } : {}) }, 30_000);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (request.headers.has("range")) headers.range = request.headers.get("range")!;
  let response: Response;
  try {
    response = await fetch(`${process.env.PLAYBACK_WORKER_URL ?? "http://worker:8080"}/playback/${id}`, {
      headers, cache: "no-store", signal: request.signal, redirect: "error", method: request.method,
    });
  } catch (error) {
    console.error("Playback worker unavailable", error instanceof Error ? error.message : "Network failure");
    return json("Playback worker unavailable; check the worker connection", 503);
  }
  const forwarded = new Headers({ "cache-control": "private, no-store" });
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = response.headers.get(name);
    if (value) forwarded.set(name, value);
  }
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: forwarded });
}

export const HEAD = GET;
