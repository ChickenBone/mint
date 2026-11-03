import { cookies } from "next/headers";
import { SESSION_COOKIE, sha256, signToken } from "@mint/core/crypto";
import { UUID, type PlaybackClaim } from "@mint/core/playback";
import { getUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "private, no-store" } });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return json("Approved membership required", 401);
  const { id } = await context.params;
  if (!UUID.test(id)) return json("Invalid track", 400);
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) return json("Sign in required", 401);
  const token = signToken<PlaybackClaim>("playback", { userId: user.id, sessionHash: sha256(session), trackId: id }, 30_000);
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
