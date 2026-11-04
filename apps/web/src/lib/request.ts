import { headers } from "next/headers";

/** Client IP as seen by the reverse proxy (Caddy sets X-Forwarded-For; only trust the first hop). */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

export async function userAgent(): Promise<string | null> {
  return (await headers()).get("user-agent");
}

export function publicUrl() {
  return (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export class RequestInputError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function boundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestInputError("Send a JSON request.", 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new RequestInputError(`Request exceeds the ${maxBytes}-byte limit.`, 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
