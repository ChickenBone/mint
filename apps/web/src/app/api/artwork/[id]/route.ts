import { signToken } from "@mint/core/crypto";
import { UUID } from "@mint/core/playback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const unavailable = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID.test(id)) return unavailable(400);
  try {
    const token = signToken("artwork", { trackId: id }, 30_000);
    const response = await fetch(`${process.env.PLAYBACK_WORKER_URL ?? "http://worker:8080"}/artwork/${id}`, {
      headers: { authorization: `Bearer ${token}` }, redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]), method: request.method,
    });
    if (!response.ok) { await response.body?.cancel(); return unavailable(response.status === 404 ? 404 : 503); }
    const type = response.headers.get("content-type");
    if (!type || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)) {
      await response.body?.cancel();
      console.error("Artwork worker returned an unsupported image type");
      return unavailable(502);
    }
    const headers = new Headers({ "content-type": type, "x-content-type-options": "nosniff" });
    for (const name of ["content-length", "cache-control", "etag"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (request.headers.get("if-none-match") === headers.get("etag") && headers.has("etag")) {
      await response.body?.cancel();
      headers.delete("content-length");
      return new Response(null, { status: 304, headers });
    }
    return new Response(request.method === "HEAD" ? null : response.body, { headers });
  } catch (error) {
    if (!request.signal.aborted) console.error("Artwork worker unavailable", error instanceof Error ? error.name : "Network failure");
    return unavailable(503);
  }
}

export const HEAD = GET;
