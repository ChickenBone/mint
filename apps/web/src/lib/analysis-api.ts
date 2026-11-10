import { getUser } from "./auth";
import { mutationOriginAllowed } from "./request";

export const analysisJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "private, no-store" } });

export async function analysisAdmin(request?: Request) {
  const user = await getUser();
  if (!user) return { error: analysisJson({ error: "Approved membership required" }, 401) } as const;
  if (user.role !== "admin") return { error: analysisJson({ error: "Administrator access required" }, 403) } as const;
  if (request) {
    if (!mutationOriginAllowed(request)) {
      return { error: analysisJson({ error: "Cross-origin changes are not allowed" }, 403) } as const;
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return { error: analysisJson({ error: "JSON content required" }, 415) } as const;
    }
  }
  return { user } as const;
}

export async function analysisBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing JSON body");
  let bytes = 0, text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) { await reader.cancel(); throw new Error("Request too large"); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally { reader.releaseLock(); }
}
